#!/usr/bin/env node
/**
 * STEP 0 — confirm live GHL email templates + the outbound send shape + which
 * Version header the tenant accepts + the emailFrom requirement. Run where the
 * PIT works.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:PROBE_CONTACT_ID="<a TEST contact id>"    # optional: tests a real send
 *   $env:PROBE_EMAIL_FROM="verified@yourdomain"    # optional: verified sender
 *   node scripts/email-templates-probe.mjs
 *
 * ⚠️ If PROBE_CONTACT_ID is set this sends ONE real email. Use a test contact,
 * and only when you accept the domain caveat (may land in spam pre-auth).
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const CONTACT = (process.env.PROBE_CONTACT_ID || "").trim();
const FROM = (process.env.PROBE_EMAIL_FROM || "").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

function H(version) {
  return { Authorization: `Bearer ${TOKEN}`, Version: version, Accept: "application/json" };
}

async function hit(label, url, { version = "2021-07-28", ...opts } = {}) {
  const res = await fetch(url, { headers: { ...H(version), ...(opts.headers || {}) }, ...opts });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log(`\n=== ${label}  (Version ${version}) ===`);
  console.log("HTTP", res.status, "→", url.replace(BASE, ""));
  if (res.status === 401 || res.status === 403)
    console.log("→ AUTH FAIL: PIT likely lacks this scope (templates read / conversations email send).");
  console.log(typeof j === "string" ? j.slice(0, 700) : JSON.stringify(j, null, 2).slice(0, 1000));
  return { status: res.status, j };
}

async function main() {
  // 1) LIST email templates — try both Version headers.
  const tUrl = `${BASE}/locations/${LOC}/templates?type=email&limit=100&offset=0`;
  const a = await hit("LIST email templates", tUrl, { version: "2021-04-15" });
  if (!a.status || a.status >= 400) await hit("LIST email templates (alt Version)", tUrl, { version: "2021-07-28" });
  if (a.j && (a.j.templates || a.j.data)) {
    const first = (a.j.templates || a.j.data)[0];
    if (first) console.log("\nFirst template keys:", Object.keys(first).join(", "));
  }

  // 2) SEND via outbound — try 2021-04-15 first.
  if (CONTACT) {
    const payload = {
      type: "Email",
      contactId: CONTACT,
      emailSubject: "OLTL templates probe (safe to ignore)",
      emailBody: "<p>Test send from the OLTL dashboard templates probe.</p>",
      ...(FROM ? { emailFrom: FROM } : {}),
    };
    const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
    const s = await hit("SEND /conversations/messages/outbound", `${BASE}/conversations/messages/outbound`, { version: "2021-04-15", ...opts });
    if (!s.status || s.status >= 400) await hit("SEND outbound (alt Version)", `${BASE}/conversations/messages/outbound`, { version: "2021-07-28", ...opts });
  } else {
    console.log("\n(Skip send test — set PROBE_CONTACT_ID to test the outbound send.)");
  }

  console.log("\n>> Report back:");
  console.log(">>  • Templates list: which Version returned 200, and each template's id / name / subject / html field names.");
  console.log(">>  • Send: which Version returned 2xx, the response id field, and whether emailFrom was required (400 without it?).");
}
main().catch((e) => { console.error(e); process.exit(1); });
