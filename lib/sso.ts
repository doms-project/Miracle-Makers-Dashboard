import CryptoJS from "crypto-js";

export interface GhlSession {
  userId: string;
  companyId?: string;
  role?: string;
  type?: string;
  userName?: string;
  email?: string;
  activeLocation?: string;

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
