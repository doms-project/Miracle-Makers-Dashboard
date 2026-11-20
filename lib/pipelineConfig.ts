export type PipelineScope = "client" | "caregiver" | "none";

export type BoardScope = "client" | "caregiver";

export interface StoredPipelineEntry {

  scope: PipelineScope;

  folders: string[];

  exclude?: string[];

  group?: "caregiver" | "staff";

  role?: "events";

  sidebar?: false;
}

export interface StoredPipelineConfig {

  seeded: boolean;
  pipelines: Record<string, StoredPipelineEntry>;

  folderNames: Record<string, string>;

  labels: Record<string, string>;
}

export const PIPELINE_CONFIG_CUSTOM_VALUE_NAME = "MM Pipeline Folders";

export const SEED_FOLDER_NAMES: Record<string, string> = {
  "1JFUFsjPXNFzMW18dYSe": "Website Intent Form",
  "56mZT4dH0xztuxwgUt00": "Event Details",
  "9OZdxXFfJsdNGR7qsQKQ": "Referral Detail",
};

export const SEED_TICKED_ON_CLIENT: string[] = ["1JFUFsjPXNFzMW18dYSe"];

export function emptyPipelineConfig(): StoredPipelineConfig {
  return { seeded: false, pipelines: {}, folderNames: {}, labels: {} };
}

export function parsePipelineConfig(raw: unknown): StoredPipelineConfig | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  const pipes = rec.pipelines;
  if (!pipes || typeof pipes !== "object" || Array.isArray(pipes)) return null;

  const pipelines: Record<string, StoredPipelineEntry> = {};
  for (const [id, v] of Object.entries(pipes as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const scope: PipelineScope | null =
      e.scope === "caregiver"
        ? "caregiver"
        : e.scope === "client"
          ? "client"
          : e.scope === "none"
            ? "none"
            : null;

    if (!scope) continue;
    const folders = Array.isArray(e.folders)
      ? e.folders.map((f) => String(f ?? "").trim()).filter(Boolean)
      : [];
    const group = e.group === "staff" ? "staff" : e.group === "caregiver" ? "caregiver" : null;
    const exclude = Array.isArray(e.exclude)
      ? [...new Set(e.exclude.map((f) => String(f ?? "").trim()).filter(Boolean))]
      : [];

    const role = e.role === "events" ? "events" : null;
    const base: StoredPipelineEntry = { scope, folders };
    if (exclude.length) base.exclude = exclude;
    if (group) base.group = group;
    if (role) base.role = role;

    if (e.sidebar === false) base.sidebar = false;
    pipelines[id] = base;
  }
  const folderNames: Record<string, string> = {};
  const fn = rec.folderNames;
  if (fn && typeof fn === "object" && !Array.isArray(fn))
    for (const [id, v] of Object.entries(fn as Record<string, unknown>)) {
      const n = String(v ?? "").trim();
      if (id && n) folderNames[id] = n;
    }
  const labels: Record<string, string> = {};
  const lb = rec.labels;
  if (lb && typeof lb === "object" && !Array.isArray(lb))
    for (const [k, v] of Object.entries(lb as Record<string, unknown>)) {
      const n = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
      if (k && n && n.length <= 40) labels[k] = n;
    }
  return { seeded: rec.seeded === true, pipelines, folderNames, labels };
}

export function withExclusion(
  entry: StoredPipelineEntry,
  fieldId: string,
  exclude: boolean,
): StoredPipelineEntry {
  const cur = entry.exclude ?? [];
  const next = exclude ? [...new Set([...cur, fieldId])] : cur.filter((x) => x !== fieldId);

  if (next.length) return { ...entry, exclude: next };
  const { exclude: _gone, ...rest } = entry;
  void _gone;
  return rest;
}

export function serialisePipelineConfig(c: StoredPipelineConfig): string {
  return JSON.stringify({
    seeded: c.seeded,
    pipelines: c.pipelines,
    folderNames: c.folderNames || {},
    labels: c.labels || {},
  });
}

export function recruitingGroup(
  c: StoredPipelineConfig | null,
  pipelineId: string,
): "caregiver" | "staff" {
  return c?.pipelines?.[pipelineId]?.group === "staff" ? "staff" : "caregiver";
}

export function pipelineWithRole(
  c: StoredPipelineConfig | null,
  role: NonNullable<StoredPipelineEntry["role"]>,
): string {
  const hit = Object.entries(c?.pipelines || {}).find(([, e]) => e?.role === role);
  return hit ? hit[0] : "";
}

export function exclusionsFor(
  c: StoredPipelineConfig | null,
  pipelineId: string,
): Set<string> {
  return new Set(c?.pipelines?.[pipelineId]?.exclude ?? []);
}

export function idsInScope(
  c: StoredPipelineConfig | null,
  scope: PipelineScope,
): string[] {
  if (!c) return [];
  return Object.entries(c.pipelines)
    .filter(([, e]) => e.scope === scope)
    .map(([id]) => id);
}
