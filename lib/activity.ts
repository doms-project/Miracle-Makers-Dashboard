export interface ActivityStamps {
  createdAt?: unknown;
  updatedAt?: unknown;
  stageChangedAt?: unknown;
  statusChangedAt?: unknown;

  newLead?: unknown;
}

function ms(v: unknown): number {
  if (v == null || v === "") return 0;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export function latestActivity(r: ActivityStamps): number {
  return Math.max(ms(r.createdAt), ms(r.updatedAt), ms(r.stageChangedAt), ms(r.statusChangedAt));
}

export const isUnopenedNewLead = (r: ActivityStamps): boolean => r.newLead === true;

export function byLatestActivity<T extends ActivityStamps>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i, t: latestActivity(r), pin: isUnopenedNewLead(r) }))
    .sort((a, b) => {
      if (a.pin !== b.pin) return a.pin ? -1 : 1;
      if (a.t !== b.t) {
        if (!a.t) return 1;
        if (!b.t) return -1;
        return b.t - a.t;
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}
