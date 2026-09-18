/**
 * ═════════════════════════════════════════════════════════════════════════
 * 🔴 TRANSLATE. THE HALF OF A TRANSFER THAT TOUCHES NO NETWORK.
 * ═════════════════════════════════════════════════════════════════════════
 *
 *     translate(record) → parcel        deliver(parcel) → peer ids
 *
 * ⚠️ THE SPLIT IS THE TRUST BOUNDARY, AND IT IS THE WHOLE REASON THIS FILE
 * EXISTS SEPARATELY. Everything difficult about a cross-account transfer — the
 * field map, the option checking, what is skipped and why, where it lands — is
 * decided here, with no credential in scope and nothing that can be written by
 * accident. `deliver` is the only function that holds the other company's
 * token, so making the link one-directional later (a queue the receiving side
 * pulls from, or a parcel it imports) is a swap of ONE function rather than a
 * rewrite. See the report.
 *
 * 🔴 AND IT MEANS THE HARD PART IS TESTABLE WITHOUT A CREDENTIAL. Every
 * assertion about which fields carry, which are skipped and why, and which
 * transfers are refused, is a pure function call.
 *
 * ── THE MAP IS BY NAME, AND NAME IS NOT ENOUGH ─────────────────────────────
 *
 * The probe measured both accounts: 0 RETYPE, 0 NEAR, 0 SPARE — every match is
 * exact or absent, so nothing here needs a human to pair it. But three of the
 * probe's buckets are still live at transfer time, and one of them changes
 * shape:
 *
 *   LOST       55 fields with no counterpart — the OLTL and Private Pay ones,
 *              deliberately absent over there. SKIPPED AND NAMED, never a
 *              failure.
 *   AMBIGUOUS  a name that is not unique on one side. SKIPPED AND NAMED: a
 *              match there is not a match, it is a coin toss placed on every
 *              transfer from now on.
 *   OPTIONS    🔴 THE PROBE ASKS THIS OF THE FIELD; A TRANSFER MUST ASK IT OF
 *              THE VALUE. A dropdown can be missing nine options over there and
 *              still carry this record perfectly, because this record holds the
 *              tenth. So the check is per-value, and a field is only skipped
 *              when THE CODE THIS RECORD ACTUALLY HOLDS has no home.
 *
 * ⚠️ AND THE CODES ARE THE POINT. `getContactCustomFields` carries the rule:
 * values are CODES, not labels — "PAID", "LIVE_IN", "DRIVE_CLIENTS" — and the
 * application forms route on those exact strings. Writing one the destination
 * does not offer breaks its workflows WITH A 200.
 */
import type { EditableFieldDef, OpportunityRecord } from "./types";
import type { PeerFieldDef, PeerPipeline } from "./peer";

/** Where a transfer lands: the same pipeline by name, at its arrival stage. */
export const ARRIVAL_STAGE = /transferred\s*in/i;
/** Where the source record goes: evidence of work done, not a deletion. */
export const DEPARTURE = /transferred\s*out/i;

export type SkipWhy =
  | "no counterpart"
  | "the name is not unique"
  | "a different kind of field"
  | "the value is not offered there";

export interface CarriedField {
  model: "contact" | "opportunity";
  name: string;
  from: string;
  to: string;
}
export interface SkippedField {
  model: "contact" | "opportunity";
  name: string;
  why: SkipWhy;
  detail?: string;
}

export interface Parcel {
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    source: string;
    tags: string[];
    customFields: { id: string; value: unknown }[];
  };
  opportunity: {
    name: string;
    source: string;
    monetaryValue: number;
    customFields: { id: string; value: unknown }[];
  };
  notes: string[];
  carried: CarriedField[];
  skipped: SkippedField[];
}

/** One spelling for a name on both sides. Case, spaces and punctuation only. */
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const PICKLIST = /OPTION|RADIO|CHECKBOX/i;

/**
 * Nothing to carry. An empty value is not a value: writing "" into a field that
 * was never answered is a fact this side does not have.
 */
function emptyish(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
}

function indexByName<T extends { name: string }>(defs: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const d of defs) {
    const k = norm(d.name);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(d);
  }
  return m;
}

/**
 * 🔴 THE TRANSLATION. Pure: no network, no credential, no clock.
 *
 * Only fields this record ACTUALLY HOLDS are considered. A transfer that
 * reported 82 carried fields on a record with nine answers would be counting
 * the map, not the person.
 */
