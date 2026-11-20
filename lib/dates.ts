export function parseGhlDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw == null || raw === "") return null;

  if (typeof raw === "number" && Number.isFinite(raw)) return fromEpoch(raw);

  const s = String(raw).trim();
  if (!s) return null;

  if (/^\d+$/.test(s)) return fromEpoch(Number(s));

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fromEpoch(n: number): Date | null {

  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

export function hasTime(v: unknown): boolean {
  const d = parseGhlDate(v);
  if (!d) return false;

  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (m !== 0) return true;
  return h !== 0 && h !== 12;
}

export function nameImpliesTime(name: string): boolean {
  return /\btime\b/i.test(name || "");
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function formatGhlDate(v: unknown, opts?: { withTime?: boolean }): string {
  const d = parseGhlDate(v);
  if (!d) return "";
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const wantTime = opts?.withTime ?? hasTime(v);

  if (!wantTime) return date;

  return formatEastern(d);
}

export function toDateInput(v: unknown): string {
  const d = parseGhlDate(v);
  return d ? d.toISOString().slice(0, 10) : "";
}

export const DASHBOARD_TZ = "America/New_York";

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const EASTERN_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parts(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

export function formatEastern(iso: unknown): string {
  if (iso == null || iso === "") return "";
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return "";
  const p = parts(EASTERN, d);
  const mer = (p.dayPeriod || "").toLowerCase();
  return `${p.month} ${p.day} ${p.year}, ${p.hour}:${p.minute}${mer} (${p.timeZoneName})`;
}

export function formatEasternDay(iso: unknown): string {
  if (iso == null || iso === "") return "";
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return "";
  const p = parts(EASTERN_DAY, d);
  return `${p.month} ${p.day} ${p.year}`;
}

export function formatEasternShort(iso: unknown): string {
  const full = formatEasternDay(iso);
  return full ? full.replace(/ \d{4}$/, "") : "";
}

export function formatEasternNoZone(iso: unknown): string {
  const s = formatEastern(iso);
  return s ? s.replace(/ \([A-Z]{2,5}\)$/, "") : "";
}
