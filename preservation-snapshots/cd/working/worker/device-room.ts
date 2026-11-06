import { DurableObject } from 'cloudflare:workers';
import { boundedPushJSON, devicePushConfigured, sendDeviceWake, type DevicePushEnvironment } from './device-push';

type Role = 'sender' | 'receiver';
type Registration = { senderTokenHash: string; receiverTokenHash: string; expiresAt: number };
type Attachment =
  | { kind: 'pending'; expiresAt: number }
  | { kind: 'peer'; role: Role; windowAt: number; messages: number; lastSeen: number };
type Join = { role: Role; token: string } & (
  | { registration: null }
  | { registration: { senderTokenHash: string; receiverTokenHash: string } }
);

const TTL = 30 * 24 * 60 * 60 * 1000;
const JOIN_TIMEOUT = 10_000;
const PEER_LEASE = 75_000;
const MAX_FRAME = 16 * 1024;
const MAX_BUFFER = 256 * 1024;
const encoder = new TextEncoder();

function token(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), c => c.charCodeAt(0));
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function hash(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', decode(value))));
}
function equal(left: string, right: string): boolean {
  const subtle = crypto.subtle;
  return 'timingSafeEqual' in subtle && typeof subtle.timingSafeEqual === 'function'
    && subtle.timingSafeEqual(decode(left), decode(right));
}
function parseJoin(input: string): Join | null {
  if (encoder.encode(input).length > 1024) return null;
  let v: unknown;
  try { v = JSON.parse(input); } catch { return null; }
  if (!v || typeof v !== 'object' || !('type' in v) || v.type !== 'join'
    || !('protocol' in v) || v.protocol !== 'cd-device-v1'
    || !('role' in v) || (v.role !== 'sender' && v.role !== 'receiver')
    || !('token' in v) || !token(v.token)) return null;
  if (!('senderTokenHash' in v) && !('receiverTokenHash' in v)) {
    return { role: v.role, token: v.token, registration: null };
  }
  if (v.role !== 'sender' || !('senderTokenHash' in v) || !token(v.senderTokenHash)
    || !('receiverTokenHash' in v) || !token(v.receiverTokenHash)) return null;
  return { role: v.role, token: v.token, registration: { senderTokenHash: v.senderTokenHash, receiverTokenHash: v.receiverTokenHash } };
}
function attachment(socket: WebSocket): Attachment | null {
  const v: unknown = socket.deserializeAttachment();
  if (!v || typeof v !== 'object' || !('kind' in v)) return null;
  if (v.kind === 'pending' && 'expiresAt' in v && typeof v.expiresAt === 'number') {
    return { kind: 'pending', expiresAt: v.expiresAt };
  }
  if (v.kind === 'peer' && 'role' in v && (v.role === 'sender' || v.role === 'receiver')
    && 'windowAt' in v && typeof v.windowAt === 'number' && 'messages' in v && typeof v.messages === 'number') {
    return { kind: 'peer', role: v.role, windowAt: v.windowAt, messages: v.messages, lastSeen: 'lastSeen' in v && typeof v.lastSeen === 'number' ? v.lastSeen : v.windowAt };
  }
  return null;
}
function event(type: 'accepted' | 'peer-joined' | 'peer-left'): string {
  return JSON.stringify({ type, protocol: 'cd-device-v1' });
}
function close(socket: WebSocket, code: number, reason: string): void {
  try { socket.close(code, reason); } catch { /* A peer may already have closed. */ }
}

type PushTarget = { fid: string; updatedAt: number; expiresAt: number; generation: string };
type PushBudget = { attempts: number[] };
type PushDecision = { kind: 'unauthorized' | 'changed' | 'online' | 'unavailable' | 'throttled' } | { kind: 'send'; target: PushTarget };
type PushInput = { token: string } & ({ kind: 'wake' } | { kind: 'clear' } | { kind: 'target'; fid: string });
function pushJSON(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
function pushError(error: string, status: number): Response { return pushJSON({ v: 1, error }, status); }
function parsePushInput(value: unknown, target: boolean, method: string): PushInput | null {
  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 || !('token' in value) || !token(value.token)) return null;
  if (!target) return method === 'POST' && 'reason' in value && value.reason === 'offer' ? { token: value.token, kind: 'wake' } : null;
  if (method === 'DELETE') return { token: value.token, kind: 'clear' };
  return method === 'POST' && 'fid' in value && typeof value.fid === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.fid)
    ? { token: value.token, kind: 'target', fid: value.fid } : null;
}