export function translateFields(args: {
  model: "contact" | "opportunity";
  values: Record<string, unknown>;
  selfDefs: EditableFieldDef[];
  peerDefs: PeerFieldDef[];
}): {
  customFields: { id: string; value: unknown }[];
  carried: CarriedField[];
  skipped: SkippedField[];
} {
  const { model, values, selfDefs, peerDefs } = args;
  const selfByName = indexByName(selfDefs);
  const peerByName = indexByName(peerDefs);
  const customFields: { id: string; value: unknown }[] = [];
  const carried: CarriedField[] = [];
  const skipped: SkippedField[] = [];

  for (const def of selfDefs) {
    const value = values[def.id];
    if (emptyish(value)) continue;
    const k = norm(def.name);
    const here = selfByName.get(k) || [];
    const there = peerByName.get(k) || [];

    if (here.length > 1 || there.length > 1) {
      skipped.push({
        model,
        name: def.name,
        why: "the name is not unique",
        detail:
          here.length > 1
            ? `${here.length} fields share this name on this account`
            : `${there.length} fields share this name over there`,
      });
      continue;
    }
    const peer = there[0];
    if (!peer) {
      skipped.push({ model, name: def.name, why: "no counterpart" });
      continue;
    }
    if (norm(peer.dataType) !== norm(def.dataType)) {
      skipped.push({
        model,
        name: def.name,
        why: "a different kind of field",
        detail: `${def.dataType} here, ${peer.dataType} there`,
      });
      continue;
    }
    if (PICKLIST.test(def.dataType)) {
      // 🔴 PER VALUE, NOT PER FIELD. See the header.
      const held = (Array.isArray(value) ? value : [value]).map((v) => String(v));
      const homeless = held.filter(
        (v) => !peer.options.some((o) => norm(o) === norm(v)),
      );
      if (homeless.length) {
        skipped.push({
          model,
          name: def.name,
          why: "the value is not offered there",
          detail: `“${homeless.join("”, “")}” — that field over there offers ${
            peer.options.length ? `“${peer.options.join("”, “")}”` : "no options at all"
          }`,
        });
        continue;
      }
    }
    customFields.push({ id: peer.id, value });
    carried.push({ model, name: def.name, from: def.id, to: peer.id });
  }
  return { customFields, carried, skipped };
}

/** Everything a transfer would send, decided without sending any of it. */
export function translate(args: {
  record: OpportunityRecord;
  contactValues: Record<string, unknown>;
  contactFirst: string;
  contactLast: string;
  /**
   * 🔴 ROUND 133 — FROM THE CONTACT READ, NOT FROM `record.contactEmail`.
   * The opportunity carries a copy of its contact from the SEARCH index, which
   * lags; these are what `/contacts/{id}` currently says. They are also the two
   * fields GoHighLevel requires to create a person at all, so the value that
   * decides whether a transfer is possible must be the live one.
   */
  contactEmail: string;
  contactPhone: string;
  notes: string[];
  selfContactDefs: EditableFieldDef[];
  selfOppDefs: EditableFieldDef[];
  peerContactDefs: PeerFieldDef[];
  peerOppDefs: PeerFieldDef[];
}): Parcel {
  const c = translateFields({
    model: "contact",
    values: args.contactValues,
    selfDefs: args.selfContactDefs,
    peerDefs: args.peerContactDefs,
  });
  const o = translateFields({
    model: "opportunity",
    values: args.record.cf || {},
    selfDefs: args.selfOppDefs,
    peerDefs: args.peerOppDefs,
  });
  return {
    contact: {
      firstName: args.contactFirst,
      lastName: args.contactLast,
      email: args.contactEmail,
      phone: args.contactPhone,
      // ⚠️ THE SOURCE IS REWRITTEN, NOT COPIED. "Facebook lead form" on the
      // receiving account would be false: this person arrived there by
      // transfer, and where they originally came from is in the notes.
      source: "Transfer",
      tags: args.record.tags || [],
      customFields: c.customFields,
    },
    opportunity: {
      name: args.record.oppName || `${args.contactFirst} ${args.contactLast}`.trim(),
      source: "Transfer",
      monetaryValue: args.record.monetaryValue || 0,
      customFields: o.customFields,
    },
    notes: args.notes,
    carried: [...c.carried, ...o.carried],
    skipped: [...c.skipped, ...o.skipped],
  };
}

export interface Refusal {
  error: string;
  detail: string;
}

/**
 * 🔴 WHERE IT LANDS — THE SAME PIPELINE BY NAME, AT ITS ARRIVAL STAGE.
 *
 * ⚠️ NOT THE SENDING STAGE, and the reasoning is the point rather than the
 * rule: a case arriving at WAITING FOR DOCS asserts progress the receiving
 * company has not verified. They have not seen the documents. An arrival tray
 * is the honest destination and the only one that does not put a stranger's
 * word in their pipeline.
 *
 * ⚠️ AND IT REFUSES RATHER THAN PICKING THE NEAREST — twice. A "nearest
 * pipeline" match moves somebody's case into the wrong business line; a
 * fallback to the first stage files a transfer as a fresh enquiry. Round 126
 * is the standing lesson here: a fallback that lands on plausible behaviour
 * hides its own failure.
 */
