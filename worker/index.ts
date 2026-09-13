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
const MAX_PEER_BUFFER_BYTES = 2 * 1024 * 1024;
const JOIN_TIMEOUT_MS = 10 * 1000;
const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
const TOMBSTONE_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_SIGNAL_MESSAGES = 512;

function isPeerID(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
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
  // Prefer the runtime constant-time comparator when available, with a
  // manual constant-time fallback so admission never depends on a
  // non-standard API existing at a given compatibility date.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?(a: ArrayBufferView, b: ArrayBufferView): boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    try {
      return subtle.timingSafeEqual(leftBytes, rightBytes);
    } catch {
      return false;
    }
  }
  let diff = 0;
  for (let index = 0; index < 32; index += 1) diff |= leftBytes[index] ^ rightBytes[index];
  return diff === 0;
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
    if (!isSocketAttachment(attachment) || attachment.kind === 'pending') {
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
    if (peer.bufferedAmount > MAX_PEER_BUFFER_BYTES) {
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
    if (this.room.kind !== 'empty' && this.room.expiresAt <= now) {
      logEvent('room_expired');
      for (const socket of this.ctx.getWebSockets()) socket.close(4408, 'room expired');
      await this.finishRoom();
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
      return isSocketAttachment(attachment) && attachment.kind === 'peer' && attachment.role === role;
    }) ?? null;
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
      if (new TextEncoder().encode(body).byteLength > MAX_SIGNAL_BYTES) return new Response('too large', { status: 413 });
      const socket = this.ctx.getWebSockets()[0];
      if (!socket) return new Response('peer unavailable', { status: 404 });
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
    if (this.ctx.getWebSockets().some((socket) => socket !== server)) {
      server.send(JSON.stringify({ type: 'ID-TAKEN' }));
      server.close(4409, 'peer id taken');
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ id, peers: [], messages: 0 } satisfies PeerAttachment);
    server.send(JSON.stringify({ type: 'OPEN' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment || typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) {
      socket.close(4400, 'invalid signal');
      return;
    }
    let value: Record<string, unknown>;
    try { value = JSON.parse(message) as Record<string, unknown>; } catch { socket.close(4400, 'invalid signal'); return; }
    if (value.type === 'HEARTBEAT') return;
    if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE'].includes(String(value.type)) || !isPeerID(value.dst)) {
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
    const attachment = socket.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) return;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/peerjs/peerjs') {
      const id = url.searchParams.get('id');
      if (!isPeerID(id) || url.searchParams.get('key') !== 'peerjs' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('invalid signaling request', { status: 400 });
      }
      try {
        const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: `peer:${clientAddress}` });
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
      return new Response('not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
