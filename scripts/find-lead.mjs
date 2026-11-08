// ---------------------------------------------------------------------------
// FIND LEAD — why is this person (by phone) not on the dashboard?
//
// For each phone number, in the main account and (optionally) ODP:
//   1. is there a contact with this number?  (GoHighLevel's instant duplicate
//      lookup — the same one the dashboard uses — not the search index, which
//      lags a new contact by up to a minute)
//   2. what cases (opportunities) does that contact have — pipeline, stage,
//      status, owner, created
//   3. does the dashboard load that pipeline, and on which board?
//   4. a plain verdict: why it is or is not on the dashboard
//
// READ-ONLY. Nothing is written to either account.
//
// 🔴 ROUND 196 — NO TOKENS IN THIS FILE. Earlier copies had both accounts'
// private integration tokens pasted at the top; a file gets shared, committed
// and uploaded, and every copy carries them. They now come from the
// environment only. ROTATE the two that were pasted before (GoHighLevel →
// Settings → Private Integrations), then set the new ones here:
//
// Run (from the project folder):
//   MAIN_PIT=<main account token> ODP_PIT=<ODP token> \
//   npx tsx scripts/find-lead.mjs +17176921647 +14129025440
//
// Optional: MAIN_LOCATION_ID / ODP_LOCATION_ID (defaults below are the two
// accounts' location ids, which are not secrets). Leave ODP_PIT unset to
// check the main account only.
// ---------------------------------------------------------------------------

const MAIN = { pit: "", location: "anzcWt3S0tzpu2fEaS8X" }; // Miracle Makers
const ODP = { pit: "", location: "bOk1rJMyaX83pQi2CA3v" }; // ODP

const SCRIPT_VERSION = "find-lead 196.1";
const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/+$/, "");
const CONFIG_NAME = "MM Pipeline Folders";
const clean = (v) => String(v || "").trim().replace(/^Bearer\s+/i, "");
const accounts = [
  { name: "main", pit: clean(process.env.MAIN_PIT || MAIN.pit), loc: clean(process.env.MAIN_LOCATION_ID || MAIN.location) },
  { name: "ODP", pit: clean(process.env.ODP_PIT || ODP.pit), loc: clean(process.env.ODP_LOCATION_ID || ODP.location) },
].filter((a) => a.pit && !/^PASTE/.test(a.pit) && a.loc && !/^PASTE/.test(a.loc));
const phones = process.argv.slice(2).filter((a) => /\d/.test(a));
if (!accounts.length) { console.log("Set MAIN_PIT (and ODP_PIT for the ODP account) — see the top of this file. Tokens are never read from this file."); process.exit(1); }
if (!phones.length) { console.log("Give one or more phone numbers, e.g.  npx tsx scripts/find-lead.mjs +17176921647"); process.exit(1); }

