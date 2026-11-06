// Pure helpers behind CD's public usage stats (worker/stats.ts). This file
// has no imports so node tests can load it directly.
//
// What is counted: one completed transfer (a paired room whose receiver
// confirmed every byte) adds to one per-UTC-day row. What is published: only
// whole UTC days that are over, rounded down, with quiet days hidden, so a
// single transfer can't be timed or sized from the public numbers.

export type StatsHint = { files: number; bytes: number };
export type TransferReport = { files: number; relayBytes: number; directBytes: number };
export type DayCounts = { transfers: number; files: number; relayBytes: number; directBytes: number };
export type DayRow = DayCounts & { day: number };
export type PublicDay = { date: string; hidden: true } | ({ date: string; hidden: false } & DayCounts);
export type PublicStats = {
  version: 1;
  // First UTC day with any counted transfer, once that day is published.
  since: string | null;
  // Last published UTC day: yesterday.
  through: string;
  totals: DayCounts;
  days: PublicDay[];
  rounding: { count: number; dayBytes: number; totalBytes: number; minTransfers: number };
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const PUBLISHED_DAYS = 90;
// Senders bundle at most this many files per transfer as far as stats go.
export const MAX_HINT_FILES = 10_000;
// The direct (WebRTC) path is credited with at most 1 Gbit/s since pairing,
// which bounds what a sender's self-reported size can add.
export const MAX_DIRECT_BYTES_PER_MS = 125_000;
// Publication: counts round down to tens, data to 1 GiB per day and 10 GiB
// overall, and a day with fewer than ten completed transfers shows as hidden.
export const COUNT_UNIT = 10;
export const DAY_BYTES_UNIT = 2 ** 30;
export const TOTAL_BYTES_UNIT = 10 * 2 ** 30;
export const MIN_PUBLISHED_TRANSFERS = 10;

const RECORD_OVERHEAD = 12 + 16;
const RECORD_VERSION = 1;
const KIND_COMPLETE = 6;

// parseStatsHint reads a sender's optional join hint, "<files>:<bytes>".
// It is a string so relays and test fakes that decode joins as string maps
// keep working. Anything malformed is ignored, never fatal: stats must not
// cost a transfer.
export function parseStatsHint(value: unknown): StatsHint | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([1-9]\d{0,15}):(0|[1-9]\d{0,15})$/.exec(value);
  if (!match) return undefined;
  const files = Number(match[1]);
  const bytes = Number(match[2]);
  if (!Number.isSafeInteger(files) || !Number.isSafeInteger(bytes)) return undefined;
  return { files: Math.min(files, MAX_HINT_FILES), bytes };
}

// isCompleteRecord spots the receiver's COMPLETE record from its plaintext
// header ('C', 'D', version, kind): the receiver sends it only after it
// verified every byte.
export function isCompleteRecord(record: ArrayBuffer): boolean {
  if (record.byteLength < RECORD_OVERHEAD) return false;
  const header = new Uint8Array(record, 0, 4);
  return header[0] === 0x43 && header[1] === 0x44 && header[2] === RECORD_VERSION && header[3] === KIND_COMPLETE;
}

// transferReport turns one completed room into counters. Relay bytes are
// measured; direct bytes are the sender's reported size beyond what the
// relay carried, capped by how long the room was paired. Senders without a
// hint count as one file and no direct bytes.
export function transferReport(hint: StatsHint | undefined, relayBytes: number, pairedMs: number): TransferReport {
  const relay = Number.isSafeInteger(relayBytes) && relayBytes > 0 ? relayBytes : 0;
  const cap = Math.max(0, Math.floor(pairedMs)) * MAX_DIRECT_BYTES_PER_MS;
  const direct = hint ? Math.min(Math.max(0, hint.bytes - relay), cap) : 0;
  return { files: hint?.files ?? 1, relayBytes: relay, directBytes: Number.isSafeInteger(direct) ? direct : 0 };
}

export function isTransferReport(value: unknown): value is TransferReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return isCount(report.files) && report.files >= 1 && report.files <= MAX_HINT_FILES
    && isCount(report.relayBytes) && isCount(report.directBytes);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function dayDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function floorTo(value: number, unit: number): number {
  return Math.floor(value / unit) * unit;
}

// publishStats builds the public document for `today` (a UTC day number)
// from the sums over every finished day, the finished days in the window,
// and the first day ever counted. Today itself is never included.
export function publishStats(totals: DayCounts, rows: DayRow[], firstDay: number | null, today: number): PublicStats {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days: PublicDay[] = [];
  for (let day = today - PUBLISHED_DAYS; day < today; day += 1) {
    const row = byDay.get(day);
    const date = dayDate(day);
    if (!row || row.transfers < MIN_PUBLISHED_TRANSFERS) {
      days.push({ date, hidden: true });
      continue;
    }
    days.push({
      date, hidden: false,
      transfers: floorTo(row.transfers, COUNT_UNIT),
      files: floorTo(row.files, COUNT_UNIT),
      relayBytes: floorTo(row.relayBytes, DAY_BYTES_UNIT),
      directBytes: floorTo(row.directBytes, DAY_BYTES_UNIT),
    });
  }
  return {
    version: 1,
    since: firstDay !== null && firstDay < today ? dayDate(firstDay) : null,
    through: dayDate(today - 1),
    totals: {
      transfers: floorTo(totals.transfers, COUNT_UNIT),
      files: floorTo(totals.files, COUNT_UNIT),
      relayBytes: floorTo(totals.relayBytes, TOTAL_BYTES_UNIT),
      directBytes: floorTo(totals.directBytes, TOTAL_BYTES_UNIT),
    },
    days,
    rounding: { count: COUNT_UNIT, dayBytes: DAY_BYTES_UNIT, totalBytes: TOTAL_BYTES_UNIT, minTransfers: MIN_PUBLISHED_TRANSFERS },
  };
}
