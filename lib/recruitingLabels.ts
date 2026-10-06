// ---------------------------------------------------------------------------
// ROUND 175 · ITEM 2 — ODP CALLS THEM DSPs.
//
// 🔴 PURE, AND NOT INLINE IN THE COMPONENT. Round 167 reverted an inline
// `useMemo` and the proof came back GREEN — rule 10. Wording a proof must be
// able to check does not live inside JSX.
//
// ⚠️ LABELS ONLY. Nothing here changes which pipelines a viewer holds, which
// records they see, or what is written. "DSP" is what ODP calls the same role
// OLTL calls a caregiver; the grouping underneath is untouched.
// ---------------------------------------------------------------------------
import { divisionLabel } from "./division";

/**
 * Is every recruiting pipeline this viewer holds an ODP one?
 *
 * 🔴 EVERY, AND AT LEAST ONE. A viewer with OLTL and ODP sees the OLTL wording,
 * because "DSP" would be wrong for half their board — and a viewer with NO
 * recruiting pipelines is not ODP-only, they are nothing-only. An `every()` on
 * an empty array is `true`, which is exactly the trap here.
 */
export function isOdpOnlyRecruiting(pipelineNames: string[]): boolean {
  const divs = pipelineNames
    .map((n) => divisionLabel(n).toUpperCase())
    .filter(Boolean);
  if (!divs.length) return false;
  return divs.every((d) => d === "ODP" || d.startsWith("ODP "));
}

export type RecruitingGroup = "caregiver" | "staff" | "all";

export interface RecruitingNouns {
  /** The menu's own word for this choice — so the control shows what it offered. */
  group: string;
  one: string;
  many: string;
  /** What a PIPELINE in this group is called, which is not what a RECORD is called. */
  pipelines: string;
}

export function recruitingNouns(
  group: RecruitingGroup,
  odpOnly: boolean,
): RecruitingNouns {
  if (group === "staff")
    return {
      group: "Office staff",
      one: "staff applicant",
      many: "staff applicants",
      pipelines: "staff",
    };
  if (group === "all")
    return { group: "All", one: "applicant", many: "applicants", pipelines: "recruiting" };
  // ⚠️ "DSPs" / "Caregivers" IS THE ONLY THING odpOnly CHANGES. The record noun
  // stays "applicant" in both: an applicant is an applicant whichever programme
  // they applied to, and only the ROLE has two names.
  return {
    group: odpOnly ? "DSPs" : "Caregivers",
    one: "applicant",
    many: "applicants",
    pipelines: "applicant",
  };
}

export interface RecruitingOption {
  key: RecruitingGroup;
  label: string;
  hint: string;
}

/** The group picker's three choices, in order. */
export function recruitingGroupOptions(odpOnly: boolean): RecruitingOption[] {
  return [
    {
      key: "caregiver",
      label: odpOnly ? "DSP applicants" : "Caregiver applicants",
      hint: "the applicant pipelines",
    },
    { key: "staff", label: "Office staff applicants", hint: "the staff pipelines" },
    { key: "all", label: "All applicants", hint: "everything in recruiting" },
  ];
}
