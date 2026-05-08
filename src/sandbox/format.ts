const MB = 1024;
const GB = 1024 * 1024;

export function formatBytes(kb: number): string {
  if (kb < MB) return `${kb} KB`;
  if (kb < GB) return `${(kb / MB).toFixed(1)} MB`;
  return `${(kb / GB).toFixed(1)} GB`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return `${d}d ${h}h`;
}