const RED = (s) => `\x1b[31m${s}\x1b[0m`, GREEN = (s) => `\x1b[32m${s}\x1b[0m`, YEL = (s) => `\x1b[33m${s}\x1b[0m`, DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digits = (s) => String(s || "").replace(/\D/g, "");
/** US numbers as +1 and 10 digits — the form GoHighLevel stores. */
function e164(raw) {
  const d = digits(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return raw.trim().startsWith("+") ? `+${d}` : "";
}
const when = (v) => {
  const d = new Date(String(v || ""));
  return isNaN(d.getTime()) ? "?" : d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
};

async function api(acct, path) {
  for (let i = 1; ; i++) {
    const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${acct.pit}`, Version: "2021-07-28", Accept: "application/json" } });
    if (r.status === 429 && i < 5) { await new Promise((x) => setTimeout(x, 1500 * i)); continue; }
    const t = await r.text();
    let j = {};
    try { j = t ? JSON.parse(t) : {}; } catch { j = {}; }
    if (!r.ok) throw new Error(`${acct.name}: GET ${path.split("?")[0]} → ${r.status} ${(j.message || t).toString().slice(0, 160)}`);
    return j;
  }
}
async function apiPost(acct, path, body) {
  const r = await fetch(BASE + path, { method: "POST", headers: { Authorization: `Bearer ${acct.pit}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${acct.name}: POST ${path} → ${r.status}`);
  return j;
}

async function accountContext(acct) {
  const loc = encodeURIComponent(acct.loc);
  const [pipes, cv, users] = await Promise.all([
    api(acct, `/opportunities/pipelines?locationId=${loc}`),
    api(acct, `/locations/${loc}/customValues`),
    api(acct, `/users/?locationId=${loc}`).catch(() => ({ users: [] })),
  ]);
  const pipelines = new Map((pipes.pipelines || []).map((p) => [p.id, p]));
  let config = null;
  const v = (cv.customValues || []).find((x) => norm(x.name) === norm(CONFIG_NAME));
  if (v) { try { config = JSON.parse(v.value); } catch { config = null; } }
  const userName = new Map((users.users || []).map((u) => [u.id, u.name || [u.firstName, u.lastName].filter(Boolean).join(" ")]));
  return { pipelines, config, userName };
}

/** Which board loads a pipeline, mirroring getSelectedPipelines: the stored setup's scope. */
function boardFor(ctx, pipelineId) {
  const entry = ctx.config?.pipelines?.[pipelineId];
  if (!ctx.config) return { loaded: null, why: "this account has no stored dashboard setup — the dashboard falls back to its PIPELINE_IDS setting, which this script cannot see" };
  if (!entry) return { loaded: false, why: "this pipeline is not in the dashboard's setup at all (add it on the Pipelines screen)" };
  if (entry.scope === "client") return { loaded: true, board: "Clients", sidebarHidden: entry.sidebar === false, role: entry.role };
  if (entry.scope === "caregiver") return { loaded: true, board: "Recruiting" };
  return { loaded: false, why: `this pipeline is set to "${entry.scope}" on the Pipelines screen, so neither board loads it` };
}

async function findContact(acct, phone) {
  const loc = encodeURIComponent(acct.loc);
  const dup = await api(acct, `/contacts/search/duplicate?locationId=${loc}&number=${encodeURIComponent(phone)}`).catch(() => ({}));
  if (dup.contact?.id) return { contact: dup.contact, via: "instant duplicate lookup" };
  // Fallback: the search index (lags new contacts by up to a minute).
  const s = await apiPost(acct, "/contacts/search", { locationId: acct.loc, pageLimit: 10, query: digits(phone).slice(-10) }).catch(() => ({}));
  const hit = (s.contacts || []).find((c) => digits(c.phone).slice(-10) === digits(phone).slice(-10));
  return hit ? { contact: hit, via: "search index" } : { contact: null };
}

console.log(`${SCRIPT_VERSION} · checking ${phones.length} number(s) in ${accounts.map((a) => a.name).join(" + ")} · read-only\n`);
const ctxs = new Map();
for (const a of accounts) {
  try { ctxs.set(a.name, await accountContext(a)); }
  catch (e) { console.log(RED(String(e.message || e))); ctxs.set(a.name, null); }
}

for (const raw of phones) {
  const phone = e164(raw);
  console.log(`━━━ ${raw}${phone && phone !== raw ? `  (${phone})` : ""} ━━━`);
  if (!phone || digits(phone).length !== 11) { console.log(RED("  not a valid US number: expected +1 and 10 digits\n")); continue; }
  const verdicts = [];
  for (const acct of accounts) {
    const ctx = ctxs.get(acct.name);
    if (!ctx) continue;
    let found;
    try { found = await findContact(acct, phone); }
    catch (e) { console.log(RED(`  ${acct.name}: ${e.message}`)); continue; }
    if (!found.contact) { console.log(DIM(`  ${acct.name}: no contact with this number`)); continue; }
    const c = found.contact;
    let full = c;
    try { full = (await api(acct, `/contacts/${encodeURIComponent(c.id)}`)).contact || c; } catch { /* keep what we have */ }
    const name = full.contactName || full.name || [full.firstName, full.lastName].filter(Boolean).join(" ") || "(no name)";
    console.log(`  ${acct.name}: ${GREEN("contact found")} — ${name} · added ${when(full.dateAdded)}${full.source ? ` · source "${full.source}"` : ""}${(full.tags || []).length ? ` · tags: ${full.tags.join(", ")}` : ""}  ${DIM(`(${found.via}, id ${c.id})`)}`);
    let opps = [];
    try {
      const r = await api(acct, `/opportunities/search?location_id=${encodeURIComponent(acct.loc)}&contact_id=${encodeURIComponent(c.id)}&limit=100`);
      opps = r.opportunities || [];
    } catch (e) { console.log(RED(`     could not read their cases: ${e.message}`)); continue; }
    if (!opps.length) {
      console.log(YEL(`     NO CASE. The dashboard shows cases (opportunities), not bare contacts.`));
      verdicts.push(`${acct.name}: contact exists but has no case — the Facebook workflow did not create one (or it was deleted). Create the case, or fix the workflow step that should.`);
      continue;
    }
    for (const o of opps) {
      const p = ctx.pipelines.get(o.pipelineId);
      const stage = p?.stages?.find((s) => s.id === o.pipelineStageId)?.name || o.pipelineStageId || "?";
      const owner = o.assignedTo ? ctx.userName.get(o.assignedTo) || o.assignedTo : "Unassigned";
      const b = boardFor(ctx, o.pipelineId);
      console.log(`     case "${o.name}" · ${p?.name || o.pipelineId} · stage ${stage} · ${o.status || "?"} · owner ${owner} · created ${when(o.createdAt)}`);
      if (b.loaded === true) {
        const notes = [];
        if (/^reassign/i.test(stage)) notes.push("its stage is REASSIGN, which only the Master view shows");
        if (b.role === "events") notes.push("this is the Events pipeline (shown under Referrals → Events)");
        if (b.sidebarHidden) notes.push("its sidebar tab is hidden, but it is still in All clients");
        console.log(`        ${GREEN(`→ loaded on the ${b.board} board`)}${notes.length ? YEL(` · ${notes.join("; ")}`) : ""}`);
        verdicts.push(`${acct.name}: it IS on the ${b.board} board (${p?.name}). If someone cannot see it: a rep sees only cases they own or follow in pipelines they hold (owner here: ${owner}); otherwise check the filters on screen (search, Created, Office, stage chip) and press Refresh.`);
      } else if (b.loaded === false) {
        console.log(`        ${RED(`→ NOT loaded: ${b.why}`)}`);
        verdicts.push(`${acct.name}: the case is in "${p?.name || o.pipelineId}", which the dashboard does not load — ${b.why}.`);
      } else console.log(YEL(`        → ${b.why}`));
    }
  }
  if (!verdicts.length) verdicts.push("No contact with this number in any account checked. The Facebook lead never reached GoHighLevel (check the Facebook integration / lead form mapping), or it was saved with a different number.");
  console.log(`  ${"VERDICT"}:`);
  for (const v of verdicts) console.log(`   · ${v}`);
  console.log("");
}
