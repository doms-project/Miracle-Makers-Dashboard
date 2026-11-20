import type { EditableFieldDef, OpportunityRecord } from "./types";
import type { PeerFieldDef, PeerPipeline } from "./peer";

export const ARRIVAL_STAGE = /transferred\s*in/i;

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

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const PICKLIST = /OPTION|RADIO|CHECKBOX/i;

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

export function translate(args: {
  record: OpportunityRecord;
  contactValues: Record<string, unknown>;
  contactFirst: string;
  contactLast: string;

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

  lines.push(
    "Conversation history, appointments and file attachments do not transfer between accounts and remain on the original record.",
  );
  return lines.join("\n");
}
