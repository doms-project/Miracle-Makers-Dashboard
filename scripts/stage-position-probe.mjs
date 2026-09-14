// ---------------------------------------------------------------------------
// ROUND 126 — DOES `position` COME BACK ON A STAGE, AND WHAT ORDER ARE THEY IN?
//
// 🔴 THIS IS THE ONE QUESTION NO FIXTURE CAN ANSWER. Round 121 fixed the
// ordering and proved it against a fake that SUPPLIES `position`. If the live
// API does not send it, `firstStage()` has nothing to sort by, falls back to
// array order, and produces a screen identical to the bug — the fallback hides
// its own failure. A fake that supplies a field the real API strips is the same
// class of harness bug as one that answers a call the real thing refuses.
//
// ⚠️ AND IT ANSWERS A SECOND QUESTION NOBODY HAS ASKED YET: if `position` IS
// present, is TRANSFERRED IN genuinely position 0? If it is, round 121's sort is
// working perfectly and still lands on the wrong stage — because the problem was
// never the ordering, it was which stage a NEW enquiry belongs in. The two
// causes need opposite fixes, and this print distinguishes them in one look.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… node scripts/stage-position-probe.mjs
//
// Read-only. One GET, nothing written.
// ---------------------------------------------------------------------------

const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();

if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}

const res = await fetch(
  `${BASE}/opportunities/pipelines?locationId=${encodeURIComponent(LOC)}`,
  {
    headers: {
      Authorization: `Bearer ${PIT}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  },
);
if (!res.ok) {
  console.error(`GoHighLevel answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const data = await res.json();
const pipelines = data.pipelines || [];
console.log(`${pipelines.length} pipeline(s).\n`);

let anyPosition = false;
let transferFirstByArray = 0;
let transferFirstByPosition = 0;

for (const p of pipelines) {
  const stages = p.stages || [];
  console.log(`── ${p.name}  (${p.id})`);
  // 🔴 EVERY KEY, VERBATIM. Not "position: 3" — the whole object, so a
  // differently-spelled ordering field (order, index, sortOrder…) is visible
  // rather than assumed absent.
  stages.forEach((s, i) => {
    console.log(`   [${i}] ${JSON.stringify(s)}`);
  });
  const keys = [...new Set(stages.flatMap((s) => Object.keys(s)))];
  console.log(`   keys present on stages: ${keys.join(", ") || "(none)"}`);

  const hasPos = stages.some((s) => Number.isFinite(Number(s.position)));
  if (hasPos) anyPosition = true;
  console.log(`   position usable: ${hasPos ? "YES" : "NO"}`);

  const isTransfer = (n) => /transferred\s*in|^transfer\b/i.test(String(n || ""));
  const byArray = stages[0];
  const byPos = hasPos
    ? [...stages].sort((a, b) => Number(a.position ?? 1e9) - Number(b.position ?? 1e9))[0]
    : null;
  if (byArray && isTransfer(byArray.name)) transferFirstByArray++;
  if (byPos && isTransfer(byPos.name)) transferFirstByPosition++;
  console.log(`   stages[0]            -> ${byArray ? byArray.name : "(none)"}`);
  console.log(`   lowest position      -> ${byPos ? `${byPos.name} (position ${byPos.position})` : "(cannot tell)"}`);
  console.log("");
}

console.log("── WHAT THIS SETTLES ────────────────────────────────────────────");
console.log(`  position present anywhere : ${anyPosition ? "YES" : "NO"}`);
console.log(`  TRANSFERRED IN is stages[0] on      : ${transferFirstByArray} pipeline(s)`);
console.log(`  TRANSFERRED IN is lowest position on: ${transferFirstByPosition} pipeline(s)`);
console.log("");
if (!anyPosition) {
  console.log("  🔴 CAUSE (a): the API does not send `position`, so sorting by it is");
  console.log("     a no-op and firstStage() falls back to array order — today's");
  console.log("     behaviour exactly. Ordering cannot be the fix.");
} else if (transferFirstByPosition) {
  console.log("  🔴 CAUSE (c), WHICH NOBODY HAD CONSIDERED: `position` IS sent and");
  console.log("     TRANSFERRED IN genuinely holds the lowest one. The sort is working");
  console.log("     and still lands on the wrong stage, because the question was never");
  console.log("     'which stage is first' but 'which stage does a NEW enquiry enter'.");
} else {
  console.log("  ✅ position is sent and the lowest one is not a transfer stage, so");
  console.log("     ordering alone would have been enough on this account.");
}
console.log("");
console.log("  ⚠️ EITHER WAY, round 126 stops depending on the answer: a new enquiry");
console.log("     is filed by what a stage MEANS, never by where it sits.");
