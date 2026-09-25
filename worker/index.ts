import { DurableObject } from 'cloudflare:workers';

type Role = 'sender' | 'receiver';
type SocketAttachment = { kind: 'pending'; expiresAt: number } | { kind: 'peer'; role: Role };
type RoomState =
  | { kind: 'empty' }
  | { kind: 'waiting'; receiverTokenHash: string; expiresAt: number }
  | { kind: 'paired'; receiverTokenHash: string; expiresAt: number }
  | { kind: 'terminal'; expiresAt: number };
type SenderJoin = { type: 'join'; protocol: 'cd-transfer-v1'; role: 'sender'; receiverTokenHash: string };
type ReceiverJoin = { type: 'join'; protocol: 'cd-transfer-v1'; role: 'receiver'; receiverToken: string };
type Join = SenderJoin | ReceiverJoin;
type PeerAttachment = { id: string; peers: string[]; messages: number };

const MAX_JOIN_BYTES = 512;
const MAX_RECORD_BYTES = 80 * 1024;
// 8 MiB peer buffer: absorbs phone-disk stalls without tripping the
// abort-cliff on big files. Still a hard kill past this (no resume in v1),
// but 4x rarer than the old 2 MiB cliff.
const MAX_PEER_BUFFER_BYTES = 8 * 1024 * 1024;
const JOIN_TIMEOUT_MS = 10 * 1000;
const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
const TOMBSTONE_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_SIGNAL_MESSAGES = 512;

function isPeerID(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isPeerAttachment(value: unknown): value is PeerAttachment {
  return !!value && typeof value === 'object'
    && 'id' in value && isPeerID(value.id)
    && 'peers' in value && Array.isArray(value.peers) && value.peers.every(isPeerID)
    && 'messages' in value && typeof value.messages === 'number' && Number.isSafeInteger(value.messages) && value.messages >= 0;
}

function isBase64Url32(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind === 'pending') return 'expiresAt' in value && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt);
  return value.kind === 'peer' && 'role' in value && (value.role === 'sender' || value.role === 'receiver');
}

function parseJoin(message: string): Join | null {
  if (new TextEncoder().encode(message).byteLength > MAX_JOIN_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(message); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (!('type' in value) || !('protocol' in value) || !('role' in value)) return null;
  if (value.type !== 'join' || value.protocol !== 'cd-transfer-v1') return null;
  if (value.role === 'sender' && 'receiverTokenHash' in value && isBase64Url32(value.receiverTokenHash) && !('receiverToken' in value)) {
    return { type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: value.receiverTokenHash };
  }
  if (value.role === 'receiver' && 'receiverToken' in value && isBase64Url32(value.receiverToken) && !('receiverTokenHash' in value)) {
    return { type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: value.receiverToken };
  }
  return null;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
  return decoded;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hashToken(encodedToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', decodeBase64Url(encodedToken));
  return encodeBase64Url(new Uint8Array(digest));
}

function equalTokenHashes(left: string, right: string): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = decodeBase64Url(left);
    rightBytes = decodeBase64Url(right);
  } catch {
    return false;
  }
  if (leftBytes.byteLength !== 32 || rightBytes.byteLength !== 32) return false;
  const subtle = crypto.subtle;
  return 'timingSafeEqual' in subtle && typeof subtle.timingSafeEqual === 'function'
    && subtle.timingSafeEqual(leftBytes, rightBytes);
}

function relayEvent(type: 'accepted' | 'peer-joined' | 'peer-left', extra: Record<string, string> = {}): string {
  return JSON.stringify({ type, protocol: 'cd-transfer-v1', ...extra });
}

function logEvent(event: string, detail: Record<string, string | number> = {}): void {
  console.info(JSON.stringify({ event, ...detail }));
}

function reject(socket: WebSocket, code: number, reason: string): void {
  logEvent('connection_rejected', { code, reason });
  socket.close(code, reason);
}

