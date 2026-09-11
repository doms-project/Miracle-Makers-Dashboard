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
  /** Stack, or the JSON dump of a non-Error throw. Always shown. */
  extra: string[];
}

const SNAKE = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,6})\b/;
const TRACE = /\b(?:traceId|trace_id)"?\s*[:=]\s*"?([0-9a-f-]{16,})/i;

/**
 * The fullest technical string available for ANY thrown value.
 *
 * 🔴 THIS WAS `String(e)`, WHICH RENDERS A PLAIN OBJECT AS "[object Object]".
 *
 * That is not a hypothetical: several call sites store a route's parsed JSON
 * body directly as the error —
 *
 *     const j = await res.json();
 *     if (!res.ok) { setCErr(j); return; }        // a plain object, not an Error
 *
 * — so the disclosure block that promises "the verbatim technical detail" was
 * printing eight useless characters, and "Copy details" copied them. Two
 * separate bugs on this project have been slower to find for exactly this.
 *
 * Every shape now yields something readable:
 *   Error       → message, then the stack
 *   plain object → JSON.stringify, pretty-printed
 *   anything else → its value AND its typeof, so "undefined" or a stray number
 *                   is identifiable rather than blank
 */
function describe(e: unknown): { raw: string; extra: string[]; status: number } {
  const extra: string[] = [];
  if (e instanceof Error) {
    // A stack is the single most useful line when the throw is ours.
    if (e.stack && e.stack.trim() !== e.message.trim()) extra.push(e.stack);
    return { raw: e.message || e.name || "Error", extra, status: 0 };
  }
  if (typeof e === "string") return { raw: e, extra, status: 0 };
  if (e && typeof e === "object") {
    // Prefer the object's own human sentence when it has one — our routes send
    // { error, detail } — but ALWAYS keep the whole object in the details.
    const o = e as Record<string, unknown>;
    const sentence =
      typeof o.error === "string"
        ? o.error
        : typeof o.message === "string"
          ? o.message
          : "";
    let dump = "";
    try {
      dump = JSON.stringify(e, null, 2);
    } catch {
      // Circular, or a Proxy that throws on read. Say so rather than nothing.
      dump = `[unserialisable ${Object.prototype.toString.call(e)}]`;
    }
    if (dump && dump !== sentence) extra.push(dump);
    // 🔴 READ THE STATUS OFF THE OBJECT TOO. Our routes send { error, status },
    // and a body stored directly as the error therefore carries its own code —
    // but `status` was only ever read from an ApiError instance, so every one of
    // these fell through to "Something went wrong" with a 404 sitting in plain
    // sight inside it.
    const st = Number(o.status ?? o.statusCode ?? 0);
    // `raw` can end up as a MESSAGE (the 409 branch prints it), so it must stay
    // one readable line. The pretty dump is already in `extra` and always shown
    // in the details block — printing it twice, once as a headline, would put a
    // wall of JSON where the sentence goes.
    let oneLine = "";
    try {
      oneLine = JSON.stringify(e);
    } catch {
      oneLine = Object.prototype.toString.call(e);
    }
    if (oneLine.length > 160) oneLine = `${oneLine.slice(0, 157)}…`;
    return {
      raw: sentence || oneLine || Object.prototype.toString.call(e),
      extra,
      status: Number.isFinite(st) ? st : 0,
    };
  }
  // null, undefined, a number, a symbol — name the type, or the reader cannot
  // tell an empty message from a thrown `undefined`.
  return { raw: `${String(e)} (${typeof e})`, extra, status: 0 };
}

