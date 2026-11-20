export const SSO_PROBE_TAG = "[sso-probe]";

export function ssoProbeEnabled(): boolean {
  return (process.env.SSO_PROBE || "").trim() === "1";
}

export function maskEmail(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const at = s.indexOf("@");
  if (at < 1) return "***";
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
}

export function ssoProbeLine(session: Record<string, unknown>): string {
  const payload: Record<string, unknown> = { ...session };
  if ("email" in payload) payload.email = maskEmail(payload.email);
  return `${SSO_PROBE_TAG} ${JSON.stringify({
    at: new Date().toISOString(),
    keys: Object.keys(session).sort(),
    payload,
  })}`;
}
