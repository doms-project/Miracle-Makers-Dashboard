export function normalizeTag(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const AUTOMATION_TAGS = [
  "chc",
  "facebook-ad",
  "private-pay-lp",
  "website-intent-form",
  "disqualified-mm-intent-form",
  "indeed-import",
] as const;

export const SOURCE_TAGS = ["indeed", "facebook", "google-ads", "website"] as const;

export type BatchTagCheck = {

  tag: string;

  error: string | null;
};

export function checkBatchTag(raw: string): BatchTagCheck {
  const tag = normalizeTag(raw);
  if (!tag) return { tag: "", error: null };

  if ((AUTOMATION_TAGS as readonly string[]).includes(tag))
    return { tag, error: "That tag starts an automation. Choose a different one." };

  if ((SOURCE_TAGS as readonly string[]).includes(tag))
    return {
      tag,
      error:
        "That is a source value, and source is already its own field on every record. Choose a different one.",
    };

  if (tag.length > 64)
    return { tag, error: "Too long for a tag — keep it under 64 characters." };

  return { tag, error: null };
}
