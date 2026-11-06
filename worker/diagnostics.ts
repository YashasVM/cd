export type DiagnosticReport = {
  version: 1;
  role: 'sender' | 'receiver';
  phase: string;
  transport: string;
  startedAt: number;
  elapsedMs: number;
  bytes: number;
  total: number;
  chunks: number;
  peakQueueBytes: number;
  client: Record<string, string | number | boolean>;
  timings: Record<string, { count: number; totalMs: number; maxMs: number }>;
  samples: Record<string, number | string>[];
  events: { atMs: number; name: string; value: string }[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid diagnostic object');
  return Object.fromEntries(Object.entries(value));
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid diagnostic number');
  return value;
}
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid diagnostic text');
  return value;
}
const clientFields = new Set(['userAgent', 'mobile', 'cores', 'memoryGiB', 'effectiveType', 'downlinkMbps', 'networkRttMs', 'saveData', 'mode']);
const sampleFields = new Set(['atMs', 'bytes', 'mibPerSecond', 'queueBytes', 'eventLoopLagMs', 'rttMs', 'availableOutgoingBitrate', 'rtcBytesSent', 'rtcBytesReceived', 'transport', 'localCandidateType', 'remoteCandidateType', 'protocol', 'visibility']);
const timingFields = new Set(['read', 'seal', 'ackWait', 'assemble', 'decrypt', 'write', 'flush']);
const eventFields = new Set(['connecting', 'code-ready', 'peer-joined', 'offered', 'accepted', 'sink', 'direct-open', 'direct-lost', 'ice-state', 'transport', 'complete', 'failed', 'cancelled', 'visibility']);

export function parseDiagnosticReport(value: unknown): DiagnosticReport {
  const v = object(value);
  if (v.version !== 1 || (v.role !== 'sender' && v.role !== 'receiver')) throw new Error('invalid diagnostic version or role');
  const phase = text(v.phase);
  const transport = text(v.transport);
  if (!['connecting', 'waiting', 'transferring', 'complete', 'failed', 'cancelled'].includes(phase) || !['relay', 'direct'].includes(transport)) throw new Error('invalid diagnostic phase');
  const client: DiagnosticReport['client'] = {};
  for (const [key, item] of Object.entries(object(v.client))) {
    if (!clientFields.has(key)) continue;
    client[key] = typeof item === 'boolean' ? item : typeof item === 'number' ? number(item) : text(item, 250);
  }
  const timings: DiagnosticReport['timings'] = {};
  for (const [key, item] of Object.entries(object(v.timings))) {
    if (!timingFields.has(key)) continue;
    const t = object(item);
    timings[key] = { count: number(t.count), totalMs: number(t.totalMs), maxMs: number(t.maxMs) };
  }
  if (!Array.isArray(v.samples) || v.samples.length > 180 || !Array.isArray(v.events) || v.events.length > 80) throw new Error('too many diagnostic samples');
  const samples = v.samples.map((sample) => {
    const result: Record<string, number | string> = {};
    for (const [key, item] of Object.entries(object(sample))) {
      if (sampleFields.has(key)) result[key] = typeof item === 'number' ? number(item) : text(item);
    }
    return result;
  });
  const events = v.events.map((event) => {
    const e = object(event);
    const name = text(e.name);
    if (!eventFields.has(name)) throw new Error('invalid diagnostic event');
    return { atMs: number(e.atMs), name, value: text(e.value) };
  });
  return { version: 1, role: v.role, phase, transport, startedAt: number(v.startedAt), elapsedMs: number(v.elapsedMs), bytes: number(v.bytes), total: number(v.total), chunks: number(v.chunks), peakQueueBytes: number(v.peakQueueBytes), client, timings, samples, events };
}

export async function readDiagnosticReport(request: Request): Promise<DiagnosticReport> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing diagnostic report');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error('diagnostic report exceeds 64 KiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return parseDiagnosticReport(JSON.parse(new TextDecoder().decode(buffer)));
}

export type DiagnosticState = {
  tokenHash: string;
  expiresAt: number;
  relay: { senderBytes: number; receiverBytes: number; frames: number; peakBufferedBytes: number; createdAt: number; pairedAt?: number; finishedAt?: number; colo: string };
  reports: { sender?: DiagnosticReport; receiver?: DiagnosticReport };
};
