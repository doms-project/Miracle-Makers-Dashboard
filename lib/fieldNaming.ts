// ---------------------------------------------------------------------------
// FIELD NAMING — the duplicate guard and the prefix suggestion.
//
// 🔴 THE ACCOUNT HAS THE EVIDENCE. Its tag list holds "odp enrollment", "odp
// enrollments" AND "source odp enrollment" — three names for one thing. Nobody
// meant to do that; each was created by someone who could not see the other
// two. Custom fields drift the same way, and a field is far more expensive to
// merge afterwards than a tag.
//
// ⚠️ ISOMORPHIC ON PURPOSE. The screen checks as you type and the route checks
// again on the way in. Two copies of this logic would drift, so there is one,
// importing nothing.
// ---------------------------------------------------------------------------

/** Case, spacing and punctuation removed — "Office", "office" and "OFFICE " are one. */
export function normaliseFieldName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface KnownField {
  id: string;
  name: string;
  folderLabel: string; // where it lives, so a warning can SAY where
  folderFieldCount: number;
  options?: string[];
}

export type FieldNameVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; message: string; existing: KnownField }
  // ⚠️ WARN, NEVER BLOCK. A false positive that stops someone working is worse
  // than a duplicate they can merge later.
  | { kind: "warn"; message: string; existing: KnownField };

/**
 * 🔴 BLOCK an exact or normalised clash. ⚠️ WARN on a similar name or an
 * identical option list — and always name WHERE the existing field lives, so
 * the person can go and look rather than guess.
 */
export function checkFieldName(
  name: string,
  known: KnownField[],
  options?: string[],
): FieldNameVerdict {
  const n = normaliseFieldName(name);
  if (!n) return { kind: "ok" };

  const exact = known.find((k) => normaliseFieldName(k.name) === n);
  if (exact)
    return {
      kind: "blocked",
      message: `“${exact.name}” already exists — the same field under a different spelling is how one thing ends up with three names.`,
      existing: exact,
    };

  // Containment, either way round: "Branch Office" vs "Office". Not fuzzy
  // distance — that fires on genuinely unrelated short names.
  const similar = known.find((k) => {
    const kn = normaliseFieldName(k.name);
    if (kn.length < 4 || n.length < 4) return false;
    return kn.includes(n) || n.includes(kn);
  });
  if (similar)
    return {
      kind: "warn",
      message: `“${similar.name}” looks like an existing field.`,
      existing: similar,
    };

  // An identical picklist is stronger evidence than a similar name: two fields
  // offering exactly the same choices are almost always the same field.
  if (options && options.length) {
    const key = [...options].map((o) => normaliseFieldName(o)).sort().join("|");
    const sameOptions = known.find(
      (k) =>
        k.options &&
        k.options.length === options.length &&
        [...k.options].map((o) => normaliseFieldName(o)).sort().join("|") === key,
    );
    if (sameOptions)
      return {
        kind: "warn",
        message: `“${sameOptions.name}” offers exactly the same choices.`,
        existing: sameOptions,
      };
  }
  return { kind: "ok" };
}

/**
 * A prefix SUGGESTION, derived from the DIVISION.
 *
 * ⚠️ Derived from the division, never the folder name — "More Details - Office"
 * is meaningless, while "CG - " and "APP - " (58 fields between them) are
 * instantly identifiable and never confused with a client field of similar
 * name.
 *
 * ⚠️ SUGGEST, DO NOT FORCE. Returned for the box to prefill; the box stays
 * editable and can be switched off.
 */
export function suggestPrefix(divisionOrPipelineName: string): string {
  const words = (divisionOrPipelineName || "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  const letters =
    words.length === 1
      ? words[0].slice(0, 3).toUpperCase()
      : words.map((w) => w[0]).join("").slice(0, 4).toUpperCase();
  return `${letters} - `;
}

/** What the field will actually be called. Shown live, round-89 style. */
export function composeFieldName(prefix: string, name: string): string {
  const p = (prefix || "").trim();
  const n = (name || "").trim();
  if (!n) return "";
  return p ? `${p} ${n}`.replace(/\s*-\s*/, " - ").replace(/\s+/g, " ").trim() : n;
}
