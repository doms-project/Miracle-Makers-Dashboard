import { divisionLabel } from "./division";

export function isOdpOnlyRecruiting(pipelineNames: string[]): boolean {
  const divs = pipelineNames
    .map((n) => divisionLabel(n).toUpperCase())
    .filter(Boolean);
  if (!divs.length) return false;
  return divs.every((d) => d === "ODP" || d.startsWith("ODP "));
}

export type RecruitingGroup = "caregiver" | "staff" | "all";

export interface RecruitingNouns {

  group: string;
  one: string;
  many: string;

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
