// ---------------------------------------------------------------------------
// ROUND 102 — /api/admin/pipelines AGAINST A FAKE GoHighLevel.
//
// 🔴 THIS ROUND CHANGES A WRITE PATH TO A LIVE CUSTOM VALUE. `getPipelineConfig`
// now backfills folder names and PERSISTS them, inside a function every request
// path calls. A green build proves none of that. What must be true:
//
//   1. an account seeded BEFORE folderNames existed gets the three names
//   2. the backfill NEVER overwrites a name an admin typed
//   3. Event Details is NOT ticked onto client pipelines by being named
//   4. the all-system folder is withheld from the checklist AND the banner
//   5. saving does not silently untick a withheld folder that was stored
//
// Run: node scripts/pipelines-seed-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn } from "node:child_process";

const LOC = "loc_test";
const WIF = "1JFUFsjPXNFzMW18dYSe"; // Website Intent Form
const EVD = "56mZT4dH0xztuxwgUt00"; // Event Details
const REF = "9OZdxXFfJsdNGR7qsQKQ"; // Referral Detail
const SYS = "PQ1X601wYiGy9YsvKGSj"; // all-system folder
// ⚠️ THE REAL id of FOLDERS.shared (lib/fieldFolders.ts:13). The first run of
// this harness invented one, which has no curated label, so the route quite
// correctly reported it as a folder needing a label — a fixture bug that read
// as a code bug. A harness that does not reproduce the production shape proves
// nothing.
const SHARED = "B6cunntgpATjWseEb1iC";

let pass = 0,
  fail = 0;
const ok = (n, c, got) => {
  if (c) {
    pass++;
    console.log(`  ok   ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`);
  }
};

// The stored custom value, as GoHighLevel holds it. Starts SEEDED but with NO
// folderNames key at all — exactly the live account's state.
let stored = JSON.stringify({
  seeded: true,
  pipelines: {
    pipe_oltl: { scope: "client", folders: ["shared", WIF, SYS] },
    pipe_cg: { scope: "caregiver", folders: ["shared"] },
  },
});
const writes = [];

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (u.startsWith(`/locations/${LOC}/customValues`)) {
      if (req.method === "PUT" || req.method === "POST") {
        stored = j.value;
        writes.push(j.value);
        return send(200, { customValue: { id: "cv1", name: "MM Pipeline Folders", value: stored } });
      }
      return send(200, {
        customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: stored }],
      });
    }
    if (u.startsWith(`/locations/${LOC}/customFields`))
      return send(200, {
        customFields: [
          { id: "f1", name: "Harmony ID", dataType: "TEXT", parentId: SHARED },
          { id: "f2", name: "I want to.", dataType: "TEXT", parentId: WIF },
          { id: "f3", name: "Event Cost", dataType: "MONETORY", parentId: EVD },
          { id: "f4", name: "Event Date", dataType: "DATE", parentId: EVD },
          { id: "f5", name: "Referring Partner", dataType: "TEXT", parentId: REF },
          // 🔴 THE ALL-SYSTEM FOLDER. One HIDDEN_NAMES field, one
          // SYSTEM_INFO_NAMES field, and nothing else.
          { id: "f6", name: "Reassign Followers", dataType: "TEXT", parentId: SYS },
          { id: "f7", name: "APP - Compliance Cleared", dataType: "TEXT", parentId: SYS },
        ],
      });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, {
        pipelines: [
          { id: "pipe_oltl", name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW LEAD" }] },
          { id: "pipe_cg", name: "PP Caregiver Applicants", stages: [{ id: "s2", name: "NEW" }] },
        ],
      });
    if (u.startsWith("/users/")) return send(200, { users: [] });
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