export function arrivalIn(
  pipelineName: string,
  peer: PeerPipeline[],
): { pipelineId: string; pipelineName: string; stageId: string; stageName: string } | Refusal {
  const want = norm(pipelineName);
  const hits = peer.filter((p) => norm(p.name) === want);
  if (hits.length !== 1)
    return {
      error: hits.length
        ? `There is more than one “${pipelineName}” over there.`
        : `There is no “${pipelineName}” pipeline over there.`,
      detail: `A transfer lands in the pipeline of the same name and will not pick the nearest one. ${
        peer.length
          ? `That account has: ${peer.map((p) => `“${p.name}”`).join(", ")}.`
          : "No pipelines could be read from that account at all."
      }`,
    };
  const pipe = hits[0];
  const stage = [...pipe.stages]
    .sort((a, b) => a.position - b.position)
    .find((s) => ARRIVAL_STAGE.test(s.name));
  if (!stage)
    return {
      error: `“${pipe.name}” over there has no arrival stage.`,
      detail: `A transfer lands at TRANSFERRED IN, never at the stage it left — the receiving company has not verified the work behind it. That pipeline's stages are: ${
        pipe.stages.map((s) => `“${s.name}”`).join(", ") || "(none)"
      }.`,
    };
  return { pipelineId: pipe.id, pipelineName: pipe.name, stageId: stage.id, stageName: stage.name };
}

/**
 * 🔴 WHERE THE SOURCE GOES — AND IT IS NOT DELETED.
 *
 * The record is evidence of work done: who worked it, for how long, what was
 * said. Deleting it to tidy the board destroys the only account of that work
 * either company will ever have.
 *
 * ⚠️ A PIPELINE FIRST, THEN A STAGE. Whether "Transferred Out" was set up as
 * its own pipeline or as a stage inside each existing one is an operator's
 * choice made in GoHighLevel, not a fact this code gets to assume.
 */
export function departureFrom(
  selfPipes: { id: string; name: string; stages: { id: string; name: string; position?: number }[] }[],
  currentPipelineId: string,
): { pipelineId: string; stageId: string; label: string } | Refusal {
  const pipe = selfPipes.find((p) => DEPARTURE.test(p.name));
  if (pipe) {
    const stage = [...pipe.stages].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0),
    )[0];
    if (stage) return { pipelineId: pipe.id, stageId: stage.id, label: `${pipe.name} · ${stage.name}` };
  }
  const here = selfPipes.find((p) => p.id === currentPipelineId);
  const stage = here?.stages.find((s) => DEPARTURE.test(s.name));
  if (stage && here)
    return { pipelineId: here.id, stageId: stage.id, label: `${here.name} · ${stage.name}` };
  return {
    error: "This account has nowhere to file a transferred-out record.",
    detail:
      "A transfer closes the case here by moving it to Transferred Out — it is never deleted, because the record is the evidence of the work done on it. Create a “Transferred Out” pipeline, or a “Transferred Out” stage in this pipeline, in GoHighLevel first.",
  };
}

export function isRefusal(x: unknown): x is Refusal {
  return !!x && typeof x === "object" && "error" in (x as Refusal);
}

/**
 * The note left on BOTH sides. One sentence of provenance is what makes the
 * trail followable by a person who has only one of the two accounts open.
 */
export function trailNote(p: {
  direction: "out" | "in";
  otherLabel: string;
  otherId: string;
  who: string;
  carried: number;
  skipped: SkippedField[];
}): string {
  const head =
    p.direction === "out"
      ? `Transferred to ${p.otherLabel} by ${p.who}. Their record id: ${p.otherId}.`
      : `Transferred in from ${p.otherLabel}. Their record id: ${p.otherId}. Sent by ${p.who}.`;
  const lines = [
    head,
    `${p.carried} field${p.carried === 1 ? "" : "s"} carried across.`,
  ];
  if (p.skipped.length)
    lines.push(
      `${p.skipped.length} not carried: ${p.skipped
        .map((s) => `${s.name} (${s.why})`)
        .join("; ")}.`,
    );
  // ⚠️ ON BOTH COPIES OF THE NOTE, because the receiving company needs to know
  // what they were NOT sent quite as much as the sending one needs a record of
  // what it kept.
  lines.push(
    "Conversation history, appointments and file attachments do not transfer between accounts and remain on the original record.",
  );
  return lines.join("\n");
}
