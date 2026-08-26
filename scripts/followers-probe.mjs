#!/usr/bin/env node
/**
 * STEP 0 (Task 5) — confirm the GHL follower add/remove endpoints + shapes.
 * Requires the GHL setting "Allow different owners for contacts and its
 * opportunities" enabled (both sync sub-settings OFF). Run where the PIT works.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:PROBE_OPP_ID="<an opportunity id>"
 *   $env:PROBE_USER_ID="<a user id to add/remove as follower>"
 *   node scripts/followers-probe.mjs
 *
 * ⚠️ This ADDS then REMOVES the user as a follower on PROBE_OPP_ID (net no-op
 * if the user wasn't already a follower). Use a test opportunity.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const OPP = (process.env.PROBE_OPP_ID || "").trim();
const USER = (process.env.PROBE_USER_ID || "").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
if (!OPP || !USER) { console.error("Set PROBE_OPP_ID and PROBE_USER_ID."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function hit(label, method) {
  const res = await fetch(`${BASE}/opportunities/${OPP}/followers`, {
    method, headers: H, body: JSON.stringify({ followers: [USER] }),
  });
  const body = await j(res);
  console.log(`\n=== ${label} (${method}) ===`);
  console.log("HTTP", res.status);
  if (res.status === 401 || res.status === 403)
    console.log("→ AUTH/SETTING: PIT scope, or the 'different owners' setting may be off.");
  console.log(typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body, null, 2).slice(0, 700));
  return body;
}

async function main() {
  const added = await hit("ADD follower", "POST");
  await hit("REMOVE follower", "DELETE");
  console.log("\n>> Report: the ADD/REMOVE HTTP statuses and the response body's follower field name");
  console.log(">> (followers vs followersAdded/Removed) so lib/ghl.ts reads the right key.");
  console.log(">> Response keys (ADD):", added && typeof added === "object" ? Object.keys(added).join(", ") : "(non-JSON)");
}
main().catch((e) => { console.error(e); process.exit(1); });
