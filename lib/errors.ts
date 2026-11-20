import { ApiError } from "./apiFetch";

export interface FriendlyError {

  message: string;

  details: string[];

  unmapped: boolean;
}

interface Parsed {
  status: number;
  raw: string;

  hay: string;
  url: string;
  method: string;
  code: string;
  traceId: string;

  extra: string[];
}

const SNAKE = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,6})\b/;
const TRACE = /\b(?:traceId|trace_id)"?\s*[:=]\s*"?([0-9a-f-]{16,})/i;

function describe(e: unknown): { raw: string; extra: string[]; status: number } {
  const extra: string[] = [];
  if (e instanceof Error) {

    if (e.stack && e.stack.trim() !== e.message.trim()) extra.push(e.stack);
    return { raw: e.message || e.name || "Error", extra, status: 0 };
  }
  if (typeof e === "string") return { raw: e, extra, status: 0 };
  if (e && typeof e === "object") {

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

      dump = `[unserialisable ${Object.prototype.toString.call(e)}]`;
    }
    if (dump && dump !== sentence) extra.push(dump);

    const st = Number(o.status ?? o.statusCode ?? 0);

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

  return { raw: `${String(e)} (${typeof e})`, extra, status: 0 };
}

function parse(e: unknown): Parsed {
  const d = describe(e);
  const raw = d.raw;
  const api = e instanceof ApiError ? e : null;

  const hay = `${raw} ${d.extra.join(" ")} ${api?.body ?? ""}`;
  let url = api?.url ?? "";
  let method = "";

  const mm = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+|https?:\/\/\S+)/.exec(raw);
  if (mm) {
    method = mm[1];
    url = url || mm[2];
  }
  try {
    if (url) url = new URL(url, "http://x").pathname;
  } catch {

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

function namedThing(raw: string): string {
  const m =

    /already has a case in "([^"]+)"/i.exec(raw) ||
    /access to (?:the )?"([^"]+)"/i.exec(raw) ||

    /already has a case in ([^".(]+?)\s*(?:\.|\(|$)/i.exec(raw) ||
    /access to (?:the )?([^".(]+?)\s+pipeline/i.exec(raw);
  return (m?.[1] || "").trim().replace(/\s+pipeline$/i, "");
}

function personIn(raw: string): string {
  const body = raw.split(/\s+—\s+|:\s+/).pop() || raw;
  const m = /^(.{1,60}?)\s+doesn't have access/i.exec(body.trim());
  return (m?.[1] || "").trim();
}

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

  if (raw) details.push(raw);

  for (const x of p.extra) if (x && !details.includes(x)) details.push(x);

  const body = e instanceof ApiError ? (e.body || "").trim() : "";
  if (body && !raw.includes(body) && !body.includes(raw)) details.push(body);

  const hit = (message: string): FriendlyError => ({
    message,
    details,
    unmapped: false,
  });

  const survived =
    e && typeof e === "object" && typeof (e as { survived?: unknown }).survived === "string"
      ? String((e as { survived: string }).survived).trim()
      : "";
  const withSurvived = (m: string) => (survived ? `${survived} ${m}` : m);

  for (let i = details.length - 1; i >= 0; i--)
    if (/^\s*at\s+\S|chunks\/[\w-]+\.js:\d+:\d+/.test(details[i])) details.splice(i, 1);

  for (let i = details.length - 1; i > 0; i--)
    if (details.slice(0, i).some((d) => d.includes(details[i]))) details.splice(i, 1);

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

  if (p.status === 429 || /\b429\b|too many requests/i.test(hay))
    return hit(
      "GoHighLevel is busy right now. Wait a few seconds and try again.",
    );

  if (/timed?\s*out/i.test(hay))
    return hit("GoHighLevel didn't respond. Try again in a moment.");

  if (/\/medias\b|medias\/media/i.test(`${hay} ${p.url}`)) {

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

  if (p.status === 409) return hit(bodyError(e) || raw);

  const networkish = /couldn't reach|could not reach|failed to fetch|networkerror|load failed/i.test(lower);
  if (p.status >= 500 || networkish || (p.status === 0 && e instanceof ApiError))
    return hit("Couldn't reach GoHighLevel. Try again in a moment.");

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
