export function normaliseFieldName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface KnownField {
  id: string;
  name: string;
  folderLabel: string;
  folderFieldCount: number;
  options?: string[];
}

export type FieldNameVerdict =
  | { kind: "ok" }
  | { kind: "blocked"; message: string; existing: KnownField }

  | { kind: "warn"; message: string; existing: KnownField };

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

export function composeFieldName(prefix: string, name: string): string {
  const p = (prefix || "").trim();
  const n = (name || "").trim();
  if (!n) return "";
  return p ? `${p} ${n}`.replace(/\s*-\s*/, " - ").replace(/\s+/g, " ").trim() : n;
}
