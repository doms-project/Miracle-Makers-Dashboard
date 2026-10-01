// GHL DATE values — one parser, one formatter, used by every read path.
//
// ITEM 1. GHL returns a DATE custom field in AT LEAST three shapes depending on
// which endpoint you read it from:
//
//   GET /opportunities/{id}      "2026-08-28"      (bare date, under fieldValue)
//   GET /opportunities/search    1787875200000     (epoch MILLISECONDS)
//   after a write                "2026-08-28T…Z"   (full ISO)
//
// The dashboard list is built from the SEARCH endpoint, which is why the panel
// showed a raw `1787875200000` while the probe (which reads the single-record
// endpoint) showed a clean date. The value was always right; only the display
// was wrong — in two different ways:
//
//   read-only fields   ->  asStr(value)  ->  "1787875200000"   (the reported bug)
//   editable fields    ->  new Date("1787875200000") is INVALID, so the old
//                          asDate() fell through to s.slice(0,10) and produced
//                          "1787875200" — a silently truncated, meaningless date
//                          that <input type="date"> then refused, showing blank.
//
// So both branches were broken, differently, and only one of them was visible.
//
// TIMEZONE: GHL stores these at UTC midnight. Formatting epoch 1787875200000 in
// US Eastern would render "Aug 27" — the day before. Every function here reads
// and writes in UTC so a date can never drift across a day boundary.

// Parse any shape GHL might hand us. Returns null when there is no usable value.
export function parseGhlDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw == null || raw === "") return null;

  if (typeof raw === "number" && Number.isFinite(raw)) return fromEpoch(raw);

  const s = String(raw).trim();
  if (!s) return null;

  // All digits -> epoch. Seconds and milliseconds are both in the wild.
  if (/^\d+$/.test(s)) return fromEpoch(Number(s));

  // Bare date: pin to UTC noon. Parsing "2026-08-28" as local time and then
  // formatting in UTC (or vice versa) is the classic off-by-one-day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fromEpoch(n: number): Date | null {
  // 10 digits ≈ seconds (through the year 2286); 13 ≈ milliseconds.
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

// Does this value carry a real time, or is it midnight (i.e. a plain date)?
export function hasTime(v: unknown): boolean {
  const d = parseGhlDate(v);
  if (!d) return false;
  // A bare date normalises to UTC noon above, so noon-exact is also "no time".
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (m !== 0) return true;
  return h !== 0 && h !== 12;
}