export class TransferRoom extends DurableObject<Env> {
  private room: RoomState = { kind: 'empty' };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get<RoomState>('room') ?? { kind: 'empty' };
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 4) return new Response('room connection limit reached', { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const expiresAt = Date.now() + JOIN_TIMEOUT_MS;
    server.serializeAttachment({ kind: 'pending', expiresAt } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) await this.ctx.storage.setAlarm(expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment)) { reject(socket, 4400, 'invalid connection'); return; }
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    if (attachment.kind === 'pending') {
      if (attachment.expiresAt <= Date.now()) { reject(socket, 4408, 'join expired'); return; }
      if (typeof message !== 'string') { reject(socket, 4400, 'join required'); return; }
      const join = parseJoin(message);
      if (!join) { reject(socket, 4406, 'invalid protocol join'); return; }
      await this.admit(socket, join);
      return;
    }
    if (this.room.kind !== 'paired') { reject(socket, 4400, 'room is not paired'); return; }
    if (typeof message === 'string' || message.byteLength > MAX_RECORD_BYTES) { reject(socket, 4403, 'invalid relay frame'); return; }
    const peer = this.peer(attachment.role === 'sender' ? 'receiver' : 'sender');
    if (!peer) { reject(socket, 4404, 'peer unavailable'); return; }
    if (peer.bufferedAmount + message.byteLength > MAX_PEER_BUFFER_BYTES) {
      logEvent('backpressure_limit', { bufferedBytes: peer.bufferedAmount });
      reject(socket, 4429, 'peer is too slow');
      reject(peer, 4429, 'peer is too slow');
      await this.finishRoom();
      return;
    }
    try {
      peer.send(message);
    } catch {
      reject(socket, 1011, 'relay send failed');
      reject(peer, 1011, 'relay send failed');
      await this.finishRoom();
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment) || attachment.kind !== 'peer') return;
    const peer = this.peer(attachment.role === 'sender' ? 'receiver' : 'sender');
    if (peer) {
      try { peer.send(relayEvent('peer-left', { reason: reason || String(code) })); } catch { /* Best effort during teardown. */ }
      try { peer.close(4404, 'peer left'); } catch { /* Best effort during teardown. */ }
    }
    await this.finishRoom();
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket, 1011, 'socket error'); }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (!isSocketAttachment(attachment)) reject(socket, 4408, 'join expired');
      else if (attachment.kind === 'pending' && attachment.expiresAt <= now) reject(socket, 4408, 'join expired');
    }
    if (this.room.kind === 'terminal') {
      if (this.room.expiresAt <= now) {
        for (const socket of this.ctx.getWebSockets()) socket.close(4408, 'room reset');
        await this.ctx.storage.delete('room');
        this.room = { kind: 'empty' };
        logEvent('room_reset');
      }
      await this.scheduleAlarm();
      return;
    }
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    await this.scheduleAlarm();
  }

  private async admit(socket: WebSocket, join: Join): Promise<void> {
    if (join.role === 'sender') {
      if (this.room.kind !== 'empty') { reject(socket, 4409, 'sender unavailable'); return; }
      const expiresAt = Date.now() + ROOM_LIFETIME_MS;
      const nextRoom = { kind: 'waiting', receiverTokenHash: join.receiverTokenHash, expiresAt } satisfies RoomState;
      socket.serializeAttachment({ kind: 'peer', role: 'sender' } satisfies SocketAttachment);
      await this.ctx.storage.put('room', nextRoom);
      this.room = nextRoom;
      await this.scheduleAlarm();
      logEvent('sender_admitted');
      try {
        socket.send(relayEvent('accepted'));
      } catch {
        reject(socket, 1011, 'relay send failed');
        await this.finishRoom();
      }
      return;
    }
    if (this.room.kind !== 'waiting' || this.peer('receiver')) {
      reject(socket, this.room.kind === 'empty' ? 4404 : 4409, this.room.kind === 'empty' ? 'sender unavailable' : 'receiver unavailable');
      return;
    }
    const suppliedHash = await hashToken(join.receiverToken);
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    if (this.room.kind !== 'waiting' || !equalTokenHashes(suppliedHash, this.room.receiverTokenHash)) { reject(socket, 4401, 'receiver unauthorized'); return; }
    const sender = this.peer('sender');
    if (!sender) { reject(socket, 4404, 'sender unavailable'); return; }
    socket.serializeAttachment({ kind: 'peer', role: 'receiver' } satisfies SocketAttachment);
    const nextRoom = { ...this.room, kind: 'paired' } satisfies RoomState;
    await this.ctx.storage.put('room', nextRoom);
    this.room = nextRoom;
    logEvent('room_paired');
    await this.scheduleAlarm();
    try {
      socket.send(relayEvent('accepted'));
      socket.send(relayEvent('peer-joined'));
      sender.send(relayEvent('peer-joined'));
    } catch {
      reject(socket, 1011, 'relay send failed');
      reject(sender, 1011, 'relay send failed');
      await this.finishRoom();
    }
  }

  private peer(role: Role): WebSocket | null {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment: unknown = socket.deserializeAttachment();
      return socket.readyState === WebSocket.OPEN && isSocketAttachment(attachment) && attachment.kind === 'peer' && attachment.role === role;
    }) ?? null;
  }

  private isExpired(): boolean {
    return (this.room.kind === 'waiting' || this.room.kind === 'paired') && this.room.expiresAt <= Date.now();
  }

  private async expireRoom(): Promise<void> {
    logEvent('room_expired');
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.close(4408, 'room expired');
    }
    await this.finishRoom();
  }

  private async finishRoom(): Promise<void> {
    if (this.room.kind === 'empty' || this.room.kind === 'terminal') return;
    const nextRoom = { kind: 'terminal', expiresAt: Date.now() + TOMBSTONE_MS } satisfies RoomState;
    await this.ctx.storage.put('room', nextRoom);
    this.room = nextRoom;
    logEvent('room_terminal');
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const deadlines: number[] = [];
    if (this.room.kind !== 'empty') deadlines.push(this.room.expiresAt);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (isSocketAttachment(attachment) && attachment.kind === 'pending' && socket.readyState === WebSocket.OPEN) deadlines.push(attachment.expiresAt);
    }
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }
}

