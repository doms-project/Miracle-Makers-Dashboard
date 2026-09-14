import { useCallback, useEffect, useRef, useState } from "react";

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
// 🔴 THREE FACTS, NOT ONE. Conflating them has now caused a bug in each.
//
//   blob      the credential has arrived      → data can be requested
//   answered  the parent REPLIED              → silence is not a reply
//   embedded  there IS a parent frame at all  → definitive, and synchronous
//
// Round 107 split the first out of `status`, which fixed a 401 flash on load
// and a wasted round trip (report 81 §3.1). It did not touch the other two, and
// they carry a worse bug between them:
//
// 🔴 A SLOW PARENT WAS TREATED AS AN ABSENT ONE. The 4-second timer was the ONLY
// path to `status:"none"` with a null blob, and it fires on SILENCE. The screen
// then asked for data with no credential, and the server answered — correctly,
// for the case IT was written for — "Open this dashboard inside GoHighLevel".
// Which was false: the dashboard WAS open inside GoHighLevel, and GoHighLevel
// simply had not answered yet.
//
// 🔴 AND A LATE ANSWER WAS DROPPED ON THE FLOOR. One `settled` flag was set by
// the timeout and then short-circuited the message handler, so a reply arriving
// at 4.1s was discarded and the screen sat on a false error until somebody
// reloaded. That is exactly what "a reload fixes it" means.
//
// ⚠️ NEITHER IS NEW. `git diff HEAD` shows the timeout branch unchanged by round
// 107 — it was there before, and round 107 neither caused it nor fixed it.
// ═══════════════════════════════════════════════════════════════════════════

interface SsoFacts {
  /** The credential, the instant it arrives. Null = nothing to send yet. */
  blob: string | null;
  /**
   * 🔴 DID THE PARENT REPLY? Silence is not a reply; an empty payload is.
   * The only thing that can tell "never" from "not yet".
   */
  answered: boolean;
  /**
   * Is there a parent frame at all?
   *
   * ⚠️ THE ONE DEFINITIVE SIGNAL AVAILABLE WITHOUT WAITING. `window.parent ===
   * window` means this page is not in an iframe, so "open it inside
   * GoHighLevel" is TRUE and can be said at once. Inside a frame, silence means
   * nothing except that we have not heard back.
   */
  embedded: boolean;
  /** Ask the parent again and restart the clock. Stable identity. */
  retry: () => void;
}

export type SsoState =
  | (SsoFacts & { status: "loading" })
  | (SsoFacts & { status: "ready"; session: ViewerSession; blob: string })
  | (SsoFacts & { status: "none"; reason: string });

/**
 * Is the handshake finished as far as REQUESTING DATA is concerned?
 *
 * True when there is a blob to authenticate with, or when we know for certain
 * that none is coming.
 *
 * 🔴 AN UNANSWERED TIMEOUT INSIDE A FRAME IS NOT CERTAINTY. It used to count as
 * settled, which is what sent an unauthenticated request and produced a 401
 * telling the user to do the very thing they were already doing. OUTSIDE a
 * frame it is certainty — there is no parent to answer — so that case still
 * resolves, and the server's message is then true.
 */
export function ssoResolved(s: SsoState): boolean {
  if (s.blob !== null) return true;
  return s.status === "none" && (s.answered || !s.embedded);
}

/** Waiting on GoHighLevel, with nothing wrong. The UI says so and offers Retry. */
export function ssoWaiting(s: SsoState): boolean {
  return !ssoResolved(s);
}

/** The blob to send, or null when there is none to send. */
export function ssoBlob(s: SsoState): string | null {
  return s.blob;
}

const NOT_EMBEDDED =
  "This dashboard has to be opened inside GoHighLevel — there is no parent window to sign in through.";
const NO_ANSWER_YET =
  "No sign-in response from GoHighLevel yet. This tab is still listening, so it may clear on its own.";

export function useGhlSession(timeoutMs = 4000): SsoState {
  const [state, setState] = useState<SsoState>(() => ({
    status: "loading",
    blob: null,
    answered: false,
    embedded: true,
    retry: () => {},
  }));

  /** Bumped by retry(): re-ask the parent and restart the clock. */
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // Held in a ref so the function's identity in state never changes and no
  // consumer's effect re-runs merely because the object was rebuilt.
  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    const embedded = window.parent !== window;
    // 🔴 SEPARATE FROM THE OLD `settled`. `answered` stops the TIMER; it must
    // never stop the LISTENER. One flag did both, so a reply arriving after the
    // timer had fired was discarded.
    let answered = false;
    let alive = true;

    const onMessage = async (e: MessageEvent) => {
      const data = e.data as { message?: string; payload?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.message !== "REQUEST_USER_DATA_RESPONSE") return;
      if (!alive) return;
      // ⚠️ DELIBERATELY NOT GUARDED BY A SETTLED FLAG. A late reply is still a
      // reply, and accepting it is what makes a false error heal itself instead
      // of waiting for somebody to reload.
      answered = true;
      const blob = data.payload || "";

      if (!blob) {
        // An EMPTY payload is a definitive answer: the parent replied and has
        // no session for us. Distinct from silence, and now distinguishable.
        setState((p) => ({
          ...p,
          status: "none",
          answered: true,
          reason:
            "GoHighLevel replied with no session. Sign in to GoHighLevel again, then reload this tab.",
        }));
        return;
      }

      // 🔴 PUBLISHED IMMEDIATELY — and this is also the auto-recovery. Consumers
      // watch `sso.blob`, so a late arrival re-fires every gated loader with
      // nobody reloading anything.
      setState((p) => ({ ...p, blob, answered: true }));

      try {
        const res = await fetch("/api/decrypt-sso", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: blob }),
        });
        if (!alive) return;
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          // ⚠️ The blob is KEPT. A decrypt failure here is about rendering a
          // name; the server may read the same blob perfectly well.
          setState((p) => ({
            ...p,
            status: "none",
            answered: true,
            blob: blob || null,
            reason: b.error || `SSO decrypt failed (${res.status})`,
          }));
          return;
        }
        const session = (await res.json()) as ViewerSession;
        if (!alive) return;
        setState((p) => ({ ...p, status: "ready", session, blob, answered: true }));
      } catch {
        if (!alive) return;
        setState((p) => ({
          ...p,
          status: "none",
          answered: true,
          blob: blob || null,
          reason: "SSO decrypt request failed.",
        }));
      }
    };

    window.addEventListener("message", onMessage);
    // Re-asking must also clear a previous "no answer yet", or Retry would look
    // like it did nothing while it waited.
    setState((p) => ({
      ...p,
      embedded,
      retry: retryRef.current,
      ...(p.status === "none" && !p.answered ? { status: "loading" as const } : {}),
    }));
    try {
      window.parent?.postMessage({ message: "REQUEST_USER_DATA" }, "*");
    } catch {
      /* not in an iframe */
    }

    const timer = setTimeout(() => {
      if (answered || !alive) return;
      // 🔴 SAY WHICH IT IS. Outside a frame there is no parent, and the
      // instruction to open it inside GoHighLevel is true. Inside one, silence
      // means only that we have not heard back — and the listener above is
      // still live, so it can still clear itself.
      setState((p) => ({
        ...p,
        status: "none",
        answered: false,
        reason: embedded ? NO_ANSWER_YET : NOT_EMBEDDED,
      }));
    }, timeoutMs);

    return () => {
      alive = false;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };
  }, [timeoutMs, attempt]);

  return state;
}
