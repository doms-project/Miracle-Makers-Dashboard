// ---------------------------------------------------------------------------
// IMPORT — value normalisation and the "append to notes" body.
//
// Its own module, not buried in the route, for one reason: the Q&A pairing and
// the apostrophe rule are the parts most likely to be wrong on a file nobody
// has seen yet, and a module can be run against a real 57-column export
// directly. A route can only be proved through a browser.
//
// ⚠️ NOTHING HERE KNOWS THE WORD "INDEED". Indeed publishes no column schema and
// their exports already vary between downloads — this file has no cover-letter
// column although a third-party guide says exports include one. Every rule below
// is a general shape rule that degrades to plain listing.
// ---------------------------------------------------------------------------

/**
 * Excel writes a leading apostrophe onto anything it would otherwise reformat —
 * leading zeros, phone numbers, dates, things that look like fractions. Most of
 * those land in TEXT fields, where the apostrophe would be stored and shown on
 * the record for ever.
 *
 *     '+1 330 397 5612   ->   +1 330 397 5612
 *
 * 🔴 LEADING ONLY, and only ONE. O'Brien and D'Angelo must survive intact, and
 * so must a value that is genuinely quoted.
 */
export function stripLeadingApostrophe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.startsWith("'") ? value.slice(1) : value;
}

/**
 * Split a full name on the FIRST space.
 *
 *     "Ebony Logan"            -> Ebony | Logan
 *     "Mary Anne Van Der Berg" -> Mary  | Anne Van Der Berg
 *     "Cher"                   -> Cher  | ""
 *
 * 🔴 NEVER the last space. "Van Der Berg" is one surname and the first-space
 * rule keeps it whole. Nothing is lost either way — joining first and last back
 * together always reconstructs the original, which is not true of a last-space
 * split that has already thrown the middle words into the wrong half.
 *
 * ⚠️ Collapse whitespace FIRST, or "  Ebony Logan" puts an empty string in
 * First Name and the row is rejected for having no identity.
 */
export function splitFullName(value: unknown): { first: string; last: string } {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { first: "", last: "" };
  const i = s.indexOf(" ");
  if (i < 0) return { first: s, last: "" };
  return { first: s.slice(0, i), last: s.slice(i + 1) };
}

/**
 * Normalise a cell for its target type. FORMAT, NEVER CONTENT.
 *
 * "Youngstown, OH" stays exactly as it is: no truncation, no title-casing, no
 * reordering. A value that cannot be normalised is passed through UNCHANGED and
 * flagged for a person to look at — an international phone that doesn't fit
 * E.164 may well be correct, and guessing is how a good number becomes a bad
 * one. Never drop, never invent.
 */
export function normaliseCell(
  value: unknown,
  kind: "text" | "number" | "date" | "phone",
): { value: unknown; unnormalised: boolean } {
  const raw = stripLeadingApostrophe(value);
  if (raw == null || String(raw).trim() === "") return { value: "", unnormalised: false };
  const s = String(raw).trim();

  if (kind === "number") {
    // Digits and ONE decimal point. A cell that holds no digits at all is not a
    // number and is handed back untouched rather than silently becoming 0.
    const cleaned = s.replace(/[^0-9.-]/g, "");
    const n = Number(cleaned);
    if (!/\d/.test(cleaned) || !Number.isFinite(n))
      return { value: s, unnormalised: true };
    // 🔴 Found by the first real run: "3 years" in a NUMERICAL field became 3
    // with nothing said. Stripping a thousands comma or a currency symbol is
    // FORMAT; stripping a WORD is CONTENT, and the person who exported the file
    // is the one who should decide whether losing it is fine. The number is
    // still written — flagging is not refusing — but it is now on the list.
    if (/[A-Za-z]/.test(s)) return { value: n, unnormalised: true };
    return { value: n, unnormalised: false };
  }

  if (kind === "date") {
    // The ISO shaping itself lives in lib/ghl.ts `toGhlDate` — one rule, one
    // place. This only reports whether it could be read as a date at all.
    const d = new Date(s);
    if (isNaN(d.getTime())) return { value: s, unnormalised: true };
    return { value: s, unnormalised: false };
  }

  // text: trim only. Everything else about it is the person's data.
  return { value: s, unnormalised: false };
}

// ---------------------------------------------------------------------------
// The note.
// ---------------------------------------------------------------------------

/** The " Answer" suffix that pairs a question column with its answer column. */
const ANSWER_SUFFIX = " Answer";

export interface NoteColumn {
  header: string;
  value: string;
}

