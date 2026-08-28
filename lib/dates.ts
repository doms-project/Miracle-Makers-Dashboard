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

// A field that is MEANT to carry a time, by its GHL name — e.g.
// "AAA In Person Date and Time", "MCO In Person Date and Time". Name-driven so
// adding another such field in GHL needs no code change and no hardcoded id.
export function isDateTimeField(name: string): boolean {
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
  if (!wantTime) return date;
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  // The zone is stated rather than silently converted: these are appointment
  // times entered by staff, and quietly shifting them by the viewer's browser
  // timezone is worse than being explicit.
  return `${date}, ${h}:${mm} ${h24 < 12 ? "AM" : "PM"} UTC`;
}

// Value for <input type="date"> — always "YYYY-MM-DD".
export function toDateInput(v: unknown): string {
  const d = parseGhlDate(v);
  return d ? d.toISOString().slice(0, 10) : "";
}

// Value for <input type="datetime-local"> — always "YYYY-MM-DDTHH:MM".
export function toDateTimeInput(v: unknown): string {
  const d = parseGhlDate(v);
  return d ? d.toISOString().slice(0, 16) : "";
}