export class DeviceRoom extends DurableObject<Env & DevicePushEnvironment> {
  private admitting = new Set<Role>();
  async fetch(request: Request): Promise<Response> {
    const push = /^\/api\/devices\/v1\/([A-Za-z0-9_-]{22})\/(push|push-target)$/.exec(new URL(request.url).pathname);
    if (push) return this.push(request, push[1], push[2] === 'push-target');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 4) return new Response('connection limit reached', { status: 429 });
    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ kind: 'pending', expiresAt: Date.now() + JOIN_TIMEOUT } satisfies Attachment);
    this.ctx.acceptWebSocket(pair[1]);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async push(request: Request, pairId: string, target: boolean): Promise<Response> {
    if ((target && !['POST', 'DELETE'].includes(request.method)) || (!target && request.method !== 'POST')) return pushError('method_not_allowed', 405);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return pushError('invalid_request', 400);
    let value: unknown;
    try { value = await boundedPushJSON(request, 1024); } catch { return pushError('invalid_request', 400); }
    const input = parsePushInput(value, target, request.method);
    if (!input) return pushError('invalid_request', 400);
    const supplied = await hash(input.token);
    const now = Date.now();
    const configured = devicePushConfigured(this.env);
    const freshReceiver = this.ctx.getWebSockets().some(socket => { const a = attachment(socket); return socket.readyState === WebSocket.OPEN && a?.kind === 'peer' && a.role === 'receiver' && now - a.lastSeen <= 25000; });
    const result = await this.ctx.storage.transaction<PushDecision>(async storage => {
      const registration = await storage.get<Registration>('registration');
      if (!registration || registration.expiresAt <= now) return { kind: 'unauthorized' };
      const expected = input.kind === 'wake' ? registration.senderTokenHash : registration.receiverTokenHash;
      if (!equal(supplied, expected)) return { kind: 'unauthorized' };
      if (input.kind === 'clear') { await storage.delete('push-target'); return { kind: 'changed' }; }
      if (input.kind === 'target') {
        await storage.put('push-target', { fid: input.fid, updatedAt: now, generation: crypto.randomUUID(), expiresAt: Math.min(registration.expiresAt, now + TTL) } satisfies PushTarget);
        return { kind: 'changed' };
      }
      if (freshReceiver) return { kind: 'online' };
      const pushTarget = await storage.get<PushTarget>('push-target');
      if (!pushTarget || pushTarget.expiresAt <= now || !configured) return { kind: 'unavailable' };
      const budget = await storage.get<PushBudget>('push-budget');
      const attempts = (budget?.attempts ?? []).filter(at => at > now - 3600000);
      if (attempts.length >= 20 || attempts.some(at => at > now - 30000)) return { kind: 'throttled' };
      await storage.put('push-budget', { attempts: [...attempts, now] } satisfies PushBudget);
      return { kind: 'send', target: pushTarget };
    });
    if (result.kind === 'unauthorized') return pushError('unauthorized', 401);
    if (result.kind === 'throttled') return pushError('rate_limited', 429);
    if (result.kind === 'changed') { await this.schedule(); return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }); }
    if (result.kind !== 'send') return pushJSON({ v: 1, status: result.kind });
    const delivered = await sendDeviceWake(this.env, { fid: result.target.fid, pairId, issuedAt: now });
    if (delivered === 'invalid-target') {
      await this.ctx.storage.transaction(async storage => {
        const current = await storage.get<PushTarget>('push-target');
        if (current?.fid === result.target.fid && current.generation === result.target.generation) await storage.delete('push-target');
      });
    }
    return pushJSON({ v: 1, status: delivered === 'nudged' ? 'nudged' : 'unavailable' });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = attachment(socket);
    if (!a) { close(socket, 4400, 'invalid connection'); return; }
    if (a.kind === 'pending') {
      if (a.expiresAt <= Date.now()) { close(socket, 4408, 'join expired'); return; }
      const join = typeof message === 'string' ? parseJoin(message) : null;
      if (!join) { close(socket, 4406, 'invalid device join'); return; }
      await this.admit(socket, join);
      return;
    }
    const registration = await this.ctx.storage.get<Registration>('registration');
    if (!registration || registration.expiresAt <= Date.now()) { close(socket, 4408, 'pair registration expired'); return; }
    const now = Date.now();
    const next = now - a.windowAt >= 60_000
      ? { ...a, windowAt: now, messages: 1, lastSeen: now }
      : { ...a, messages: a.messages + 1, lastSeen: now };
    if (next.messages > 120) { close(socket, 4429, 'message limit reached'); return; }
    if (typeof message === 'string') {
      if (encoder.encode(message).length > 256) { close(socket, 4403, 'invalid keepalive'); return; }
      let ping: unknown;
      try { ping = JSON.parse(message); } catch { close(socket, 4403, 'invalid keepalive'); return; }
      if (!ping || typeof ping !== 'object' || !('type' in ping) || ping.type !== 'ping'
        || !('protocol' in ping) || ping.protocol !== 'cd-device-v1') { close(socket, 4403, 'invalid keepalive'); return; }
      socket.serializeAttachment(next satisfies Attachment);
      socket.send(JSON.stringify({ type: 'pong', protocol: 'cd-device-v1' }));
      await this.schedule();
      return;
    }
    if (message.byteLength < 28 || message.byteLength > MAX_FRAME) { close(socket, 4403, 'invalid device frame'); return; }
    socket.serializeAttachment(next satisfies Attachment);
    await this.schedule();
    const peer = this.peer(a.role === 'sender' ? 'receiver' : 'sender');
    if (!peer) { socket.send(event('peer-left')); return; }
    if (peer.bufferedAmount + message.byteLength > MAX_BUFFER) {
      close(socket, 4429, 'peer is too slow'); close(peer, 4429, 'peer is too slow'); return;
    }
    try { peer.send(message); } catch { close(socket, 1011, 'device relay failed'); }
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    close(socket, code === 1005 || code === 1006 ? 1000 : code, 'closed');
    const a = attachment(socket);
    if (a?.kind === 'peer') {
      try { this.peer(a.role === 'sender' ? 'receiver' : 'sender')?.send(event('peer-left')); } catch { /* Peer reconnects. */ }
    }
  }
  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket, 1011); }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const a = attachment(socket);
      if (!a || (a.kind === 'pending' && a.expiresAt <= now)) close(socket, 4408, 'join expired');
      else if (a.kind === 'peer' && a.lastSeen + PEER_LEASE <= now) close(socket, 4408, 'device keepalive expired');
    }
    const registration = await this.ctx.storage.get<Registration>('registration');
    if (registration && registration.expiresAt <= now) {
      for (const socket of this.ctx.getWebSockets()) close(socket, 4408, 'pair registration expired');
      await this.ctx.storage.delete(['registration', 'push-target', 'push-budget']);
    }
    const target = await this.ctx.storage.get<PushTarget>('push-target');
    if (target && target.expiresAt <= now) await this.ctx.storage.delete('push-target');
    await this.schedule();
  }

  private async admit(socket: WebSocket, join: Join): Promise<void> {
    if (this.admitting.has(join.role)) { close(socket, 4409, 'device admission in progress'); return; }
    this.admitting.add(join.role);
    try { await this.admitExclusive(socket, join); }
    finally { this.admitting.delete(join.role); }
  }

  private async admitExclusive(socket: WebSocket, join: Join): Promise<void> {
    const supplied = await hash(join.token);
    const stored = await this.ctx.storage.get<Registration>('registration');
    const current = stored && stored.expiresAt > Date.now() ? stored : null;
    let next: Registration;
    if (!current) {
      if (join.role !== 'sender' || !join.registration || !equal(supplied, join.registration.senderTokenHash)) {
        close(socket, 4401, 'sender registration required'); return;
      }
      await this.ctx.storage.delete(['push-target', 'push-budget']);
      next = { ...join.registration, expiresAt: Date.now() + TTL };
    } else {
      const expected = join.role === 'sender' ? current.senderTokenHash : current.receiverTokenHash;
      if (!equal(supplied, expected) || (join.registration && (
        !equal(join.registration.senderTokenHash, current.senderTokenHash)
        || !equal(join.registration.receiverTokenHash, current.receiverTokenHash)))) {
        close(socket, 4401, 'device unauthorized'); return;
      }
      next = { ...current, expiresAt: Date.now() + TTL };
    }
    // Storage gates admission before publishing the socket's authenticated role.
    // Recheck after asynchronous crypto/storage so concurrent joins cannot replace it.
    if (this.peer(join.role)) { close(socket, 4409, 'device already connected'); return; }
    await this.ctx.storage.put('registration', next);
    socket.serializeAttachment({ kind: 'peer', role: join.role, windowAt: Date.now(), messages: 0, lastSeen: Date.now() } satisfies Attachment);
    socket.send(event('accepted'));
    const peer = this.peer(join.role === 'sender' ? 'receiver' : 'sender');
    if (peer) { peer.send(event('peer-joined')); socket.send(event('peer-joined')); }
    await this.schedule();
  }

  private peer(role: Role): WebSocket | undefined {
    return this.ctx.getWebSockets().find(s => { const a = attachment(s); return s.readyState === WebSocket.OPEN && a?.kind === 'peer' && a.role === role; });
  }
  private async schedule(): Promise<void> {
    const deadlines: number[] = [];
    const registration = await this.ctx.storage.get<Registration>('registration');
    if (registration) deadlines.push(registration.expiresAt);
    const pushTarget = await this.ctx.storage.get<PushTarget>('push-target');
    if (pushTarget) deadlines.push(pushTarget.expiresAt);
    for (const socket of this.ctx.getWebSockets()) {
      const a = attachment(socket);
      if (socket.readyState === WebSocket.OPEN && a?.kind === 'pending') deadlines.push(a.expiresAt);
      if (socket.readyState === WebSocket.OPEN && a?.kind === 'peer') deadlines.push(a.lastSeen + PEER_LEASE);
    }
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }
}