/**
 * Lay out the body of an import note.
 *
 * Two shapes, decided per column:
 *
 *   PAIR   — a column whose header plus " Answer" is ALSO a column. The
 *            question CELL goes on one line and the answer CELL on the next,
 *            with a blank line between pairs. The header names are skipped
 *            entirely: "Qualification 1" tells the reader nothing, and the
 *            question text tells them everything.
 *
 *   PLAIN  — everything else, as "Header: value", one per line.
 *
 * ⚠️ The rule is the " Answer" SUFFIX, never the word "Qualification". A
 * different export with differently-named screener columns degrades to plain
 * listing instead of breaking — and the 15 Qualification sets are per-posting
 * anyway, so "Qualification 3" means a different question on a different file.
 *
 * ⚠️ NOT space-aligned into columns. Notes render in a proportional font, so
 * padding produces ragged output, not a table.
 *
 * ⚠️ EMPTY CELLS ARE SKIPPED. A real export has 45 empty Qualification columns;
 * rendering them would bury the nine that have content.
 */
export function buildNoteBody(cols: NoteColumn[]): string {
  const byHeader = new Map(cols.map((c) => [c.header, c]));
  const consumed = new Set<string>();
  const blocks: string[] = [];

  for (const col of cols) {
    if (consumed.has(col.header)) continue;
    const answer = byHeader.get(col.header + ANSWER_SUFFIX);
    if (answer) {
      consumed.add(answer.header);
      const q = col.value.trim();
      const a = answer.value.trim();
      // 🔴 SIBLINGS OF A PAIRED QUESTION. Found by the first real run: a
      // 57-column export has THREE columns per screener question, not two —
      // "Qualification 1", "Qualification 1 Answer" and "Qualification 1 Match".
      // The " Answer" rule alone paired the first two and then listed the third
      // as "Qualification 1 Match: Yes" between every pair, which is both noise
      // and exactly the meaningless header name the pairing exists to hide.
      //
      // The rule stays general: ANY column whose header extends a paired
      // question's header belongs to that question's set, and is printed under
      // it labelled by the SUFFIX ONLY — the shared prefix is what carries no
      // information. Nothing here knows the words "Qualification" or "Match",
      // so a differently-named export folds its own siblings the same way.
      const kin: string[] = [];
      for (const other of cols) {
        if (other === col || other === answer || consumed.has(other.header)) continue;
        if (!other.header.startsWith(col.header + " ")) continue;
        consumed.add(other.header);
        const label = other.header.slice(col.header.length + 1).trim();
        const v = other.value.trim();
        if (v) kin.push(label ? `${label}: ${v}` : v);
      }
      // A set with nothing on any side is not worth printing.
      if (!q && !a && !kin.length) continue;
      // The question cell may be empty on a posting that asked fewer questions
      // than the export has columns for; print what there is rather than
      // dropping an answer that exists.
      blocks.push([q, a, ...kin].filter(Boolean).join("\n"));
      continue;
    }
    if (!col.value.trim()) continue;
    blocks.push(`${col.header}: ${col.value.trim()}`);
  }

  // Pairs are separated by a blank line; consecutive plain lines are not. A
  // block is a "pair" when it contains a newline of its own.
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const isPair = blocks[i].includes("\n");
    const prevPair = i > 0 && blocks[i - 1].includes("\n");
    if (i > 0 && (isPair || prevPair)) out.push("");
    out.push(blocks[i]);
  }
  return out.join("\n");
}

/**
 * The first line of the note, and the DEDUPE KEY.
 *
 * 🔴 A re-import must not stack a second identical note on the same record. The
 * check is "does a note on this record already start with this heading" — so
 * the heading has to be stable for a given source and day, and must not contain
 * the batch size or the user (either can differ between two runs of the same
 * file).
 */
export function importNoteHeading(source: string, when: Date): string {
  const day = when.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `Imported from ${source || "an import"} — ${day}`;
}

/**
 * The whole note. Everything goes in the SYSTEM half of the note body (see
 * composeNoteBody in lib/ghl.ts), which the panel renders unstruck and which no
 * rep can edit or withdraw — the same protection the Move notes have. It is a
 * record of what another system said at a point in time; letting someone
 * rewrite it would let them silently rewrite imported data.
 */
export function buildImportNote(args: {
  source: string;
  when: Date;
  userName: string;
  batchSize: number;
  columns: NoteColumn[];
}): string {
  const head = importNoteHeading(args.source, args.when);
  const who = args.userName.trim() || "an administrator";
  const n = args.batchSize;
  const lines = [
    head,
    `Bulk import by ${who} · ${n} record${n === 1 ? "" : "s"} in this batch`,
    // 🔴 LOAD-BEARING. Someone reading "Status: Awaiting Review" three weeks
    // later, on a card that has reached Phone Screened, has to know which one
    // is true.
    "Answers as " +
      (args.source || "the source") +
      " recorded them at export. Not maintained by the dashboard — the record's own fields are.",
  ];
  const body = buildNoteBody(args.columns);
  return body ? `${lines.join("\n")}\n\n${body}` : lines.join("\n");
}
