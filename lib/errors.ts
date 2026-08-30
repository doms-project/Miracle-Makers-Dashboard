import { ApiError } from "./apiFetch";

// ---------------------------------------------------------------------------
// One translation layer: a plain sentence for the rep, the verbatim technical
// detail for us. LAYERED, never replaced.
//
// The two halves fail in opposite directions and both had already bitten us:
//
//   - a rep shown `{"statusCode":400,"message":"stageId must be one of the
//     following values: c4fa7d37-…"}` learns nothing and can do nothing;
//   - a status code shown WITHOUT its message made every bug on this project
//     slower to find, and GHL's traceId is the only field their support can
//     actually look up.
//
// So the sentence is mapped, and the raw string is kept EXACTLY as received —
// never summarised, because the exact text is what makes it searchable.
//
// Mapping is by KNOWN CASE, not by generic rules. A generic "prettifier" would
// quietly mangle the next unfamiliar error into something reassuring and wrong;
// an unmapped error here says plainly that it is unmapped and shows everything.
// ---------------------------------------------------------------------------

export interface FriendlyError {
  /** One sentence a non-technical person can act on. Always present. */
  message: string;
  /** Verbatim technical lines for the disclosure block. Never summarised. */
  details: string[];
  /** True when nothing matched — the UI says so rather than pretending. */
  unmapped: boolean;
}

interface Parsed {
  status: number;
  raw: string; // the fullest technical string we have, verbatim
  // message + the untouched response body. GHL's machine-readable phrases often
  // live ONLY in the body — our route wraps them in its own sentence — so every
  // match below tests this, not just `raw`. Verification caught the unquoted
  // duplicate case falling through for exactly that reason.
  hay: string;
  url: string;
  method: string;
  code: string; // OPPORTUNITY_NO_DUPLICATE etc.
  traceId: string;
}

const SNAKE = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,6})\b/;
const TRACE = /\b(?:traceId|trace_id)"?\s*[:=]\s*"?([0-9a-f-]{16,})/i;

function parse(e: unknown): Parsed {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const api = e instanceof ApiError ? e : null;
  // ApiError carries the untouched response body; prefer it over the message,
  // which may already have been shortened for display.
  const hay = `${raw} ${api?.body ?? ""}`;
  let url = api?.url ?? "";
  let method = "";
  // apiFetch's messages embed "METHOD /path"; recover it for the detail block.
  const mm = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+|https?:\/\/\S+)/.exec(raw);
  if (mm) {
    method = mm[1];
    url = url || mm[2];
  }
  try {
    if (url) url = new URL(url, "http://x").pathname;
  } catch {
    /* leave as-is */
  }
  return {
    status: api?.status ?? 0,
    raw,
    hay,
    url,
    method,
    code: SNAKE.exec(hay)?.[1] ?? "",
    traceId: TRACE.exec(hay)?.[1] ?? "",
  };
}

// Pull the pipeline name out of a server message so the sentence can NAME it
// rather than saying "that pipeline". First-run verification caught both of
// these being wrong: a non-greedy capture stopped at the first space and turned
// "ODP Transfer" into "ODP", and the person capture swallowed the sentence
// prefix, yielding "Move failed. — Bill Lockfeld".
function namedThing(raw: string): string {
  const m =
    // quoted is unambiguous — take everything inside the quotes
    /already has a case in "([^"]+)"/i.exec(raw) ||
    /access to (?:the )?"([^"]+)"/i.exec(raw) ||
    // unquoted — run to the sentence end or a parenthesised stage, not the
    // first space
    /already has a case in ([^".(]+?)\s*(?:\.|\(|$)/i.exec(raw) ||
    /access to (?:the )?([^".(]+?)\s+pipeline/i.exec(raw);
  return (m?.[1] || "").trim().replace(/\s+pipeline$/i, "");
}

// The person named in GHL's permission error. Anything before an em-dash or
// colon is OUR framing ("Move failed. — …"), not part of their name.
function personIn(raw: string): string {
  const body = raw.split(/\s+—\s+|:\s+/).pop() || raw;
  const m = /^(.{1,60}?)\s+doesn't have access/i.exec(body.trim());
  return (m?.[1] || "").trim();
}

export function explainError(e: unknown): FriendlyError {
  const p = parse(e);
  const raw = p.raw;
  const lower = raw.toLowerCase();
  const hay = p.hay;

  const details: string[] = [];
  if (p.code || p.status)
    details.push([p.code, p.status || null].filter(Boolean).join(" · "));
  if (p.url) details.push(`${p.method ? `${p.method} ` : ""}${p.url}`);
  if (p.traceId) details.push(`traceId ${p.traceId}`);
  // The raw string LAST and VERBATIM — it is the searchable part.
  if (raw) details.push(raw);

  const hit = (message: string): FriendlyError => ({
    message,
    details,
    unmapped: false,
  });

  // ---- known cases, most specific first ----------------------------------
  if (p.code === "OPPORTUNITY_NO_DUPLICATE" || /duplicate opportunity/i.test(hay)) {
    const where = namedThing(raw) || namedThing(hay);
    return hit(
      `This client already has a case in ${where || "that pipeline"}. Move or close that one first.`,
    );
  }

  if (
    /permission to access this pipeline/i.test(hay) ||
    /doesn't have access to/i.test(hay)
  ) {
    const who = personIn(raw) || personIn(hay) || "That user";
    const where = namedThing(raw) || namedThing(hay);
    return hit(
      `${who} doesn't have access to ${where || "that pipeline"} in GoHighLevel. An admin can grant it under Opportunities → the key icon.`,
    );
  }

  if (
    p.code === "OPPORTUNITY_STAGE_ID_INVALID" ||
    /stageid must be one of/i.test(hay.toLowerCase()) ||
    /stage does not belong/i.test(hay.toLowerCase())
  )
    return hit("That stage isn't part of this pipeline. Reload and try again.");

  if (p.status === 401 || p.status === 403 || /sign-in required/i.test(raw)) {
    // A 403 from OUR routes is a permission rule, not a dead session, and the
    // server already words those for a person. Telling someone to reload when
    // the real answer is "you don't own this record" sends them in circles.
    if (p.status === 403 && /only|permitted|you can only/i.test(raw))
      return hit(raw.replace(/^Not permitted\.\s*—?\s*/i, "") || raw);
    return hit("Your session has expired. Reload the page.");
  }

  if (p.status === 404)
    return hit(
      /no api route/i.test(raw)
        ? "That feature isn't available on this version of the dashboard yet. Reload the page; if it persists, this deploy needs updating."
        : "That record no longer exists. It may have been deleted or moved.",
    );

  if (p.status === 409) return hit(raw); // our own 409s are already plain

  // Network / upstream. `status === 0` alone is NOT enough: a plain
  // `new Error("boom")` from a client-side bug also parses to status 0, and
  // calling that "couldn't reach GoHighLevel" sends someone to check their
  // internet over a broken render. Require an actual failed request — either the
  // wording says so, or it came from apiFetch's network branch (an ApiError with
  // status 0). Anything else falls through to unmapped, which is honest.
  const networkish = /couldn't reach|could not reach|failed to fetch|networkerror|load failed/i.test(lower);
  if (p.status >= 500 || networkish || (p.status === 0 && e instanceof ApiError))
    return hit("Couldn't reach GoHighLevel. Try again in a moment.");

  // ---- unmapped: say so, and show everything -----------------------------
  return {
    message: "Something went wrong. The details below will help us fix it.",
    details,
    unmapped: true,
  };
}
