// The normalized shape the frontend expects. One object per OLTL opportunity.
export interface OpportunityRecord {
  id: string;
  first: string;
  last: string;
  stage: string; // pipeline stage name
  harmony: string; // Harmony ID (custom field)
  countyId: string; // County ID (custom field)
  office: string; // Office (custom field)
  county: string; // County (custom field)
  block: string; // Road Blocker (custom field); "None" when empty
  ref: string; // Referral Source (custom field)
  src: string; // Source (custom field)
  rep: string; // owner / assigned user name
  asst: string; // Sales Rep Assistant (custom field)
  cm: string; // Case Manager (custom field)
  onb: string; // Onboarding Rep (custom field)
  cg: string; // Caregiver (custom field)
  checked: boolean; // "Checked this week" (custom field)
}

export interface Note {
  who: string;
  when: string;
  txt: string;
}

export interface OpportunitiesResponse {
  records: OpportunityRecord[];
  pipeline: { id: string; name: string } | null;
  count: number;
}

export interface ApiError {
  error: string;
  detail?: string;
  status?: number;
}
