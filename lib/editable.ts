export const READ_ONLY_FIELDS: string[] = [

  "APP - Compliance Cleared",

  "CG - Compliance Cleared",

  "Transferred From",
  "Transferred Date",

  "Caregiver Name",

  "Reassign Followers",

  "Case Manager",

  "Case Manager Followers",

  "Stage History",

  "First Opened",

  "Sorted From New Leads",
];

const USER_ID_LIST_FIELDS = ["Case Manager Followers", "Reassign Followers"];

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const USER_ID_LIST_SET = new Set(USER_ID_LIST_FIELDS.map(norm));

export function isUserIdListField(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return USER_ID_LIST_SET.has(norm(fieldName));
}

const READ_ONLY_SET = new Set(READ_ONLY_FIELDS.map(norm));

export function isFieldEditable(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return !READ_ONLY_SET.has(norm(fieldName));
}
