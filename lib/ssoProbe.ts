// ---------------------------------------------------------------------------
// ROUND 179 · THE SSO ROLE PROBE — WHAT GOHIGHLEVEL ACTUALLY SENDS, PER PERSON.
//
// 🔴 THE QUESTION: does the Agency Owner get the same access in this dashboard
// as an Agency Admin and a Sub-account Admin?
//
// Every access decision here hangs off ONE string, the SSO `role`
// (lib/visibility.ts → isAdminRole; "admin" only until round 180, "admin" or "owner" since). GHL's docs disagree with
// themselves about what an owner carries: the marketplace user-context page
// shows an owner as `role: "admin", isAgencyOwner: true`, while the help
// article on the Agency Owner role says the backend role was changed from
// admin to OWNER. Only a real payload settles it, and the payload only exists
// inside a real GoHighLevel session — so it is captured where it is decrypted.
//
// ⚠️ OFF UNLESS `SSO_PROBE=1`. When on, /api/decrypt-sso writes ONE log line
// per page load: the decrypted payload's keys and values. It never writes the
// encrypted blob — that is a bearer credential — and the email is masked.
// `scripts/sso-roles-probe.mjs --logs <file>` reads these lines back.
//
// Turn it off again when the five sessions are captured. It changes nothing
// about any decision; it only writes down what the decisions were made from.
// ---------------------------------------------------------------------------

export const SSO_PROBE_TAG = "[sso-probe]";

export function ssoProbeEnabled(): boolean {
  return (process.env.SSO_PROBE || "").trim() === "1";
}

/** "jack@miraclemakers.com" → "ja***@miraclemakers.com". Enough to tell people apart. */
export function maskEmail(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return "";
  const at = s.indexOf("@");
  if (at < 1) return "***";
  return `${s.slice(0, Math.min(2, at))}***${s.slice(at)}`;
}

/**
 * One log line for one decrypted session.
 *
 * 🔴 TAKES THE DECRYPTED OBJECT, NEVER THE BLOB. There is no parameter through
 * which the credential could reach the log.
 *
 * ⚠️ EVERY KEY IS KEPT, including ones this app does not read today
 * (`isAgencyOwner`, `region`, …). GHL adds fields to this payload over time,
 * and the point of the probe is to see all of them.
 */
export function ssoProbeLine(session: Record<string, unknown>): string {
  const payload: Record<string, unknown> = { ...session };
  if ("email" in payload) payload.email = maskEmail(payload.email);
  return `${SSO_PROBE_TAG} ${JSON.stringify({
    at: new Date().toISOString(),
    keys: Object.keys(session).sort(),
    payload,
  })}`;
}
