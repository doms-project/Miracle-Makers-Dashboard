// One place that turns a failed API call into a message you can act on.
//
// WHY THIS EXISTS. Every client fetch in this app did the same thing:
//
//   const j = await res.json().catch(() => ({}));
//   if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
//
// which is fine when the server answers with JSON — and useless when it does
// not. A Next.js 404 is an HTML page: `res.json()` throws, the catch swallows
// it, `j` is `{}`, and every field is undefined, so the message collapses to a
// bare "HTTP 404" that says nothing about WHERE or WHY. That exact shape has
// slowed down diagnosis repeatedly on this project.
//
// A bare status is now impossible. Every failure carries: the status, the
// method and path, the server's own error/detail when it sent JSON, and — when
// it didn't — what it actually sent, plus a plain reading of what that means.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const looksLikeHtml = (s: string): boolean =>
  /^\s*<(?:!doctype|html|head|body)/i.test(s);

export async function apiFetch<T = unknown>(
  url: string,
  init: RequestInit & { ssoBlob?: string | null } = {},
): Promise<T> {
  const { ssoBlob, headers, ...rest } = init;
  const method = (rest.method || "GET").toUpperCase();

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      cache: "no-store",
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
        ...(headers as Record<string, string>),
      },
    });
  } catch (e) {
    // Network-level: DNS, offline, CORS, a blocked request. `fetch` rejects
    // here with a message browsers deliberately keep vague, so say what we know.
    throw new ApiError(
      `Couldn't reach the server for ${method} ${url} (${
        e instanceof Error ? e.message : String(e)
      }). Check your connection, then reload.`,
      0,
      url,
    );
  }

  // Read ONCE as text, then try to parse. Calling res.json() and later
  // res.text() on the same response throws "body already read", which is how
  // the original message ended up empty.
  const raw = await res.text().catch(() => "");
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON — handled below */
    }
  }

  if (res.ok) {
    if (data === undefined && raw)
      throw new ApiError(
        `${method} ${url} returned ${res.status} but the body wasn't JSON: ${snippet(raw)}`,
        res.status,
        url,
        raw,
      );
    return data as T;
  }

  const j = (data ?? {}) as { error?: string; detail?: string };

  // The server answered in our own error shape — use its words.
  if (j.detail || j.error)
    throw new ApiError(
      [j.error, j.detail].filter(Boolean).join(" — "),
      res.status,
      url,
      raw,
    );

  // It didn't. Say what came back and what that most likely means, because
  // "HTTP 404" alone is indistinguishable between "no such route" and
  // "the route ran and something it needed was missing".
  if (res.status === 404 && (looksLikeHtml(raw) || !raw))
    throw new ApiError(
      `404 — no API route at ${url}. The route exists in the source, so the running build almost certainly predates it: redeploy, then retry. (The server returned ${
        raw ? "an HTML page" : "an empty body"
      }, not JSON, which is what a missing Next.js route looks like.)`,
      404,
      url,
      raw,
    );

  throw new ApiError(
    `${method} ${url} failed with ${res.status}${
      res.statusText ? ` ${res.statusText}` : ""
    }${raw ? `: ${snippet(raw)}` : " (empty response body)"}`,
    res.status,
    url,
    raw,
  );
}

// Drop-in replacement for the `j.detail || j.error || \`HTTP ${res.status}\``
// line that appears at every existing call site.
//
// It cannot show the response BODY — by the time this runs the caller has
// already consumed it via res.json() — but it can never produce a bare status,
// which was the actual complaint. Prefer apiFetch() for new code; this exists so
// the twenty existing call sites could be fixed without restructuring flows that
// can't be runtime-tested from here.
export function failureMessage(res: Response, j: unknown): string {
  const e = (j ?? {}) as { error?: string; detail?: string };
  if (e.detail || e.error) return [e.error, e.detail].filter(Boolean).join(" — ");

  const where = pathOf(res.url);
  if (res.status === 404)
    return `404 — no API route at ${where}. The route exists in the source, so the running build almost certainly predates it: redeploy, then retry.`;
  if (res.status === 401 || res.status === 403)
    return `${res.status} on ${where} — the sign-in session was rejected. Reload the dashboard inside GoHighLevel to refresh it.`;
  if (res.status >= 500)
    return `${res.status} on ${where} — the server errored and sent no reason. Check the Vercel logs for this request.`;
  return `${res.status}${res.statusText ? ` ${res.statusText}` : ""} on ${where} — the server sent no error message.`;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url || "the API";
  }
}

function snippet(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}
