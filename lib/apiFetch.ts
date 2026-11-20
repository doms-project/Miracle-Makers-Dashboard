export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,

    readonly refusal?: boolean,
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

    if (e instanceof DOMException && e.name === "AbortError")
      throw new ApiError(
        `${method} ${url} was cancelled before it finished (timed out, or superseded).`,
        0,
        url,
      );

    throw new ApiError(
      `Couldn't reach the server for ${method} ${url} (${
        e instanceof Error ? e.message : String(e)
      }). Check your connection, then reload.`,
      0,
      url,
    );
  }

  const raw = await res.text().catch(() => "");
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {

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

  if (j.detail || j.error)
    throw new ApiError(
      [j.error, j.detail].filter(Boolean).join(" — "),
      res.status,
      url,
      raw,
    );

  if (res.status === 404 && (looksLikeHtml(raw) || !raw))
    throw new ApiError(
      `404 — no API route at ${url}. The route exists in the source, so the running build almost certainly predates it: redeploy, then retry. (The server returned ${
        raw ? "an HTML page" : "an empty body"
      }, not JSON, which is what a missing Next.js route looks like.)`,
      404,
      url,
      raw,
    );

  if (res.status === 405)
    throw new ApiError(
      `This dashboard called its own API the wrong way: ${method} ${pathOf(url)} ` +
        "is not a method that route accepts, so the request never reached any " +
        "code. Nothing was sent to GoHighLevel and nothing was changed. This is " +
        "a bug in the dashboard, not a problem with your data or your session.",
      405,
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

export function apiError(res: Response, j: unknown, raw?: string): ApiError {
  return new ApiError(

    (j as { refusal?: boolean } | null)?.refusal
      ? String((j as { error?: string }).error || failureMessage(res, j))
      : failureMessage(res, j),
    res.status,
    res.url,
    raw ?? (j == null ? undefined : JSON.stringify(j)),
    (j as { refusal?: boolean } | null)?.refusal === true,
  );
}

export function failureMessage(res: Response, j: unknown): string {
  const e = (j ?? {}) as { error?: string; detail?: string };
  if (e.detail || e.error) return [e.error, e.detail].filter(Boolean).join(" — ");

  const where = pathOf(res.url);
  if (res.status === 404)
    return `404 — no API route at ${where}. The route exists in the source, so the running build almost certainly predates it: redeploy, then retry.`;
  if (res.status === 401 || res.status === 403)
    return `${res.status} on ${where} — the sign-in session was rejected. Reload the dashboard inside GoHighLevel to refresh it.`;
  if (res.status === 405)
    return `This dashboard called its own API the wrong way: ${res.status} on ${where}. The request never reached any code — nothing was sent to GoHighLevel. This is a dashboard bug, not a problem with your data.`;
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
