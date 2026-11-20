export const FIRST_OPENED_FIELD = "First Opened";

export const NEW_LEAD_SINCE_DEFAULT = "2026-10-26T04:00:00.000Z";

export function newLeadSince(env: string | undefined = typeof process !== "undefined" ? process.env.NEW_LEAD_SINCE : undefined): string {
  const raw = (env || "").trim();
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return NEW_LEAD_SINCE_DEFAULT;
}

export function encodeFirstOpened(at: string, userId: string): string {
  return `${at}|${userId}`;
}

export function parseFirstOpened(v: unknown): { at: string; userId: string } | null {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  const t = s.trim();
  if (!t) return null;
  const i = t.indexOf("|");
  const at = i < 0 ? t : t.slice(0, i);
  const userId = i < 0 ? "" : t.slice(i + 1);
  return { at, userId };
}

export function isNewLead(
  rec: { firstOpened?: string; createdAt?: string; status?: string },
  since: string,
): boolean {
  if (parseFirstOpened(rec.firstOpened)) return false;
  if ((rec.status || "open").toLowerCase() !== "open") return false;
  const created = new Date(String(rec.createdAt || ""));
  const cutoff = new Date(since);
  if (isNaN(created.getTime()) || isNaN(cutoff.getTime())) return false;
  return created.getTime() >= cutoff.getTime();
}
