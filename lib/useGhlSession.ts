import { useCallback, useEffect, useRef, useState } from "react";

export interface ViewerSession {
  userId: string;
  role: string | null;
  activeLocation: string | null;
  userName: string | null;
  email: string | null;
  companyId: string | null;
  type: string | null;
}

interface SsoFacts {

  blob: string | null;

  answered: boolean;

  embedded: boolean;

  retry: () => void;
}

export type SsoState =
  | (SsoFacts & { status: "loading" })
  | (SsoFacts & { status: "ready"; session: ViewerSession; blob: string })
  | (SsoFacts & { status: "none"; reason: string });

export function ssoResolved(s: SsoState): boolean {
  if (s.blob !== null) return true;
  return s.status === "none" && (s.answered || !s.embedded);
}

export function ssoWaiting(s: SsoState): boolean {
  return !ssoResolved(s);
}

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

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const retryRef = useRef(retry);
  retryRef.current = retry;

  useEffect(() => {
    const embedded = window.parent !== window;

    let answered = false;
    let alive = true;

    const onMessage = async (e: MessageEvent) => {
      const data = e.data as { message?: string; payload?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.message !== "REQUEST_USER_DATA_RESPONSE") return;
      if (!alive) return;

      answered = true;
      const blob = data.payload || "";

      if (!blob) {

        setState((p) => ({
          ...p,
          status: "none",
          answered: true,
          reason:
            "GoHighLevel replied with no session. Sign in to GoHighLevel again, then reload this tab.",
        }));
        return;
      }

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

    setState((p) => ({
      ...p,
      embedded,
      retry: retryRef.current,
      ...(p.status === "none" && !p.answered ? { status: "loading" as const } : {}),
    }));
    try {
      window.parent?.postMessage({ message: "REQUEST_USER_DATA" }, "*");
    } catch {

    }

    const timer = setTimeout(() => {
      if (answered || !alive) return;

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
