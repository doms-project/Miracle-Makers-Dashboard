// ---------------------------------------------------------------------------
// PIPELINE CONFIGURATION — scope and field folders, in ONE Location Custom
// Value, owned by an admin rather than by a deploy.
//
// 🔴 WHY THIS EXISTS. `PIPELINE_FOLDERS` (lib/fieldFolders.ts) maps a pipeline
// to the field folders its record panel shows. A pipeline missing from it fell
// through to `Object.values(FOLDERS)` — ALL TWELVE folders, 68 fields, on one
// card. That already happened once: an applicant was shown Harmony ID, Client
// SSN, all ten IEB/AAA/MCO milestones and the Facebook Form block. It was fixed
// by hand, which meant it would recur on the next new pipeline.
//
// 🔴 AND IT IS AN INVISIBLE FAILURE. A long form of empty fields reads as a
// busy form, not a bug. A rep works around it and never reports it.
//
// Creating a pipeline is ordinary work for the owner. It should not require a
// code change that nobody told them about.
//
// ── THE SOURCE OF TRUTH ────────────────────────────────────────────────────
// The stored value, and nothing else. `PIPELINE_IDS`, `CAREGIVER_PIPELINE_IDS`
// and `PIPELINE_FOLDERS` are read EXACTLY ONCE, to seed it, and then never
// again.
//
// A union of env-plus-stored was considered and rejected: it leaves scope
// living in two places forever, and an admin who later needs to REMOVE a
// pipeline from scope could not — the env half would keep putting it back, with
// nothing on screen to explain why. Configuration an admin changes does not
// belong in an environment variable.
//
// ⚠️ THE ENV VARS AND THE CODE MAP ARE DELIBERATELY LEFT IN PLACE. They are
// vestigial after the seed, but keeping them means a failed seed is
// recoverable. Delete them a release or two later, once seeding is proven in
// production — not in the round that introduces it.
// ---------------------------------------------------------------------------

export type PipelineScope = "client" | "caregiver";

export interface StoredPipelineEntry {
  // 🔴 REQUIRED, not inferred. The caregiver/client split is structural — see
  // the comment at lib/fieldFolders.ts:541: those two lists being separate is
  // what stops a caregiver pipeline ever reaching a client caller. Guessing a
  // scope would put an applicant on the client board.
  scope: PipelineScope;
  // Folder KEYS ("shared", "client"), not ids — half the bytes, and legible to
  // whoever opens this value in GoHighLevel's own custom-values screen, which a
  // list of 20-character ids is not.
  //
  // ⚠️ HYBRID BY DESIGN. A folder created at runtime has no key in code, so its
  // raw id is stored instead. Both resolve through the same KEY_BY_ID lookup.
  folders: string[];
  /**
   * Sections to HIDE ON A RECORD THAT HAS NO VALUE IN ANY OF THEM.
   *
   * 🔴 A PROPERTY OF THE SECTION, NOT OF THE RECORD, and that distinction is
   * the whole reason this is a stored flag rather than a blanket rule.
   *
   * Some sections are SOURCE-CAPTURED: the Website Intent Form, the Facebook
   * Form, Ad Attribution, Private Pay Intake. A form fills them once at intake
   * or never. Empty on this record means the person was never asked — so the
   * questions are not "not yet answered", they are questions that were never
   * put to them. Four permanently blank questions on every Facebook lead is
   * wrong MEANING, not just clutter.
   *
   * Other sections are REP-FILLED: Milestones, Enrollment. Empty means "not
   * yet", and a rep fills them as the case moves. `app/page.tsx` has carried
   * the rule since round 54 — "a rep FILLS these as the case moves, hiding the
   * empty ones would stop them" — and a blanket hide-empty-sections rule would
   * break exactly that: a brand-new OLTL record has no milestones filled, so
   * Milestones would vanish and the rep could never fill the first one.
   *
   * ⚠️ DEFAULT EMPTY = TODAY'S BEHAVIOUR. Nothing is hidden until an admin
   * ticks it, per section, in Admin → Pipelines.
   */
  hideWhenEmpty?: string[];
}

export interface StoredPipelineConfig {
  // 🔴 THE SEED IS DRIVEN BY THIS FLAG, NEVER BY EMPTINESS.
  //
  // "No pipelines stored" and "the save that wiped them" look identical from
  // here. If empty meant "seed", one failed write would silently replace an
  // admin's configuration with the env defaults — and it would look like it had
  // worked. The flag is what distinguishes NEVER CONFIGURED from CONFIGURATION
  // LOST, and those must never be treated the same.
  seeded: boolean;
  pipelines: Record<string, StoredPipelineEntry>;
}

export const PIPELINE_CONFIG_CUSTOM_VALUE_NAME = "MM Pipeline Folders";

export function emptyPipelineConfig(): StoredPipelineConfig {
  return { seeded: false, pipelines: {} };
}

/**
 * Parse the stored string. Returns null for anything it cannot trust.
 *
 * 🔴 NULL IS NOT AN EMPTY CONFIG. A caller must be able to tell "this value is
 * unreadable" from "this value says there are no pipelines" — the first must
 * never trigger a re-seed, because the flag it would need to read is precisely
 * the thing that failed to parse.
 */
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
    const scope = e.scope === "caregiver" ? "caregiver" : e.scope === "client" ? "client" : null;
    // An entry with no valid scope is DROPPED, not defaulted. Defaulting it to
    // "client" is how an applicant pipeline reaches the client board.
    if (!scope) continue;
    const folders = Array.isArray(e.folders)
      ? e.folders.map((f) => String(f ?? "").trim()).filter(Boolean)
      : [];
    const hideWhenEmpty = Array.isArray(e.hideWhenEmpty)
      ? e.hideWhenEmpty.map((f) => String(f ?? "").trim()).filter(Boolean)
      : [];
    // Omitted rather than written as [] so an untouched entry stays byte-clean
    // and the stored value does not grow for pipelines nobody has configured.
    pipelines[id] = hideWhenEmpty.length
      ? { scope, folders, hideWhenEmpty }
      : { scope, folders };
  }
  return { seeded: rec.seeded === true, pipelines };
}

export function serialisePipelineConfig(c: StoredPipelineConfig): string {
  return JSON.stringify({ seeded: c.seeded, pipelines: c.pipelines });
}

/** The ids in one scope, in stored order. */
export function idsInScope(
  c: StoredPipelineConfig | null,
  scope: PipelineScope,
): string[] {
  if (!c) return [];
  return Object.entries(c.pipelines)
    .filter(([, e]) => e.scope === scope)
    .map(([id]) => id);
}
