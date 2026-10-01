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
  /**
   * ═══ ROUND 170 — `group` IS NEW, AND IT IS WHY OLTL APPLICANTS WENT TO STAFF
   *
   * 🔴 LIVE: Add Applicant with division OLTL_CHC filed into **OLTL Staff
   * Applicants**, not OLTL Caregiver Applicants. The website form routes
   * correctly; only the dashboard got it wrong.
   *
   * The cause is one regex against one list. `MATCHERS.OLTL_CHC` is
   * `/oltl|chc/i`, and the caller passes every CAREGIVER-SCOPE pipeline —
   * which on this account includes BOTH "OLTL Caregiver Applicants" and "OLTL
   * Staff Applicants". Both match; the first in config order wins; it was the
   * staff one.
   *
   * ⚠️ SCOPE AND GROUP ARE DIFFERENT QUESTIONS, and that is the whole bug.
   * Scope says which board picker lists a pipeline ("caregiver"), so a staff
   * pipeline is correctly caregiver-SCOPED. Group says which KIND of recruit it
   * holds, and a caregiver applicant must never land in a staff one. Round 120
   * added `group` for exactly this distinction and this function never saw it.
   *
   * 🔴 THE EXCLUSION IS HERE RATHER THAN AT THE CALLER so a second caller
   * inherits it. "Never offer a Staff-group pipeline for a caregiver applicant"
   * is a property of the routing, not of one route's bookkeeping.
   */
  caregiverPipelines: { id: string; name: string; group?: "caregiver" | "staff" }[],
): DivisionRouting {
  if (division === "REJECTED")
    return {
      pipelines: [],
      why: "Rejected applicants are recorded as a contact only, so a second application can be recognised as one. There is no pipeline they belong in.",
      contactOnly: true,
    };

  // 🔴 STAFF PIPELINES ARE REMOVED BEFORE THE NAME IS EVEN LOOKED AT. Filtering
  // after the regex would still have let a staff pipeline be the only hit and
  // then be chosen; dropping them first means the name match runs over the only
  // population a caregiver applicant may land in.
  //
  // ⚠️ `group` ABSENT MEANS "caregiver" — the default `recruitingGroup` sets,
  // and the same default the stored config omits rather than writes out. An
  // unconfigured pipeline is a caregiver one, which is what every account had
  // before round 120.
  const eligible = caregiverPipelines.filter((p) => p.group !== "staff");
  const re = MATCHERS[division];
  const hits = re ? eligible.filter((p) => re.test(p.name)) : [];
  if (hits.length) return { pipelines: hits, why: "", contactOnly: false };

  // ⚠️ AND IF A STAFF PIPELINE WOULD HAVE MATCHED, SAY SO. "No caregiver
  // pipeline matches OLTL / CHC" on an account that visibly has an OLTL
  // pipeline reads as a fault in the dashboard. Naming the reason sends whoever
  // reads it to the Pipelines screen, which is where the fix is.
  const staffWouldHaveMatched = re
    ? caregiverPipelines.filter((p) => p.group === "staff" && re.test(p.name))
    : [];
  if (staffWouldHaveMatched.length)
    return {
      pipelines: [],
      why: `${staffWouldHaveMatched.map((p) => `“${p.name}”`).join(" and ")} matches ${CG_DIVISION_LABELS[division]} but is a STAFF pipeline, so a caregiver applicant must not be filed there. Create a caregiver pipeline for this division, or change that pipeline's recruiting group under Admin → Pipelines.`,
      contactOnly: false,
    };

  return {
    pipelines: [],
    why:
      division === "OLTL_CHC"
        ? "No caregiver pipeline exists for OLTL / CHC yet — the caregiver form's default branch routes here and nothing receives it. Create one under Admin → Pipelines with scope “caregiver”, or choose a division that has one."
        : `No caregiver pipeline matches ${CG_DIVISION_LABELS[division]}. Create one under Admin → Pipelines with scope “caregiver”.`,
    contactOnly: false,
  };
}
