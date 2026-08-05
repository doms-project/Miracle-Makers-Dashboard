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

export type SsoState =
  | { status: "loading" }
  | { status: "ready"; session: ViewerSession; blob: string }
  | { status: "none"; reason: string };

export function useGhlSession(timeoutMs = 4000): SsoState {
  const [state, setState] = useState<SsoState>({ status: "loading" });

  useEffect(() => {
    let settled = false;

    const onMessage = async (e: MessageEvent) => {
      const data = e.data as { message?: string; payload?: string } | null;
      if (!data || typeof data !== "object") return;
      if (data.message !== "REQUEST_USER_DATA_RESPONSE") return;
      if (settled) return;
      settled = true;
      const blob = data.payload || "";
      try {
        const res = await fetch("/api/decrypt-sso", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: blob }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setState({
            status: "none",
            reason: b.error || `SSO decrypt failed (${res.status})`,
          });
          return;
        }
        const session = (await res.json()) as ViewerSession;
        setState({ status: "ready", session, blob });
      } catch {
        setState({ status: "none", reason: "SSO decrypt request failed." });
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
