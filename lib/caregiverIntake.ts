// ---------------------------------------------------------------------------
// CAREGIVER INTAKE — the vocabulary, and the one rule that resolves it.
//
// 🔴 DIVISION AND PIPELINE CAN DISAGREE, so only one of them is asked.
//
// Asking both invites a contradiction nobody can resolve: an applicant marked
// PRIVATE_PAY sitting in ODP DSP Applicant is either a mis-tick or a deliberate
// exception, and the record cannot say which. So the form asks for the DIVISION
// — the thing the recruiter actually knows about the person — and SHOWS which
// pipeline it lands in. One question, one answer, and the consequence visible
// before it is committed.
//
// ⚠️ ISOMORPHIC. The dialog shows the destination as you choose, the route
// resolves it again on the way in. Two copies of this mapping would drift, and
// the day they drift is the day an applicant is filed against the wrong job.
// ---------------------------------------------------------------------------

export const CG_DIVISIONS = [
  "PRIVATE_PAY",
  "OLTL_CHC",
  "ODP",
  "REJECTED",
] as const;
export type CgDivision = (typeof CG_DIVISIONS)[number];

export const CG_WORK_STATES: readonly string[] = ["PA", "NEARBY", "NO"];

/** How each division reads on screen. */
export const CG_DIVISION_LABELS: Record<CgDivision, string> = {
  PRIVATE_PAY: "Private Pay",
  OLTL_CHC: "OLTL / CHC",
  ODP: "ODP",
  REJECTED: "Rejected",
};

export const CG_WORK_STATE_LABELS: Record<string, string> = {
  PA: "PA — works in Pennsylvania",
  NEARBY: "Nearby — outside PA but close",
  NO: "No — cannot work in PA",
};

/**
 * Match a pipeline by NAME, never by a hardcoded id.
 *
 * ⚠️ Ids differ per account and a pipeline recreated in GoHighLevel keeps its
 * name and changes its id — report 86 recorded what that does. Names are the
 * stable half.
 */
const MATCHERS: Record<CgDivision, RegExp | null> = {
  PRIVATE_PAY: /\bpp\b|private\s*pay/i,
  ODP: /\bodp\b/i,
  // 🔴 NOTHING MATCHES THIS, AND THAT IS THE POINT. The caregiver form's
  // DEFAULT branch routes to OLTL_CHC — where family caregivers go — and no
  // pipeline has ever existed for it. lib/ghl.ts:549 has said "A THIRD IS
  // COMING" since round 13. Until it does, an OLTL_CHC applicant has nowhere
  // to land, and the form says so rather than filing them somewhere plausible.
  OLTL_CHC: /oltl|chc/i,
  // Not a pipeline at all — a contact and nothing else.
  REJECTED: null,
};

export interface DivisionRouting {
  /** Caregiver pipelines this division may land in, in config order. */
  pipelines: { id: string; name: string }[];
  /** Said on screen when there is no destination. */
  why: string;
  /** True when the division deliberately creates no opportunity. */
  contactOnly: boolean;
}

export function pipelineForDivision(
  division: CgDivision,
  caregiverPipelines: { id: string; name: string }[],
): DivisionRouting {
  if (division === "REJECTED")
    return {
      pipelines: [],
      why: "Rejected applicants are recorded as a contact only, so a second application can be recognised as one. There is no pipeline they belong in.",
      contactOnly: true,
    };

  const re = MATCHERS[division];
  const hits = re ? caregiverPipelines.filter((p) => re.test(p.name)) : [];
  if (hits.length) return { pipelines: hits, why: "", contactOnly: false };

  return {
    pipelines: [],
    why:
      division === "OLTL_CHC"
        ? "No caregiver pipeline exists for OLTL / CHC yet — the caregiver form's default branch routes here and nothing receives it. Create one under Admin → Pipelines with scope “caregiver”, or choose a division that has one."
        : `No caregiver pipeline matches ${CG_DIVISION_LABELS[division]}. Create one under Admin → Pipelines with scope “caregiver”.`,
    contactOnly: false,
  };
}
