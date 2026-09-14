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

/**
 * 🔴 THREE VALUES, AND THE THIRD IS AN ABSENCE — round 116, item K.
 *
 * Scope is NOT "where records render". It is WHICH PICKER LISTS THIS PIPELINE.
 * `getSelectedPipelines(scope)` is what every board reads; `listPipelines()` is
 * what every admin surface reads. A pipeline stored as "none" simply matches
 * neither board filter, so it disappears from both pickers and stays fully
 * present in the import wizard, the access grid and this screen.
 *
 * ⚠️ "none" IS NOT "BOTH" INVERTED. fieldFolders.ts:541 — "the two lists being
 * separate is what stops a caregiver pipeline reaching a client caller." This
 * adds FEWER places a pipeline can appear, never more.
 *
 * ⚠️ NOTHING MIGRATES. Every stored entry already carries "client" or
 * "caregiver" and keeps it; "none" can only ever arrive by an admin choosing it.
 */
export type PipelineScope = "client" | "caregiver" | "none";

/**
 * The two scopes that name a BOARD. Reads that mean "which pipelines does the
 * Clients section show" take this, not PipelineScope — so "none" cannot be
 * passed to a board read by accident.
 */
export type BoardScope = "client" | "caregiver";

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
   * 🔴 EXCLUSIONS, NOT INCLUSIONS — round 116, item Q. Field IDS hidden from
   * this pipeline's panel even though their folder is ticked.
   *
   * ⚠️ THE DIRECTION IS THE WHOLE POINT. fieldFolders.ts:8 — "Adding/moving a
   * field in GoHighLevel changes the panel with no code change." A field
   * created tomorrow is not in anybody's exclusion list, so it appears. An
   * INCLUSION list would invert that: every new field invisible until someone
   * ticked it, and nobody would know to.
   *
   * ⚠️ AND IT COSTS THE EXCEPTIONS ONLY. "Shared with Road Blocker and Case
   * Manager off" is two ids, not the sixty-eight an inclusion list would need
   * per pipeline.
   *
   * 🔴 FIELD IDS, NOT NAMES. A field renamed in GoHighLevel must stay excluded;
   * a name match would silently un-hide it. Folders are stored by key because a
   * key is legible in GHL's own custom-values screen and there are twelve of
   * them — there are sixty-eight fields and no key for any of them.
   *
   * Optional and omitted when empty: an entry that excludes nothing must not
   * carry `"exclude":[]` into a custom value with a length limit.
   */
  exclude?: string[];
  /**
   * 🔴 WHICH RECRUITING GROUP — round 120, item 1.
   *
   * ⚠️ SCOPE CANNOT ANSWER THIS. All five applicant pipelines are
   * caregiver-scope: the two caregiver ones and the three staff ones. So the
   * Recruiting switcher needs a second axis, and this is it.
   *
   * 🔴 WHY A STORED FIELD AND NOT A NAME MATCH OR AN ID LIST:
   *   name match   breaks the day somebody renames a pipeline, and this
   *                account renames things
   *   id list      hardcoded ids are the thing every round since 90 has been
   *                removing
   *   this         an admin sets it once, on the screen that already owns every
   *                other per-pipeline decision, and it survives a rename
   *
   * ⚠️ ABSENT MEANS "caregiver", DELIBERATELY. 187 applicants sit in the two
   * caregiver pipelines and nothing is in the staff ones yet, so an unset
   * pipeline defaulting to caregiver shows the records that exist rather than
   * hiding them behind a setting nobody has touched. The cost is that the
   * three new staff pipelines read as Caregivers until an admin says otherwise
   * — visible, empty, and one dropdown away from correct.
   *
   * ⚠️ ONLY MEANINGFUL WHEN scope IS "caregiver". A client pipeline has no
   * recruiting group and the screen does not offer one.
   */
  group?: "caregiver" | "staff";
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
  /**
   * 🔴 folderId -> NAME, AND THIS IS THE ONLY PLACE A FOLDER NAME CAN LIVE.
   *
   * GoHighLevel will not tell us. `parentName` comes back EMPTY on every field
   * — lib/fieldFolders.ts:491 recorded that in round 55 and verified it live —
   * and `GET /custom-fields/object-key/opportunity` answers 400 "Api does not
   * support objectKey of type contact or opportunity". There is no third way.
   *
   * ⚠️ SO ROUND 93's "label it by the fields inside it" IS NOT A FALLBACK. For
   * a folder this app did not create, it is the only option there has ever
   * been. Round 91 labelled runtime folders by `parentName` — a field this
   * codebase already knew is always empty.
   *
   * We can only record a name when WE are told one: at create time, or when an
   * admin names an existing folder on the Pipelines screen.
   */
  folderNames: Record<string, string>;
}

export const PIPELINE_CONFIG_CUSTOM_VALUE_NAME = "MM Pipeline Folders";

