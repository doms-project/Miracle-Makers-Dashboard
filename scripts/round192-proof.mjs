// ---------------------------------------------------------------------------
// ROUND 192 PROOF — a lead still labelled "New lead" stays on top until it is
// opened; everything else follows latest activity, below those leads.
// Run: npx tsx scripts/round192-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const A = await import("../lib/activity.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const order = (rows) => A.byLatestActivity(rows).map((r) => r.id);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1 · The owner's example");
// Two unopened leads from this week, and an OLD case whose stage was changed
// today — the newest activity on the board.
const leadA = { id: "lead-A", newLead: true, createdAt: "2026-11-02T14:00:00Z" };
const leadB = { id: "lead-B", newLead: true, createdAt: "2026-11-05T14:00:00Z" };
const oldMoved = { id: "old-moved", newLead: false, createdAt: "2026-06-01T14:00:00Z", stageChangedAt: "2026-11-07T15:00:00Z" };
const quiet = { id: "quiet", newLead: false, createdAt: "2026-10-20T14:00:00Z" };
const got = order([quiet, oldMoved, leadA, leadB]);
ok("unopened leads first (newest of them first), then the old case moved today, then the rest", eq(got, ["lead-B", "lead-A", "old-moved", "quiet"]), got);

console.log("2 · Opening a lead releases it");
const opened = { ...leadB, newLead: false };
const got2 = order([quiet, oldMoved, leadA, opened]);
ok("once opened, it leaves the top and takes its place by activity", eq(got2, ["lead-A", "old-moved", "lead-B", "quiet"]), got2);
const openedAndEdited = { ...opened, updatedAt: "2026-11-07T16:00:00Z" };
const got3 = order([quiet, oldMoved, leadA, openedAndEdited]);
ok("an opened lead that is then edited is top of the rest, still under the unopened one", eq(got3, ["lead-A", "lead-B", "old-moved", "quiet"]), got3);

console.log("3 · Edges");
ok("a record with no label at all is not pinned", eq(order([{ id: "x", createdAt: "2026-11-07T00:00:00Z" }, leadA]), ["lead-A", "x"]));
ok("only a real true pins (not a string)", !A.isUnopenedNewLead({ newLead: "true" }) && A.isUnopenedNewLead({ newLead: true }));
ok("an unopened lead with no readable date is still above the rest", eq(order([quiet, { id: "nodate", newLead: true }]), ["nodate", "quiet"]));

console.log("4 · Wired into the page");
const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
ok("every view still reads byLatestActivity (round 191)", /byLatestActivity\(data\)/.test(src) && /byLatestActivity\(cgData\)/.test(src));
ok("opening a case clears its label on screen at once, so it leaves the top without a reload", /prev\.map\(\(x\) => \(x\.id === id \? \{ \.\.\.x, newLead: false \} : x\)\)/.test(src));
ok("a refused open puts the label back, and the lead back on top", /prev\.map\(\(x\) => \(x\.id === id \? \{ \.\.\.x, newLead: true \} : x\)\)/.test(src));
ok("a Sort the viewer picks still wins", /if \(!sortKey\) return base;/.test(src) && /if \(!cgSortKey\) return cgFocused;/.test(src));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
