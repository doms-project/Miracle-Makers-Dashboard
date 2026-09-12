import { useEffect, useState } from "react";

// Client-side GHL SSO handshake. Asks the parent (GHL) window for the session
// via postMessage, receives an encrypted blob, and has the server decrypt it.
// The decrypted session is used for display; the still-encrypted `blob` is what
// gets sent to /api/opportunities so the SERVER re-derives identity (the client
// is never trusted to state its own role/userId).

export interface ViewerSession {
  userId: string;
  role: string | null;
  activeLocation: string | null;
  userName: string | null;
  email: string | null;
  companyId: string | null;
  type: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 TWO FACTS, NOT ONE — AND CONFLATING THEM CAUSED BUGS IN BOTH DIRECTIONS.
//
// This state machine used to expose `blob` ONLY on `ready`, so a caller could
// not tell "the blob has arrived" from "the blob has been decrypted for
// display". Those are different moments separated by a full round trip, and the
// codebase got it wrong in each direction at once:
//
//   TOO EARLY  the Referrals section read `status === "ready" ? blob : null`,
//              fired with null while the decrypt was in flight, and every
//              visitor got a 401 error card that vanished a moment later
//              (analysis 104, finding 12).
//
//   TOO LATE   report 81 §3.1 — the client board WAITS for the decrypted
//              session before requesting data, even though /api/opportunities
//              decrypts the same blob itself, server-side, on every request.
//              The decrypted copy is used only to render "Signed in as …".
//              A whole RTT is spent before anything is asked for.
//
// ⚠️ ONE CAUSE, ONE FIX. `blob` is now surfaced the instant it arrives, on every
// branch. A loader that only needs to AUTHENTICATE waits for the blob; a UI that
// needs the viewer's NAME waits for `ready`. Nothing waits for the wrong one.
//
// 🔴 NO ACCESS IMPLICATION, and that is the point: the server re-derives
// identity from the blob on every request and never trusts the client's copy.
// Sending it a millisecond earlier changes nothing about who may see what.
// ═══════════════════════════════════════════════════════════════════════════

export type SsoState =
  | { status: "loading"; blob: string | null }
  | { status: "ready"; session: ViewerSession; blob: string }
  | { status: "none"; reason: string; blob: string | null };

/**
 * Has the handshake produced its final answer for DATA purposes?
 *
 * True once there is a blob to authenticate with, or once we know there will
 * never be one. ⚠️ A loader gated on this fires ONCE: either with a real blob,
 * or — when the parent never answers — with null, so the 401 is the settled
 * state of the screen rather than a flash on the way to the real one.
 */
export function ssoResolved(s: SsoState): boolean {
  return s.blob !== null || s.status === "none";
}

/** The blob to send, or null when there is none to send. */
export function ssoBlob(s: SsoState): string | null {
  return s.blob;
}

export function useGhlSession(timeoutMs = 4000): SsoState {
  const [state, setState] = useState<SsoState>({ status: "loading", blob: null });

  useEffect(() => {
    let settled = false;

    const onMessage = async (e: MessageEvent) => {
      const data = e.data as { message?: string; payload?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.message !== "REQUEST_USER_DATA_RESPONSE") return;
      if (settled) return;
      settled = true;
      const blob = data.payload || "";
      // 🔴 PUBLISHED IMMEDIATELY. Everything below is about the DISPLAY copy;
      // the blob itself is complete right here, and every data request in the
      // app authenticates with it rather than with the decrypted session.
      if (blob) setState((prev) => ({ ...prev, blob }));
      try {
        const res = await fetch("/api/decrypt-sso", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: blob }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          // ⚠️ The blob is KEPT even though the decrypt failed. It may still be
          // a valid credential the server can read — a decrypt failure here is
          // about rendering a name, not about authority.
          setState({
            status: "none",
            reason: b.error || `SSO decrypt failed (${res.status})`,
            blob: blob || null,
          });
          return;
        }
        const session = (await res.json()) as ViewerSession;
        setState({ status: "ready", session, blob });
      } catch {
        setState({
          status: "none",
          reason: "SSO decrypt request failed.",
          blob: blob || null,
        });
      }
    };

    window.addEventListener("message", onMessage);
    try {
      window.parent?.postMessage({ message: "REQUEST_USER_DATA" }, "*");
    } catch {
      /* not in an iframe */
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        setState({
          status: "none",
          reason:
            "No SSO response — not embedded in GHL, or the SSO handshake isn't set up yet.",
          blob: null,
        });
      }
    }, timeoutMs);

    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [timeoutMs]);

  return state;
}
