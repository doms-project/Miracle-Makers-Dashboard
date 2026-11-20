import { formatEasternDay } from "@/lib/dates";

export function stripLeadingApostrophe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.startsWith("'") ? value.slice(1) : value;
}

export function splitFullName(value: unknown): { first: string; last: string } {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { first: "", last: "" };
  const i = s.indexOf(" ");
  if (i < 0) return { first: s, last: "" };
  return { first: s.slice(0, i), last: s.slice(i + 1) };
}

export function normaliseCell(
  value: unknown,
  kind: "text" | "number" | "date" | "phone",
): { value: unknown; unnormalised: boolean } {
  const raw = stripLeadingApostrophe(value);
  if (raw == null || String(raw).trim() === "") return { value: "", unnormalised: false };
  const s = String(raw).trim();

  if (kind === "number") {

    const cleaned = s.replace(/[^0-9.-]/g, "");
    const n = Number(cleaned);
    if (!/\d/.test(cleaned) || !Number.isFinite(n))
      return { value: s, unnormalised: true };

    if (/[A-Za-z]/.test(s)) return { value: n, unnormalised: true };
    return { value: n, unnormalised: false };
  }

  if (kind === "date") {

    const d = new Date(s);
    if (isNaN(d.getTime())) return { value: s, unnormalised: true };
    return { value: s, unnormalised: false };
  }

  return { value: s, unnormalised: false };
}

const ANSWER_SUFFIX = " Answer";

export interface NoteColumn {
  header: string;
  value: string;
}

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

      const kin: string[] = [];
      for (const other of cols) {
        if (other === col || other === answer || consumed.has(other.header)) continue;
        if (!other.header.startsWith(col.header + " ")) continue;
        consumed.add(other.header);
        const label = other.header.slice(col.header.length + 1).trim();
        const v = other.value.trim();
        if (v) kin.push(label ? `${label}: ${v}` : v);
      }

      if (!q && !a && !kin.length) continue;

      blocks.push([q, a, ...kin].filter(Boolean).join("\n"));
      continue;
    }
    if (!col.value.trim()) continue;
    blocks.push(`${col.header}: ${col.value.trim()}`);
  }

  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const isPair = blocks[i].includes("\n");
    const prevPair = i > 0 && blocks[i - 1].includes("\n");
    if (i > 0 && (isPair || prevPair)) out.push("");
    out.push(blocks[i]);
  }
  return out.join("\n");
}

export function importNoteHeading(source: string, when: Date): string {

  const day = formatEasternDay(when);
  return `Imported from ${source || "an import"} — ${day}`;
}

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

    "Answers as " +
      (args.source || "the source") +
      " recorded them at export. Not maintained by the dashboard — the record's own fields are.",
  ];
  const body = buildNoteBody(args.columns);
  return body ? `${lines.join("\n")}\n\n${body}` : lines.join("\n");
}
