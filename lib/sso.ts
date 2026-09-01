import CryptoJS from "crypto-js";

// ---------------------------------------------------------------------------
// Server-only GHL SSO decryption.
//
// GoHighLevel embeds this app as a Custom Page inside an iframe. The frontend
// asks the parent window for the session via postMessage; GHL replies with an
// AES-encrypted blob. That blob is decrypted HERE, server-side, using the app's
// Shared Secret (env var GHL_SSO_SECRET) — the browser never has the secret and
// therefore cannot forge a session.
//
// Based on GHL's official marketplace-app-template `/decrypt-sso` route:
// https://github.com/GoHighLevel/ghl-marketplace-app-template
// CryptoJS.AES.decrypt(blob, secret) handles the OpenSSL "Salted__" key
// derivation (EVP_BytesToKey) that GHL's encryption uses — do not reimplement.
// ---------------------------------------------------------------------------

export interface GhlSession {
  userId: string;
  companyId?: string;
  role?: string; // e.g. "admin" | "user" (exact strings to be confirmed live)
  type?: string; // e.g. "agency" | "location"
  userName?: string;
  email?: string;
  activeLocation?: string;
  // GHL may include more fields; keep them without failing.
  [key: string]: unknown;
}

export class SsoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SsoError";
    this.status = status;
  }
}

// ITEM D — SAY IT OUT LOUD, ONCE.
//
// `ssoConfigured()` returning false does not just disable the SSO handshake: it
// switches off every `enforce` gate that depends on it. The note edit/remove
// gate is the sharpest example — it is author-only ("an admin is not an
// exception"), but the check is `if (enforce && session && …)`, so with no
// secret set there is no session to compare against and ANYONE can edit or
// remove ANY note.
//
// That is the intended open/setup mode locally. In a deployed environment it is
// a silent hole, and silence is the problem: nothing on screen or in the log
// distinguishes "SSO not set up yet" from "SSO env var lost in a redeploy".
// Warned once per process rather than per request, so it cannot be missed in
// the boot log and cannot drown the log at runtime.
//
// Fired at MODULE LOAD, not from inside ssoConfigured(): a request can fail
// before it ever reaches a gate (a missing GHL_PIT answers 500 first), and a
// warning you only get on the happy path is not a startup warning. Importing
// this module at all means the server is about to make permission decisions.
if (typeof process !== "undefined" && !process.env.GHL_SSO_SECRET?.trim()) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n" +
      "  ============================================================\n" +
      "   GHL_SSO_SECRET IS NOT SET — PERMISSION GATES ARE DISABLED\n" +
      "  ============================================================\n" +
      "   No SSO session can be decrypted, so every check that needs\n" +
      "   one is skipped. In particular:\n" +
      "     - note EDIT and REMOVE are open to anyone (normally the\n" +
      "       author only, admins included)\n" +
      "     - admin-only routes (import, pipeline access) do not check\n" +
      "       a role\n" +
      "     - record visibility is not filtered per user\n" +
      "   This is the intended OPEN SETUP MODE for local work. If you\n" +
      "   are seeing this in a deployed environment, set GHL_SSO_SECRET\n" +
      "   (the marketplace app's Shared Secret) NOW.\n" +
      "  ============================================================\n",
  );
}

export function ssoConfigured(): boolean {
  return !!process.env.GHL_SSO_SECRET?.trim();
}

/**
 * Decrypt a GHL SSO blob into the session object. Throws SsoError on any
 * failure (missing secret, wrong secret, malformed blob).
 */
export function decryptSso(blob: string): GhlSession {
  const secret = process.env.GHL_SSO_SECRET?.trim();
  if (!secret) {
    throw new SsoError(
      "SSO is not configured on the server (GHL_SSO_SECRET is missing).",
      500,
    );
  }
  if (!blob || typeof blob !== "string") {
    throw new SsoError("Missing encrypted SSO payload.", 400);
  }

  let text: string;
  try {
    text = CryptoJS.AES.decrypt(blob, secret).toString(CryptoJS.enc.Utf8);
  } catch {
    throw new SsoError("Could not decrypt the SSO payload.", 401);
  }
  if (!text) {
    // Empty output almost always means the Shared Secret is wrong.
    throw new SsoError(
      "SSO decryption produced no output — the Shared Secret is likely wrong.",
      401,
    );
  }

  let data: GhlSession;
  try {
    data = JSON.parse(text) as GhlSession;
  } catch {
    throw new SsoError("Decrypted SSO payload was not valid JSON.", 401);
  }
  if (!data || !data.userId) {
    throw new SsoError("Decrypted SSO payload has no userId.", 401);
  }
  return data;
}
