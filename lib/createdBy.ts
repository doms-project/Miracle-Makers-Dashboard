export interface CreatedBySource {
  sourceType: string;
  sourceValue: string;
  sourceUserId: string;

  sourceId?: string;
}

const KNOWN: Record<string, string> = {

  workflownew: "Workflow",
  bulkaction: "Bulk action",
  integration: "Integration",
};

const key = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const INITIALISMS = new Set(["api", "crm", "sms", "url", "id", "csv", "ui"]);

export function humaniseSource(raw: string): string {
  const words = (raw || "")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .map((w, i) => {
      const low = w.toLowerCase();
      if (INITIALISMS.has(low)) return low.toUpperCase();

      return i === 0 ? low.charAt(0).toUpperCase() + low.slice(1) : low;
    })
    .join(" ");
}

export function createdByLabel(
  src: CreatedBySource,
  nameOf: (userId: string) => string,
): string {
  if (!src || (!src.sourceValue && !src.sourceUserId && !src.sourceType)) return "";

  if (src.sourceUserId) {
    const who = nameOf(src.sourceUserId);

    return who || "Former user";
  }

  const k = key(src.sourceValue);

  if (KNOWN[k]) return KNOWN[k];

  if (k.includes("workflow")) return "Workflow";

  const human = humaniseSource(src.sourceValue);
  if (human) return human;

  return humaniseSource(src.sourceType);
}
