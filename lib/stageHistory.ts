export const STAGE_HISTORY_FIELD = "Stage History";

export interface StageHistoryRow {
  at: string;
  from: string | null;
  to: string;
  ownerId: string;
  managerIds: string[];
}

export function encodeStageRow(at: string, to: string, ownerId: string, managerIds: string[]): string {
  return [at, to, ownerId, managerIds.join(",")].join("|");
}

export function parseStageHistory(raw: unknown): StageHistoryRow[] {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  const out: StageHistoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [at, to, ownerId, managers] = t.split("|");
    if (!at || !to) continue;
    out.push({
      at,

      from: out.length ? out[out.length - 1].to : null,
      to,
      ownerId: ownerId || "",
      managerIds: (managers || "").split(",").map((x) => x.trim()).filter(Boolean),
    });
  }
  return out;
}