export class PeerSignal extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/deliver' && request.method === 'POST') {
      const body = await request.text();
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      if (bodyBytes > MAX_SIGNAL_BYTES) return new Response('too large', { status: 413 });
      const socket = this.ctx.getWebSockets().find((peer) => peer.readyState === WebSocket.OPEN && isPeerAttachment(peer.deserializeAttachment()));
      if (!socket) return new Response('peer unavailable', { status: 404 });
      if (socket.bufferedAmount + bodyBytes > MAX_PEER_BUFFER_BYTES) {
        socket.close(4429, 'peer is too slow');
        return new Response('peer is too slow', { status: 429 });
      }
      try { socket.send(body); } catch { return new Response('peer unavailable', { status: 404 }); }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    const id = request.headers.get('X-CD-Peer-ID');
    if (!isPeerID(id)) return new Response('invalid peer id', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().some((socket) => socket !== server && socket.readyState === WebSocket.OPEN)) {
      server.send(JSON.stringify({ type: 'ID-TAKEN' }));
      server.close(4409, 'peer id taken');
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ id, peers: [], messages: 0 } satisfies PeerAttachment);
    server.send(JSON.stringify({ type: 'OPEN' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isPeerAttachment(attachment) || typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) {
      socket.close(4400, 'invalid signal');
      return;
    }
    let value: unknown;
    try { value = JSON.parse(message); } catch { socket.close(4400, 'invalid signal'); return; }
    if (!value || typeof value !== 'object' || !('type' in value)) { socket.close(4400, 'invalid signal'); return; }
    if (value.type === 'HEARTBEAT') return;
    if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE'].includes(String(value.type)) || !('dst' in value) || !isPeerID(value.dst)) {
      socket.close(4400, 'invalid signal');
      return;
    }
    attachment.messages += 1;
    if (attachment.messages > MAX_SIGNAL_MESSAGES) { socket.close(4429, 'signal limit reached'); return; }
    if (!attachment.peers.includes(value.dst)) attachment.peers = [...attachment.peers.slice(-7), value.dst];
    socket.serializeAttachment(attachment);
    const target = value.dst;
    try {
      const delivered = await this.env.PEERS.getByName(target).fetch('https://peer.internal/deliver', {
        method: 'POST', body: JSON.stringify({ ...value, src: attachment.id }),
      });
      if (!delivered.ok) socket.send(JSON.stringify({ type: 'EXPIRE', src: target }));
    } catch {
      socket.send(JSON.stringify({ type: 'EXPIRE', src: target }));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isPeerAttachment(attachment)) return;
    await Promise.all(attachment.peers.map(async (peer) => {
      try {
        await this.env.PEERS.getByName(peer).fetch('https://peer.internal/deliver', {
          method: 'POST', body: JSON.stringify({ type: 'LEAVE', src: attachment.id }),
        });
      } catch { /* Peer cleanup is best effort. */ }
    }));
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }
}

