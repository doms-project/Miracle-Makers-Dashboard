import {
  findContactByEmailOrPhone,
  getContactCustomFields,
  listContactOpportunities,
  lookupDuplicateContact,
  createContact,
  GhlError,
} from "@/lib/ghl";
import { existingPersonSentence, caseClause } from "@/lib/peopleSearch";

export interface ExistingPersonRefusal {
  error: string;
  detail: string;
  status: 409;

  refusal: true;
  existing: {
    id: string;
    name: string;

    recordType: string;
    caseLabel: string;
    matchedOn: "email" | "phone";

    atEvent: string;

    via?: "refusal" | "lookup" | "search";
  };
}

export async function checkExistingPerson(args: {
  phone?: string;
  email?: string;

  recordTypeFieldId?: string;

  eventFieldId?: string;
}): Promise<ExistingPersonRefusal | null> {
  const phone = (args.phone || "").trim();
  const email = (args.email || "").trim();
  if (!phone && !email) return null;

  const match = await findContactByEmailOrPhone({ phone, email });
  if (!match) return null;

  let recordType = "";
  let atEvent = "";
  try {
    const read = await getContactCustomFields(match.id);
    if (args.recordTypeFieldId) {
      const v = read.values[args.recordTypeFieldId];
      recordType = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
    }
    if (args.eventFieldId) atEvent = String(read.values[args.eventFieldId] ?? "").trim();
  } catch {
    recordType = "";
  }

  let caseLabel = "";
  try {
    caseLabel = caseClause(await listContactOpportunities(match.id));
  } catch {
    caseLabel = "";
  }

  return {
    error: existingPersonSentence(match.matchedOn, {
      id: match.id,
      name: match.name,
      recordType,
      caseLabel,
    }),

    detail: atEvent
      ? `They are already recorded at another event (${atEvent}). Nothing was created or changed.`
      : "Nothing was created or changed.",
    status: 409,
    refusal: true,
    existing: {
      id: match.id,
      name: match.name,
      recordType,
      caseLabel,
      matchedOn: match.matchedOn,
      atEvent,
    },
  };
}

const DUPLICATE_RULE = /duplicated\s+contacts|DUPLICATED_CONTACT|duplicate\s+contact/i;

export function isDuplicateRefusal(e: unknown): boolean {
  if (!(e instanceof GhlError)) return false;
  return DUPLICATE_RULE.test(`${e.code || ""} ${e.message} ${e.detail || ""}`);
}

export type CreatePersonResult =
  | { ok: true; id: string }
  | { ok: false; conflict: ExistingPersonRefusal };

export async function createPersonOrConflict(
  fields: Parameters<typeof createContact>[0] & { phone?: string; email?: string },
): Promise<CreatePersonResult> {
  try {
    const made = await createContact(fields);
    return { ok: true, id: made.id };
  } catch (e) {
    if (!isDuplicateRefusal(e)) throw e;

    const phone = (fields.phone || "").trim();
    const email = (fields.email || "").trim();
    const err = e instanceof GhlError ? e : null;
    let id = err?.dupContactId || "";

    let name = err?.dupName || "";
    let via: "refusal" | "lookup" | "search" | "none" = id ? "refusal" : "none";

    const field = (err?.dupField || "").toLowerCase();
    const matchedOn: "phone" | "email" = field.includes("email")
      ? "email"
      : field.includes("phone")
        ? "phone"
        : phone
          ? "phone"
          : "email";

    if (!id) {
      const dup = await lookupDuplicateContact({ phone, email });
      if (dup) {
        id = dup.id;
        name = dup.name;
        via = "lookup";
      }
    }
    if (!id) {
      const hit = await findContactByEmailOrPhone({ phone, email }).catch(() => null);
      if (hit) {
        id = hit.id;
        name = hit.name;
        via = "search";
      }
    }

    if (!id)
      return {
        ok: false,
        conflict: {

          error:
            `${matchedOn === "phone" ? "That phone number" : "That email address"} already ` +
            "belongs to somebody in GoHighLevel. Nothing was created.",
          detail:
            "GoHighLevel refused the new contact because the " +
            `${matchedOn === "phone" ? "number" : "address"} is already in use, and the ` +
            "matching person could not be looked up — a contact created in the last " +
            "minute is not searchable yet. Search for them in GoHighLevel and add the " +
            "event, referral or application to that record.",
          status: 409,
          refusal: true,
          existing: {
            id: "",
            name: "",
            recordType: "",
            caseLabel: "",
            matchedOn,
            atEvent: "",
          },
        },
      };

    const full = await describeExisting({ id, name, matchedOn });
    return {
      ok: false,
      conflict: {
        ...full,
        existing: { ...full.existing, via: via === "none" ? undefined : via },
      },
    };
  }
}

async function describeExisting(m: {
  id: string;
  name: string;
  matchedOn: "phone" | "email";
}): Promise<ExistingPersonRefusal> {
  let recordType = "";
  let name = m.name;
  try {
    const read = await getContactCustomFields(m.id);

    if (!name) name = `${read.firstName} ${read.lastName}`.trim();
    const defs = await import("@/lib/ghl").then((g) => g.getEditableFieldDefs("contact"));
    const rt = defs.find(
      (d) => d.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "recordtype",
    );
    if (rt) {
      const v = read.values[rt.id];
      recordType = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
    }
  } catch {
    recordType = "";
  }
  let caseLabel = "";
  try {
    caseLabel = caseClause(await listContactOpportunities(m.id));
  } catch {
    caseLabel = "";
  }
  return {
    error: existingPersonSentence(m.matchedOn, {
      id: m.id,
      name,
      recordType,
      caseLabel,
    }),
    detail: "Nothing was created or changed.",
    status: 409,
    refusal: true,
    existing: {
      id: m.id,
      name,
      recordType,
      caseLabel,
      matchedOn: m.matchedOn,
      atEvent: "",
    },
  };
}
