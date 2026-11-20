export const CG_DIVISIONS = [
  "PRIVATE_PAY",
  "OLTL_CHC",
  "ODP",
  "REJECTED",
] as const;
export type CgDivision = (typeof CG_DIVISIONS)[number];

export const CG_WORK_STATES: readonly string[] = ["PA", "NEARBY", "NO"];

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

const MATCHERS: Record<CgDivision, RegExp | null> = {
  PRIVATE_PAY: /\bpp\b|private\s*pay/i,
  ODP: /\bodp\b/i,

  OLTL_CHC: /oltl|chc/i,

  REJECTED: null,
};

export interface DivisionRouting {

  pipelines: { id: string; name: string }[];

  why: string;

  contactOnly: boolean;
}

export function pipelineForDivision(
  division: CgDivision,

  caregiverPipelines: { id: string; name: string; group?: "caregiver" | "staff" }[],
): DivisionRouting {
  if (division === "REJECTED")
    return {
      pipelines: [],
      why: "Rejected applicants are recorded as a contact only, so a second application can be recognised as one. There is no pipeline they belong in.",
      contactOnly: true,
    };

  const eligible = caregiverPipelines.filter((p) => p.group !== "staff");
  const re = MATCHERS[division];
  const hits = re ? eligible.filter((p) => re.test(p.name)) : [];
  if (hits.length) return { pipelines: hits, why: "", contactOnly: false };

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
