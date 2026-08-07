#!/usr/bin/env node
/**
 * STEP 0 (Task 5) — confirm the GHL email-send endpoint + whether templates are
 * API-listable, and that the PIT has the conversations/email scope. Run where
 * the PIT works.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:PROBE_CONTACT_ID="<a TEST contact id you own>"   # required to test send
 *   node scripts/email-probe.mjs
 *
 * ⚠️ This DOES send one real email to PROBE_CONTACT_ID. Use a test contact you
 * control, and only after (or accepting) the domain-authentication caveat —
 * before the domain is authenticated it may land in spam.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
const CONTACT = (process.env.PROBE_CONTACT_ID || "").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

async function hit(label, url, opts = {}) {
  const res = await fetch(url, { headers: H, ...opts });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log(`\n=== ${label} ===`);
  console.log("HTTP", res.status, "→", url.replace(BASE, ""));
  if (res.status === 401 || res.status === 403)
    console.log("→ AUTH FAIL: PIT likely lacks this scope (conversations/email or templates).");
  console.log(typeof j === "string" ? j.slice(0, 600) : JSON.stringify(j, null, 2).slice(0, 900));
  return { status: res.status, j };
}

async function main() {
  // 1) Are email templates API-listable? (decides config vs live templates.)
  await hit("LIST email templates (candidate A)", `${BASE}/locations/${LOC}/templates?type=email`);
  await hit("LIST email templates (candidate B)", `${BASE}/emails/builder?locationId=${LOC}`);

  // 2) Send a test email via the Conversations API.
  if (CONTACT) {
    await hit(
      "SEND email (POST /conversations/messages type=Email)",
      `${BASE}/conversations/messages`,
      { method: "POST", headers: { ...H, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "Email",
          contactId: CONTACT,
          subject: "OLTL dashboard email probe (safe to ignore)",
          html: "<p>This is a test send from the OLTL dashboard email probe.</p>",
        }) },
    );
  } else {
    console.log("\n(Skip send test — set PROBE_CONTACT_ID to a TEST contact to test the send endpoint.)");
  }

  console.log("\n>> Report back:");
  console.log(">>  • Whether either template-list call returned 200 (and the template object shape). If yes, we can list live templates; if no, config stays the source.");
  console.log(">>  • The send call's HTTP status + response keys (messageId/conversationId), so lib/ghl.ts sendEmail() reads the right field.");
  console.log(">>  • Any 401/403 → which scope the PIT is missing.");
}
main().catch((e) => { console.error(e); process.exit(1); });