/**
 * 🔴 SEEDED NAMES — FOLDERS **WE** CREATED, WHOSE NAMES WE THEREFORE KNOW.
 *
 * GoHighLevel will not tell us a folder's name (see `folderNames` above), but
 * for a folder this app created there is nothing to ask: we chose the name. It
 * was simply never written down, which is why three "Unnamed section" banners
 * stood on a screen that could have answered all three itself.
 *
 * ⚠️ NAMING IS NOT TICKING. See SEED_TICKED_ON_CLIENT below — they used to be
 * the same list, and that is a bug waiting to happen every time a name is added.
 */
export const SEED_FOLDER_NAMES: Record<string, string> = {
  "1JFUFsjPXNFzMW18dYSe": "Website Intent Form",
  "56mZT4dH0xztuxwgUt00": "Event Details",
  "9OZdxXFfJsdNGR7qsQKQ": "Referral Detail",
};

/**
 * 🔴 TICKED ONTO EVERY CLIENT PIPELINE BY THE SEED — AND ONLY THIS ONE.
 *
 * ⚠️ THIS LIST USED TO BE `Object.keys(SEED_FOLDER_NAMES)`, AND THAT WOULD HAVE
 * BROKEN THE MOMENT A SECOND NAME WAS ADDED. The Website Intent Form is ticked
 * everywhere because its four fields are orphaned on live client records right
 * now — a deliberate, specific act. Event Details and Referral Detail are named
 * for the same reason but must NOT be ticked: Event Cost, Event Date, Event
 * Division and Event Venue on every enrolment record is exactly the all-twelve
 * fall-through this file exists to prevent.
 *
 * Knowing what a folder is called and wanting it on a record are two different
 * questions. One list cannot answer both.
 */
export const SEED_TICKED_ON_CLIENT: string[] = ["1JFUFsjPXNFzMW18dYSe"];

export function emptyPipelineConfig(): StoredPipelineConfig {
  return { seeded: false, pipelines: {}, folderNames: {} };
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
    const scope: PipelineScope | null =
      e.scope === "caregiver"
        ? "caregiver"
        : e.scope === "client"
          ? "client"
          : e.scope === "none"
            ? "none"
            : null;
    // An entry with no valid scope is DROPPED, not defaulted. Defaulting it to
    // "client" is how an applicant pipeline reaches the client board.
    //
    // ⚠️ AND "none" IS A VALID SCOPE, NOT A MISSING ONE — round 116, item K.
    // Reading it as invalid would DROP THE WHOLE ENTRY, taking its folder ticks
    // and its exclusions with it, and the pipeline would silently fall back to
    // Shared-only. An absence of boards is a decision; an absence of an entry is
    // not.
    if (!scope) continue;
    const folders = Array.isArray(e.folders)
      ? e.folders.map((f) => String(f ?? "").trim()).filter(Boolean)
      : [];
    const group = e.group === "staff" ? "staff" : e.group === "caregiver" ? "caregiver" : null;
    const exclude = Array.isArray(e.exclude)
      ? [...new Set(e.exclude.map((f) => String(f ?? "").trim()).filter(Boolean))]
      : [];
    // Omitted when empty — see the field comment. An `exclude: []` on every one
    // of ten pipelines is 150 wasted bytes in a value with a size limit.
    // ⚠️ OMITTED WHEN ABSENT, like `exclude`. A `group` on every entry that
    // has not been decided would make "nobody chose" indistinguishable from
    // "somebody chose caregiver".
    const base: StoredPipelineEntry = { scope, folders };
    if (exclude.length) base.exclude = exclude;
    if (group) base.group = group;
    pipelines[id] = base;
  }
  const folderNames: Record<string, string> = {};
  const fn = rec.folderNames;
  if (fn && typeof fn === "object" && !Array.isArray(fn))
    for (const [id, v] of Object.entries(fn as Record<string, unknown>)) {
      const n = String(v ?? "").trim();
      if (id && n) folderNames[id] = n;
    }
  return { seeded: rec.seeded === true, pipelines, folderNames };
}

export function serialisePipelineConfig(c: StoredPipelineConfig): string {
  return JSON.stringify({
    seeded: c.seeded,
    pipelines: c.pipelines,
    folderNames: c.folderNames || {},
  });
}

/**
 * The recruiting group for one pipeline, defaulting to "caregiver".
 *
 * ⚠️ ONE PLACE, so the default cannot drift. Round 113 broke the caregiver tile
 * and round 114 the client board for the same reason: a rule each consumer had
 * to remember.
 */
export function recruitingGroup(
  c: StoredPipelineConfig | null,
  pipelineId: string,
): "caregiver" | "staff" {
  return c?.pipelines?.[pipelineId]?.group === "staff" ? "staff" : "caregiver";
}

/** Field ids excluded for one pipeline, as a Set. Empty when there are none. */
export function exclusionsFor(
  c: StoredPipelineConfig | null,
  pipelineId: string,
): Set<string> {
  return new Set(c?.pipelines?.[pipelineId]?.exclude ?? []);
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
