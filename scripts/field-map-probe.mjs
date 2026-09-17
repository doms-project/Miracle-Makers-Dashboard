// ---------------------------------------------------------------------------
// ROUND 131 · ITEM 3 — CAN A FIELD MAP BE DERIVED FROM NAMES, OR MUST IT BE
// MAINTAINED BY HAND?
//
// 🔴 THIS IS THE QUESTION THE WHOLE TRANSFER HANGS ON, AND IT CANNOT BE
// ANSWERED BY ARGUING ABOUT IT. Every field has a different id in the other
// sub-account, so step 2 of a transfer is a translation table. Whether that
// table can be generated is a measurement of the two accounts' field lists, not
// an opinion about naming discipline — and the brief already names two reasons
// to distrust names ("Lost ReasonS" plural on one, "FB Private Pay Form" twice
// on the other).
//
// So this counts. It reads both accounts, matches by normalised name, and puts
// every field in exactly one bucket:
//
//   CARRIES      one name, one field each side, compatible types
//   RETYPE       matched, but the two sides are different dataTypes
//   OPTIONS      matched SINGLE/MULTIPLE_OPTIONS whose option sets differ
//   AMBIGUOUS    the name occurs more than once on one side — a coin toss
//   NEAR         no exact match, but one candidate after plural/punctuation
//   LOST         on SELF and nowhere on PEER — a transfer drops this value
//   SPARE        on PEER and nowhere on SELF — nothing will ever fill it
//
// ⚠️ IT WRITES NOTHING AND IT PROPOSES NOTHING AS SETTLED. NEAR is printed for
// a person to accept or reject; a script that silently paired "Lost Reason"
// with "Lost Reasons" would be guessing with somebody's case history.
//
// Run:
//   GHL_PIT=<self>  GHL_LOCATION_ID=<self>  \
//   PEER_PIT=<peer> PEER_LOCATION_ID=<peer> \
//   node scripts/field-map-probe.mjs [> map.json]
//
// Read-only: four GETs, nothing written to either account.
// ---------------------------------------------------------------------------

const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const SELF = {
  pit: (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, ""),
  loc: (process.env.GHL_LOCATION_ID || "").trim(),
  label: process.env.SELF_LABEL || "SELF",
};
const PEER = {
  pit: (process.env.PEER_PIT || "").trim().replace(/^Bearer\s+/i, ""),
  loc: (process.env.PEER_LOCATION_ID || "").trim(),
  label: process.env.PEER_LABEL || "PEER",
};
for (const a of [SELF, PEER])
  if (!a.pit || !a.loc) {
    console.error(
      "Set GHL_PIT / GHL_LOCATION_ID (this account) and PEER_PIT / PEER_LOCATION_ID (the other).",
    );
    process.exit(1);
  }

async function fields(acct, model) {
  const url = `${BASE}/locations/${encodeURIComponent(acct.loc)}/customFields?model=${model}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${acct.pit}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`${acct.label} ${model}: GoHighLevel answered ${res.status} — ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  return ((await res.json()).customFields || []).map((f) => ({
    id: String(f.id || ""),
    name: String(f.name || ""),
    dataType: String(f.dataType || ""),
    options: (f.picklistOptions || f.options || []).map(String),
  }));
}

/** Exact key: what two accounts must agree on for a match to be safe. */
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Loose key: plus a trailing plural. Used ONLY to propose, never to pair. */
const loose = (s) => key(s).replace(/s$/, "");
const OPTIONY = /OPTION|RADIO|CHECKBOX/i;