// Short numeric share codes ("48291") map to a transfer capability
// (transfer ID + master key) so a 5-digit code typed anywhere — terminal or
// browser — resolves to the same relay room. Codes are random, one batch per
// room, expire after 15 minutes, and admit a single receiver through the
// room's existing tombstone. Unlike full-link mode, the directory holds the
// master key, so short-code transfers are NOT end-to-end encrypted: TLS
// protects them in transit and the relay forwards (but never stores) the
// bytes. Sensitive files should use a full link instead.
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_DIGITS = 5;
const CODE_SPACE = 100_000;
const CODE_CLAIM_ATTEMPTS = 12;
const MAX_CODES = 10_000;
const MAX_CODE_BODY_BYTES = 256;

type CodeEntry = { transferId: string; key: string; expiresAt: number };

function isTransferId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

function isMasterKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isShareCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4,5}$/.test(value);
}

export class CodeDirectory extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/claim') {
      return this.claim(request);
    }
    const lookup = /^\/code\/(\d{4,5})$/.exec(url.pathname);
    if (request.method === 'GET' && lookup) {
      return this.lookup(lookup[1]);
    }
    return new Response('not found', { status: 404 });
  }

  private async claim(request: Request): Promise<Response> {
    let body: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_CODE_BODY_BYTES) {
        return new Response('too large', { status: 413 });
      }
      body = JSON.parse(text);
    } catch {
      return new Response('invalid claim', { status: 400 });
    }
    if (!body || typeof body !== 'object' || !('transferId' in body) || !('key' in body)) {
      return new Response('invalid claim', { status: 400 });
    }
    const { transferId, key } = body as Record<string, unknown>;
    if (!isTransferId(transferId) || !isMasterKey(key)) {
      return new Response('invalid claim', { status: 400 });
    }
    const expiresAt = Date.now() + CODE_TTL_MS;
    const entry: CodeEntry = { transferId, key, expiresAt };
    // Bound the directory: purge expired codes, then refuse when still full.
    const stored = await this.ctx.storage.list<CodeEntry>({ prefix: 'code:' });
    let live = 0;
    for (const [storageKey, existing] of stored) {
      if (!existing || existing.expiresAt <= Date.now()) {
        await this.ctx.storage.delete(storageKey);
      } else {
        live += 1;
      }
    }
    if (live >= MAX_CODES) {
      logEvent('code_directory_full', { codes: live });
      return new Response('share codes are busy right now', { status: 503 });
    }
    // Allocation retries inside a transaction so two simultaneous senders can
    // never own the same code.
    for (let attempt = 0; attempt < CODE_CLAIM_ATTEMPTS; attempt += 1) {
      const digits = new Uint32Array(1);
      crypto.getRandomValues(digits);
      const code = String(digits[0] % CODE_SPACE).padStart(CODE_DIGITS, '0');
      const owned = await this.ctx.storage.transaction(async (txn) => {
        const existing = await txn.get<CodeEntry>(`code:${code}`);
        if (existing && existing.expiresAt > Date.now()) return false;
        await txn.put<CodeEntry>(`code:${code}`, entry);
        return true;
      });
      if (owned) {
        logEvent('code_claimed', { code });
        return Response.json({ code, expiresAt });
      }
    }
    logEvent('code_space_exhausted');
    return new Response('share codes are busy right now', { status: 503 });
  }

  private async lookup(code: string): Promise<Response> {
    const entry = await this.ctx.storage.get<CodeEntry>(`code:${code}`);
    if (!entry) return new Response('code unavailable', { status: 404 });
    if (entry.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(`code:${code}`);
      return new Response('code unavailable', { status: 404 });
    }
    logEvent('code_resolved', { code });
    return Response.json({ transferId: entry.transferId, key: entry.key });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // design.yash0.in serves the design-docs list site from /design/.
    // Hash routing keeps every doc on one page, so extensionless paths
    // fall back to the design index.
    if (url.hostname === 'design.yash0.in') {
      if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/peerjs/')) {
        return new Response('not found', { status: 404 });
      }
      let assetPath = url.pathname.startsWith('/design/') ? url.pathname : `/design${url.pathname}`;
      if (assetPath.endsWith('/')) assetPath += 'index.html';
      else if (!assetPath.split('/').pop()?.includes('.')) assetPath = '/design/index.html';
      return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
    }
    if (url.pathname === '/peerjs/peerjs') {
      const id = url.searchParams.get('id');
      if (!isPeerID(id) || url.searchParams.get('key') !== 'peerjs' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('invalid signaling request', { status: 400 });
      }
      try {
        const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.PEER_RATE_LIMITER.limit({ key: clientAddress });
        if (!success) return new Response('connection rate limit reached', { status: 429 });
        const headers = new Headers(request.headers);
        headers.set('X-CD-Peer-ID', id);
        return await env.PEERS.getByName(id).fetch(new Request(request, { headers }));
      } catch {
        return new Response('signaling temporarily unavailable', { status: 503 });
      }
    }
    const match = /^\/ws\/v1\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (match) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
      try {
        const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
        if (!success) return new Response('connection rate limit reached', { status: 429 });
        return await env.TRANSFERS.getByName(match[1]).fetch(request);
      } catch (error) {
        console.error(JSON.stringify({ event: 'relay_dispatch_failed', error: error instanceof Error ? error.message : 'unknown' }));
        return new Response('relay temporarily unavailable', { status: 503 });
      }
    }
    if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/peerjs/')) {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return Response.json(
          { service: 'cd-agent-sharing', protocol: 'cd-transfer-v1', status: 'ok' },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (url.pathname === '/api/codes' && request.method === 'POST') {
        return serveCodes(request, env, 'claim');
      }
      const codeLookup = /^\/api\/codes\/(\d{4,5})$/.exec(url.pathname);
      if (codeLookup && request.method === 'GET') {
        return serveCodes(request, env, `code/${codeLookup[1]}`);
      }
      return new Response('not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Short-code directory requests share the relay's per-IP rate limit, which
// also bounds code guessing to a trickle.
async function serveCodes(request: Request, env: Env, suffix: string): Promise<Response> {
  try {
    const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
    if (!success) return new Response('connection rate limit reached', { status: 429 });
    const body = suffix === 'claim' ? await request.text() : undefined;
    if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_CODE_BODY_BYTES) {
      return new Response('too large', { status: 413 });
    }
    return await env.CODES.getByName('codes-v1').fetch(`https://codes.internal/${suffix}`, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: 'code_directory_failed', error: error instanceof Error ? error.message : 'unknown' }));
    return new Response('share codes temporarily unavailable', { status: 503 });
  }
}
