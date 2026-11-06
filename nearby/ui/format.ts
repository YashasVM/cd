export function bytes(value: number): string {
  if (!value) return "0 B";
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function percent(done: number, total: number): number {
  return total
    ? Math.min(100, Math.max(0, Math.round((done / total) * 100)))
    : 0;
}
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