function compare(selfDefs, peerDefs, model) {
  const index = (defs, k) => {
    const m = new Map();
    for (const d of defs) {
      const kk = k(d.name);
      if (!m.has(kk)) m.set(kk, []);
      m.get(kk).push(d);
    }
    return m;
  };
  const sExact = index(selfDefs, key);
  const pExact = index(peerDefs, key);
  const pLoose = index(peerDefs, loose);

  const out = { carries: [], retype: [], options: [], ambiguous: [], near: [], lost: [], spare: [] };

  for (const d of selfDefs) {
    const k = key(d.name);
    const mine = sExact.get(k) || [];
    const theirs = pExact.get(k) || [];
    // 🔴 AMBIGUITY ON EITHER SIDE IS AMBIGUITY. "FB Private Pay Form" exists
    // twice on the main account: a match that picks one of them is not a match,
    // it is a fifty-fifty bet placed on every transfer from now on.
    if (mine.length > 1 || theirs.length > 1) {
      out.ambiguous.push({ name: d.name, id: d.id,
        here: mine.map((x) => x.id), there: theirs.map((x) => x.id) });
      continue;
    }
    const t = theirs[0];
    if (!t) {
      const cand = (pLoose.get(loose(d.name)) || []).filter((x) => !pExact.has(key(x.name)) || true);
      if (cand.length === 1)
        out.near.push({ name: d.name, id: d.id, candidate: cand[0].name, candidateId: cand[0].id,
          sameType: cand[0].dataType === d.dataType });
      else out.lost.push({ name: d.name, id: d.id, dataType: d.dataType });
      continue;
    }
    if (t.dataType !== d.dataType) {
      out.retype.push({ name: d.name, here: d.dataType, there: t.dataType, ids: [d.id, t.id] });
      continue;
    }
    if (OPTIONY.test(d.dataType)) {
      const only = (a, b) => a.filter((o) => !b.some((x) => key(x) === key(o)));
      const missing = only(d.options, t.options);
      if (missing.length) {
        out.options.push({ name: d.name, ids: [d.id, t.id], valuesWithNoHome: missing });
        continue;
      }
    }
    out.carries.push({ name: d.name, from: d.id, to: t.id, dataType: d.dataType });
  }
  for (const d of peerDefs)
    if (!sExact.has(key(d.name))) out.spare.push({ name: d.name, id: d.id });

  return { model, ...out };
}

const report = [];
for (const model of ["contact", "opportunity"]) {
  const [s, p] = await Promise.all([fields(SELF, model), fields(PEER, model)]);
  report.push({ ...compare(s, p, model), counts: { self: s.length, peer: p.length } });
}

const line = (n, v) => console.error(`   ${String(v).padStart(4)}  ${n}`);
console.error(`\n═══ ${SELF.label} → ${PEER.label} ═══`);
let carries = 0, needsHand = 0, total = 0;
for (const r of report) {
  console.error(`\n── ${r.model.toUpperCase()}  (${r.counts.self} here · ${r.counts.peer} there) ──`);
  line("CARRIES    name + type + options all agree", r.carries.length);
  line("RETYPE     matched, different dataType", r.retype.length);
  line("OPTIONS    matched, values with no home there", r.options.length);
  line("AMBIGUOUS  the name is not unique", r.ambiguous.length);
  line("NEAR       one candidate, needs a human", r.near.length);
  line("LOST       nothing there to receive it", r.lost.length);
  line("SPARE      there, nothing here to fill it", r.spare.length);
  carries += r.carries.length;
  needsHand += r.retype.length + r.options.length + r.ambiguous.length + r.near.length;
  total += r.counts.self;
  for (const [label, rows] of [
    ["AMBIGUOUS", r.ambiguous], ["RETYPE", r.retype], ["OPTIONS", r.options],
    ["NEAR", r.near], ["LOST", r.lost],
  ]) {
    if (!rows.length) continue;
    console.error(`\n   ${label}`);
    for (const x of rows.slice(0, 25))
      console.error(`     · ${JSON.stringify(x)}`);
    if (rows.length > 25) console.error(`     … and ${rows.length - 25} more`);
  }
}

console.error("\n── WHAT THIS SETTLES ────────────────────────────────────────────");
const pct = total ? Math.round((carries / total) * 100) : 0;
console.error(`  ${carries} of ${total} fields (${pct}%) would translate from the name alone.`);
console.error(`  ${needsHand} need a decision a script cannot make for you.`);
if (needsHand === 0)
  console.error("  ✅ A DERIVED MAP IS ENOUGH — but re-run this after any field is added.");
else
  console.error(
    "  🔴 A DERIVED MAP IS A STARTING POINT, NOT THE ANSWER. The rows above are\n" +
    "     the hand-maintained part: they are what a transfer would get wrong\n" +
    "     silently if the map were generated and trusted.",
  );
console.error("\n  The JSON on stdout is the starting table. Review it, then store it.\n");

// stdout is the artefact; stderr is the reading. `> map.json` keeps them apart.
console.log(JSON.stringify(report, null, 2));