const PORT = 3437;
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: {
    ...process.env,
    GHL_API_BASE: `http://127.0.0.1:${fp}`,
    GHL_LOCATION_ID: LOC,
    GHL_PIT: "pit_test",
    PIPELINE_IDS: "pipe_oltl",
    CAREGIVER_PIPELINE_IDS: "pipe_cg",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", () => {});
dev.stderr.on("data", (d) => {
  const s = String(d);
  if (/EADDRINUSE/.test(s)) process.stdout.write(`[dev] ${s}`);
});

const get = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/pipelines`, {
    signal: AbortSignal.timeout(40000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try {
    const r = await get();
    if (r.status) up = true;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!up) {
  console.log("dev server never came up");
  dev.kill();
  fake.close();
  process.exit(1);
}

console.log("\nBEFORE — the stored value, as the live account has it:");
console.log(`  ${stored}\n`);

const a = await get();
const cfg = a.body.config || {};

console.log("1 · THE BACKFILL");
ok("three folder names are now present", Object.keys(cfg.folderNames || {}).length === 3, cfg.folderNames);
ok(`  ${WIF} = Website Intent Form`, cfg.folderNames?.[WIF] === "Website Intent Form", cfg.folderNames?.[WIF]);
ok(`  ${EVD} = Event Details`, cfg.folderNames?.[EVD] === "Event Details", cfg.folderNames?.[EVD]);
ok(`  ${REF} = Referral Detail`, cfg.folderNames?.[REF] === "Referral Detail", cfg.folderNames?.[REF]);
ok("it was PERSISTED, not just served from memory", writes.length === 1, writes.length);
ok("the seeded flag is untouched", cfg.seeded === true, cfg.seeded);

console.log("\n2 · 🔴 NAMING IS NOT TICKING");
ok(
  "Event Details was NOT added to the client pipeline",
  !cfg.pipelines?.pipe_oltl?.folders?.includes(EVD),
  cfg.pipelines?.pipe_oltl?.folders,
);
ok(
  "Referral Detail was NOT added either",
  !cfg.pipelines?.pipe_oltl?.folders?.includes(REF),
  cfg.pipelines?.pipe_oltl?.folders,
);
ok(
  "the pipelines map is otherwise unchanged",
  JSON.stringify(cfg.pipelines?.pipe_oltl?.folders) === JSON.stringify(["shared", WIF, SYS]),
  cfg.pipelines?.pipe_oltl?.folders,
);

console.log("\n3 · THE BANNERS");
const unc = a.body.unconfiguredFolders || [];
ok("no folder is asking to be labelled any more", unc.length === 0, unc.map((u) => u.id));
const secIds = (a.body.sections || []).map((s) => s.id);
ok("the three named folders are in the checklist", [WIF, EVD, REF].every((i) => secIds.includes(i)), secIds);
ok("🔴 the all-system folder is NOT in the checklist", !secIds.includes(SYS), secIds);
ok(
  "  it is reported as withheld instead of vanishing",
  (a.body.inertSections || []).some((s) => s.id === SYS),
  a.body.inertSections,
);

console.log("\n4 · AN ADMIN'S OWN NAME WINS");
stored = JSON.stringify({
  seeded: true,
  folderNames: { [EVD]: "Expo details (ours)" },
  pipelines: { pipe_oltl: { scope: "client", folders: ["shared"] } },
});
writes.length = 0;
const b = await get();
ok(
  "a name already stored is NOT overwritten",
  b.body.config?.folderNames?.[EVD] === "Expo details (ours)",
  b.body.config?.folderNames?.[EVD],
);
ok(
  "  and the missing two are still filled in",
  b.body.config?.folderNames?.[WIF] === "Website Intent Form" &&
    b.body.config?.folderNames?.[REF] === "Referral Detail",
  b.body.config?.folderNames,
);

console.log("\n5 · SAVING CANNOT UNTICK WHAT THE SCREEN NEVER SAW");
stored = JSON.stringify({
  seeded: true,
  folderNames: { [WIF]: "Website Intent Form", [EVD]: "Event Details", [REF]: "Referral Detail" },
  pipelines: { pipe_oltl: { scope: "client", folders: ["shared", SYS] } },
});
const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/pipelines`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  // The screen sends what it RENDERS — and it no longer renders SYS at all.
  body: JSON.stringify({
    action: "save-config",
    config: {
      seeded: true,
      folderNames: {},
      pipelines: { pipe_oltl: { scope: "client", folders: ["shared"] } },
    },
  }),
  signal: AbortSignal.timeout(40000),
});
const saved = (await r.json().catch(() => ({}))).config || {};
ok(
  "🔴 the withheld folder's stored tick SURVIVED the save",
  saved.pipelines?.pipe_oltl?.folders?.includes(SYS),
  saved.pipelines?.pipe_oltl?.folders,
);
ok(
  "  and the names were not erased by a screen that sends none",
  Object.keys(saved.folderNames || {}).length === 3,
  saved.folderNames,
);

dev.kill("SIGTERM");
fake.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