// A field whose NAME promises a time — "AAA In Person Date and Time",
// "MCO In Person Date and Time".
//
// PROVEN BY A REAL WRITE: a GHL DATE field cannot hold one.
//   PUT  value = "2026-08-28T14:30:00.000Z"
//   read fieldValue = "2026-08-28"          (field ZP7MF2LO3ws4jzYbrTJx)
// The time is accepted with a 200 and silently discarded.
//
// So this no longer selects an editor — offering a time input that throws the
// time away on save is worse than not offering one. It now drives a WARNING
// beside the field, and nothing else. It is name-driven, so the moment those
// fields are renamed in GHL to drop "and Time", the warning disappears on its
// own with no code change.
export function nameImpliesTime(name: string): boolean {
  return /\btime\b/i.test(name || "");
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Display format. Date-only unless the value actually carries a time (or the
// field is named as a date-and-time field and has one).
//   1787875200000            -> "Aug 28, 2026"
//   "2026-08-28T14:30:00Z"   -> "Aug 28, 2026, 2:30 PM UTC"
export function formatGhlDate(v: unknown, opts?: { withTime?: boolean }): string {
  const d = parseGhlDate(v);
  if (!d) return "";
  const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const wantTime = opts?.withTime ?? hasTime(v);
  // 🔴 DATE-ONLY STAYS IN UTC, AND THAT IS THE WHOLE POINT OF THIS FILE.
  // GoHighLevel stores a DATE field at UTC midnight; converting it to Eastern
  // would render March 14 as March 13. The reasoning is at the top.
  if (!wantTime) return date;
  // ═══ ROUND 168 — A VALUE THAT CARRIES A TIME IS A TIMESTAMP, SO IT GOES TO
  // EASTERN — AND THE DATE PART GOES WITH IT ════════════════════════════════
  //
  // 🔴 SWAPPING ONLY THE CLOCK WOULD HAVE BEEN WORSE THAN LEAVING IT. `date`
  // above is built from getUTCMonth/getUTCDate, so an Eastern time beside it
  // prints the right hour on the wrong day: 2026-10-01T03:34Z is the 1st in
  // UTC and the 30th in Eastern. The whole timestamp converts together or
  // neither half does.
  //
  // ⚠️ THE OLD " UTC" SUFFIX WAS HONEST AND IS NO LONGER NEEDED. It existed
  // because the value was NOT converted and the comment said so — "the zone is
  // stated rather than silently converted". Now it IS converted, to the one
  // zone the whole dashboard uses, and the label says which.
  //
  // ⚠️ IN PRACTICE THIS BRANCH IS A GUARD. A GHL DATE field cannot hold a time
  // (proven by a real write, noted above), so it fires only for a value some
  // other system wrote — which is exactly when getting the day right matters.
  return formatEastern(d);
}

// Value for <input type="date"> — always "YYYY-MM-DD". The ONLY editor shape
// used for DATE fields, since GHL stores nothing finer.
export function toDateInput(v: unknown): string {
  const d = parseGhlDate(v);
  return d ? d.toISOString().slice(0, 10) : "";
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 168 — ONE TIME ZONE FOR THE WHOLE DASHBOARD: EASTERN.
//
// 🔴 EVERY TIMESTAMP IN THIS APP WAS RENDERING IN A DIFFERENT ZONE DEPENDING ON
// WHERE IT WAS FORMATTED. The server runs on UTC, so a note added at 8pm
// Eastern read as the NEXT DAY, 12:00 AM. The note-removal stamp said
// `timeZone: "UTC"` outright. The import heading used the server default. And
// `formatGhlDate` appended a literal " UTC" to any timed value. Four sites,
// four answers, none of them what GoHighLevel shows the same people.
//
// ⚠️ EASTERN IS NOT A PREFERENCE, IT IS WHAT THE SOURCE OF TRUTH SHOWS.
// GoHighLevel renders William Yost's creation as "Sep 30 2026, 11:34pm (EDT)"
// from `2026-10-01T03:34:26.497Z`. A dashboard beside it saying "Oct 1,
// 3:34 AM" is two systems disagreeing about when something happened.
//
// 🔴 EDT/EST COMES FROM THE ZONE DATABASE, NEVER FROM A RULE WE WROTE. The
// US DST boundaries have moved before and will again; `timeZoneName: "short"`
// against `America/New_York` is correct for every date without anybody
// maintaining it. Verified: October → EDT, January → EST.
//
// ⚠️ BUILT FROM `formatToParts`, NOT FROM A LOCALE STRING. The required format
// — "Sep 30 2026, 11:34pm (EDT)" — has no comma after the day, a lowercase
// meridiem and a parenthesised zone, and no locale produces that. Assembling
// the parts is also immune to a locale-string layout changing under us.
// ═══════════════════════════════════════════════════════════════════════════

/** The one zone. Everything with a clock time renders here. */
export const DASHBOARD_TZ = "America/New_York";

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const EASTERN_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: DASHBOARD_TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
});

function parts(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/**
 * A real timestamp, in Eastern. `"Sep 30 2026, 11:34pm (EDT)"`.
 *
 * 🔴 FOR TIMESTAMPS ONLY — a moment that actually happened. A GoHighLevel DATE
 * field is NOT one: it is stored at UTC midnight and means a calendar day, so
 * converting it would render March 14 as March 13. Those go through
 * `formatGhlDate`, which stays in UTC, and the reason is at the top of this
 * file.
 *
 * "" when there is no usable value — never "Invalid Date", and never today's
 * date standing in for a missing one.
 */
export function formatEastern(iso: unknown): string {
  if (iso == null || iso === "") return "";
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return "";
  const p = parts(EASTERN, d);
  const mer = (p.dayPeriod || "").toLowerCase();
  return `${p.month} ${p.day} ${p.year}, ${p.hour}:${p.minute}${mer} (${p.timeZoneName})`;
}

/**
 * The Eastern calendar DAY of a timestamp. `"Sep 30 2026"`.
 *
 * ⚠️ THE DAY MUST BE TAKEN IN THE SAME ZONE AS THE CLOCK, which is the whole
 * trap: `2026-10-01T03:34Z` is the 1st in UTC and the 30th in Eastern, so a
 * date part computed from `getUTCDate()` beside an Eastern time prints the
 * right time on the wrong day. Anything showing a day without a time uses this.
 */
export function formatEasternDay(iso: unknown): string {
  if (iso == null || iso === "") return "";
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return "";
  const p = parts(EASTERN_DAY, d);
  return `${p.month} ${p.day} ${p.year}`;
}

/** `"Sep 30"` — the Eastern day without the year, for a dense note header. */
export function formatEasternShort(iso: unknown): string {
  const full = formatEasternDay(iso);
  return full ? full.replace(/ \d{4}$/, "") : "";
}

/**
 * `"Sep 30 2026, 11:34pm"` — Eastern, with the zone label left off.
 *
 * ⚠️ FOR A LIST WHERE EVERY ROW IS THE SAME ZONE and one header says so.
 * Repeating "(EDT)" down forty rows is wallpaper; dropping it where a reader
 * cannot know the zone is the fault wallpaper is preferable to. The caller
 * chooses, and the ones that do are named in the round report.
 */
export function formatEasternNoZone(iso: unknown): string {
  const s = formatEastern(iso);
  return s ? s.replace(/ \([A-Z]{2,5}\)$/, "") : "";
}
