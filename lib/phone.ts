export interface PhoneResult {

  value: string;

  unnormalised: boolean;
}

export function e164(input: unknown): PhoneResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { value: "", unnormalised: false };

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return { value: `+1${digits}`, unnormalised: false };
  if (digits.length === 11 && digits.startsWith("1"))
    return { value: `+${digits}`, unnormalised: false };

  return { value: raw, unnormalised: true };
}

export function phoneKey(input: unknown): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length < 10) return "";

  return digits.slice(-10);
}

export function emailKey(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

export function nameKey(...parts: unknown[]): string {
  return parts
    .map((p) => String(p ?? ""))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