function parse(e: unknown): Parsed {
  const d = describe(e);
  const raw = d.raw;
  const api = e instanceof ApiError ? e : null;
  // ApiError carries the untouched response body; prefer it over the message,
  // which may already have been shortened for display.
  const hay = `${raw} ${d.extra.join(" ")} ${api?.body ?? ""}`;
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
    status: api?.status ?? d.status ?? 0,
    raw,
    extra: d.extra,
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

// The `error` field of a JSON body our own routes returned. These are already
// written for a person, so when one is present it beats anything we could
// reconstruct from the wrapper message.
function bodyError(e: unknown): string {
  if (!(e instanceof ApiError) || !e.body) return "";
  try {
    const j = JSON.parse(e.body) as { error?: unknown };
    return typeof j.error === "string" ? j.error : "";
  } catch {
    return "";
  }
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
  // The stack, or the whole object for a non-Error throw. This is the half that
  // was missing entirely when the thrown value was not an Error.
  for (const x of p.extra) if (x && !details.includes(x)) details.push(x);
  // ...and the RESPONSE BODY, which is usually the only place GoHighLevel's own
  // wording appears. `hay` has always included it for MATCHING, but it was never
  // shown — so a disclosure block promising the verbatim technical detail was
  // quietly withholding the most useful line in it. Skipped when it adds nothing
  // over the message we already printed.
  const body = e instanceof ApiError ? (e.body || "").trim() : "";
  if (body && !raw.includes(body) && !body.includes(raw)) details.push(body);

  const hit = (message: string): FriendlyError => ({
    message,
    details,
    unmapped: false,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND 94 — THE SECOND HALF.
  //
  // Round 80 made errors READABLE ([object Object] → a sentence). It did not
  // make them USEFUL: a 422 and a 400 still reached the screen as GoHighLevel's
  // own words about an endpoint nobody using this app has heard of.
  //
  // 🔴 WHAT SURVIVED IS THE PART THAT MATTERS. The pipeline WAS created before
  // the field failed; an error that does not say so leaves an admin guessing
  // whether to retry — and retrying made a second pipeline. Routes put a
  // `survived` sentence on the error and it is printed FIRST.
  // ═══════════════════════════════════════════════════════════════════════
  const survived =
    e && typeof e === "object" && typeof (e as { survived?: unknown }).survived === "string"
      ? String((e as { survived: string }).survived).trim()
      : "";
  const withSurvived = (m: string) => (survived ? `${survived} ${m}` : m);

  // 🔴 NEVER A STACK TRACE. `chunks/2fkfwr…js:1:20731` is noise to everyone and
  // is in the console already. Dropped from the disclosure block, not from the
  // console.
  for (let i = details.length - 1; i >= 0; i--)
    if (/^\s*at\s+\S|chunks\/[\w-]+\.js:\d+:\d+/.test(details[i])) details.splice(i, 1);

  // 🔴 AND STOP DOUBLING THE PREFIX. "GoHighLevel returned 422 for POST
  // /custom-fields/." appeared TWICE — a route wrapping an error that already
  // carried the same text.
  for (let i = details.length - 1; i > 0; i--)
    if (details.slice(0, i).some((d) => d.includes(details[i]))) details.splice(i, 1);

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

  // Rate limited. Named plainly: "too many requests" means nothing to a rep,
  // and the honest action is simply to wait a moment.
  if (p.status === 429 || /\b429\b|too many requests/i.test(hay))
    return hit(
      "GoHighLevel is busy right now. Wait a few seconds and try again.",
    );

  // 🔴 GHL'S OWN TIMEOUT ARRIVES AS A 401.
  //
  //   {"statusCode":401,"message":"Command timed out"}
  //
  // Confirmed by reproducing it outside the dashboard with a token that worked
  // moments earlier. It is checked BEFORE the generic 401 branch, because that
  // branch would otherwise say "your session has expired" and send someone to
  // reload a page over a working token — a confident, specific, wrong
  // explanation, which is worse than saying nothing.
  if (/timed?\s*out/i.test(hay))
    return hit("GoHighLevel didn't respond. Try again in a moment.");

  // A MISSING PIT SCOPE is not an expired session, and telling someone to
  // reload the page for one wastes a round — reloading can never fix it. Added
  // as a KNOWN CASE after the folder bug: the Access tab's folder read fails
  // exactly this way when the Private Integration lacks medias/media, and it
  // was rendering as the generic "Something went wrong".
  if (/\/medias\b|medias\/media/i.test(`${hay} ${p.url}`)) {
    // The status may be 0 here: these arrive as a plain detail STRING from the
    // route, not as an ApiError, so the code is only in the wording.
    const denied =
      p.status === 401 ||
      p.status === 403 ||
      /\b(401|403)\b/.test(hay) ||
      /scope/i.test(hay);
    if (denied)
      return hit(
        "The GoHighLevel integration isn't allowed to read the media library. An admin needs to add the medias/media scope to the Private Integration token — reloading won't fix this.",
      );
  }

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

  // Our own 409s are already written for a person — but the sentence lives in
  // the response BODY's `error`, while `raw` is apiFetch's wrapper ("Couldn't
  // save."). Returning raw threw the useful sentence away and told the rep
  // nothing. ITEM 5's conflict message is the case that exposed this.
  if (p.status === 409) return hit(bodyError(e) || raw);

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
  // ---- GENERIC, BY STATUS. Say what failed and what can be done, in the
  // user's terms — never the endpoint. Reached only when nothing above matched.
  if (p.status === 403)
    return hit(withSurvived("You do not have permission to do that."));
  if (p.status === 409 || (p.status === 400 && /already exist|duplicate/i.test(hay)))
    return hit(
      withSurvived(
        namedThing(raw) || namedThing(hay)
          ? `${namedThing(raw) || namedThing(hay)} already exists.`
          : "Something with that name already exists.",
      ),
    );
  if (p.status === 422 && /option/i.test(hay))
    return hit(withSurvived("Choose at least one option for a dropdown."));
  if (p.status === 422 || p.status === 400)
    return hit(
      withSurvived(
        "GoHighLevel rejected this and we could not tell why. Send the details below to your developer.",
      ),
    );
  if (p.status && p.status >= 500)
    return hit(withSurvived("GoHighLevel is not responding. Nothing was changed."));
  if (!p.status && /failed to fetch|networkerror|load failed/i.test(hay))
    return hit(withSurvived("Could not reach GoHighLevel. Nothing was changed."));

  return {
    message: "Something went wrong. The details below will help us fix it.",
    details,
    unmapped: true,
  };
}
