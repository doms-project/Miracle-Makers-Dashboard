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
