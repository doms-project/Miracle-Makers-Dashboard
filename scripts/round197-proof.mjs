// ---------------------------------------------------------------------------
// ROUND 197 PROOF — New Leads (to sort), Staffing needed lead, the Sort and
// Assign paths, the Access switches and the renameable tab names.
//
// Drives the PURE rules in lib/sorting.ts with literals, round-trips the two
// stored values, and checks the routes and the page are wired to those rules
// (a renamed function or a lost guard fails HERE, not on the live account).
// Run: npx tsx scripts/round197-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import * as S from "../lib/sorting.ts";
import { parsePipelineConfig, serialisePipelineConfig, emptyPipelineConfig } from "../lib/pipelineConfig.ts";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// The people and pipelines every case below uses.
const OE = "pOltlEnroll", OT = "pOltlTransfer", PP = "pPrivatePay", ODP = "pOdpOther";
const kim = { userId: "kim", isAdmin: false, home: new Set([OE, OT]), staffing: "off", peerTransfer: false };
const kimSelf = { ...kim, staffing: "self" };
const kimAny = { ...kim, staffing: "any" };
const kimPeer = { ...kim, peerTransfer: true };
const admin = { userId: "boss", isAdmin: true, home: new Set(), staffing: "admin", peerTransfer: true };
const lead = (o = {}) => ({ ownerId: "", pipelineId: OE, stage: "NEW LEAD", followerIds: [], ...o });

console.log("1 · Stages are matched by their REAL GoHighLevel names");
ok("NEW LEAD recognised in any case/spacing", S.isNewLeadStage(" new lead ") && !S.isNewLeadStage("New leads"));
ok("REASSIGN is the Staffing needed stage", S.isStaffingStage("Reassign") && !S.isStaffingStage("Staffing needed"));
ok("neither can be picked from a dropdown", !S.isPickableStage("NEW LEAD") && !S.isPickableStage("REASSIGN") && S.isPickableStage("IEB"));
ok("a renamed LABEL never changes the match", S.stageDisplay("REASSIGN", { staffingStage: "Needs a caregiver" }) === "Needs a caregiver" && S.isStaffingStage("REASSIGN"));
ok("other stages are shown as they are", S.stageDisplay("IEB", { staffingStage: "x" }) === "IEB");

console.log("2 · Tab names: defaults, damage and validation");
const d = S.resolveLabels(null);
ok("defaults are the agreed names", d.newLeads === "New Leads (to sort)" && d.staffingTab === "Staffing needed lead" && d.staffingStage === "Staffing needed");
ok("a damaged value falls back, never blank", S.resolveLabels({ newLeads: "   ", staffingTab: 42, staffingStage: "x".repeat(41) }).newLeads === d.newLeads && S.resolveLabels({ staffingTab: 42 }).staffingTab === d.staffingTab && S.resolveLabels({ staffingStage: "x".repeat(41) }).staffingStage === d.staffingStage);
ok("a pipeline label is read from pipeline:<id>", S.resolveLabels({ [`pipeline:${OE}`]: "Enrollments" }).pipelines[OE] === "Enrollments");
ok("over 40 characters is refused", !!S.labelProblem("x".repeat(41), []));
ok("a name another tab has is refused (any case)", !!S.labelProblem("oltl transfer", ["OLTL Transfer"]));
ok("an empty name is not an error (it means reset)", S.labelProblem("  ", ["a"]) === null);
ok("withLabel stores, and an empty name removes the key", S.withLabel({}, "newLeads", " Inbox ").newLeads === "Inbox" && !("newLeads" in S.withLabel({ newLeads: "Inbox" }, "newLeads", "")));

console.log("3 · Tab names survive the stored pipeline config, and every other save");
const cfg = { ...emptyPipelineConfig(), seeded: true, pipelines: { [OE]: { scope: "client", folders: ["shared"] } }, labels: { newLeads: "Inbox", "pipeline:x1": "Ones" } };
const back = parsePipelineConfig(serialisePipelineConfig(cfg));
ok("labels round-trip", back?.labels.newLeads === "Inbox" && back?.labels["pipeline:x1"] === "Ones");
ok("an old value with no labels parses to {}", JSON.stringify(parsePipelineConfig(JSON.stringify({ seeded: true, pipelines: {}, folderNames: {} }))?.labels) === "{}");
ok("a too-long stored label is dropped on read", !("newLeads" in (parsePipelineConfig(JSON.stringify({ seeded: true, pipelines: {}, folderNames: {}, labels: { newLeads: "x".repeat(60) } }))?.labels || {})));
const pr = read("../app/api/admin/pipelines/route.ts");
ok("the grid save carries labels (the one literal that builds a config)", /labels: current\.labels \|\| \{\}/.test(pr));
ok("labels is REQUIRED in the type, so a new literal can't forget it", /\n  labels: Record<string, string>;\n\}/.test(read("../lib/pipelineConfig.ts")));
ok("rename-tab is admin-gated (inside the gated POST) and validates server-side", /case "rename-tab"/.test(pr) && /labelProblem\(name, taken\)/.test(pr) && pr.indexOf('case "rename-tab"') > pr.indexOf("const denied = gate(request, body.ssoKey);"));

console.log("4 · Access: the two new switches are stored like the others");
const ghl = read("../lib/ghl.ts");
ok("staffing + peerTransfer in the type, the default, the parse test and the save literal",
  /staffing: Record<string, StaffingLevel>;/.test(ghl) && /staffing: \{\},\n  peerTransfer: \[\],/.test(ghl) &&
  /"staffing" in o \|\| "peerTransfer" in o/.test(ghl) && /staffing: patch\.staffing \?\? current\.staffing,/.test(ghl) && /peerTransfer: patch\.peerTransfer \?\? current\.peerTransfer,/.test(ghl));
const { asStaffing, parseAccessValue } = await import("../lib/ghl.ts").catch(() => ({}));
if (asStaffing) {
  ok("only self/any survive; junk reads as off", JSON.stringify(asStaffing({ a: "self", b: "any", c: "admin", d: true })) === JSON.stringify({ a: "self", b: "any" }));
  const v = parseAccessValue(JSON.stringify({ pipelines: { kim: [OE] }, staffing: { kim: "any" }, peerTransfer: ["kim", "kim"] }));
  ok("a value with the new keys parses, deduped", v?.staffing.kim === "any" && v?.peerTransfer.length === 1 && v?.pipelines.kim[0] === OE);
  const old = parseAccessValue(JSON.stringify({ pipelines: { kim: [OE] }, master: [] }));
  ok("an OLD value (no new keys) reads as everyone off", JSON.stringify(old?.staffing) === "{}" && JSON.stringify(old?.peerTransfer) === "[]");
} else ok("lib/ghl.ts imports for the parse checks", false);

console.log("5 · Who sees an unowned Staffing needed case (the list rule)");
ok("Off: hidden from a rep", S.staffingGateHides(lead({ stage: "REASSIGN" }), { isAdmin: false, staffing: "off" }));
ok("Take for myself / Assign to anyone: shown", !S.staffingGateHides(lead({ stage: "REASSIGN" }), { isAdmin: false, staffing: "self" }) && !S.staffingGateHides(lead({ stage: "REASSIGN" }), { isAdmin: false, staffing: "any" }));
ok("admin: always shown", !S.staffingGateHides(lead({ stage: "REASSIGN" }), { isAdmin: true, staffing: "off" }));
ok("never hides an OWNED case, or a NEW LEAD", !S.staffingGateHides(lead({ stage: "REASSIGN", ownerId: "x" }), { isAdmin: false }) && !S.staffingGateHides(lead(), { isAdmin: false }));
const pa = read("../lib/pipelineAccess.ts");
ok("the gate is opt-in and only the CLIENT board opts in (Recruiting untouched)",
  /opts\?: \{ staffingGate\?: boolean \}/.test(pa) && /\{ staffingGate: scope === "client" \}/.test(read("../app/api/opportunities/route.ts")) &&
  !/staffingGate/.test(read("../app/api/referrals/route.ts")) && !/staffingGate/.test(read("../app/api/opportunities/[id]/caregivers/search/route.ts")));
ok("a follower still sees it (managers follow while it waits)", /if \(!owned && staffingGateHides\(/.test(pa));

console.log("6 · Sort (from New Leads)");
ok("an unowned lead in my pipeline: any owner, my pipeline", S.canSort(lead(), kim, { toPipelineId: OT, newOwnerId: "bill" }).ok);
ok("my own rotation lead: I may keep or hand it on", S.canSort(lead({ ownerId: "kim" }), kim, { toPipelineId: OT }).ok && S.canSort(lead({ ownerId: "kim" }), kim, { toPipelineId: OE, newOwnerId: "bill" }).ok);
ok("a colleague's lead: refused", !S.canSort(lead({ ownerId: "bill" }), kim, { toPipelineId: OE, newOwnerId: "kim" }).ok);
ok("a lead I only FOLLOW: refused", !S.canSort(lead({ ownerId: "bill", followerIds: ["kim"] }), kim, { toPipelineId: OE }).ok);
ok("another division, no owner: allowed (send only)", S.canSort(lead(), kim, { toPipelineId: PP, newOwnerId: "" }).ok);
ok("another division WITH an owner: refused", !S.canSort(lead(), kim, { toPipelineId: PP, newOwnerId: "bill" }).ok);
ok("not a NEW LEAD: refused even for an admin", !S.canSort(lead({ stage: "IEB" }), admin, { toPipelineId: OE }).ok);
ok("admin: anything at NEW LEAD", S.canSort(lead({ ownerId: "bill", pipelineId: ODP }), admin, { toPipelineId: PP, newOwnerId: "x" }).ok);
ok("stage: owner + no stage → refused", S.sortStageProblem({ toStageName: null, finalOwner: "kim", pipelineChanged: true }) !== null);
ok("stage: unowned re-route with no stage → stays at New lead", S.sortStageProblem({ toStageName: null, finalOwner: "", pipelineChanged: true }) === null);
ok("stage: New lead / Staffing needed can't be picked", !!S.sortStageProblem({ toStageName: "NEW LEAD", finalOwner: "kim", pipelineChanged: false }) && !!S.sortStageProblem({ toStageName: "REASSIGN", finalOwner: "kim", pipelineChanged: false }));
ok("stage: a real stage is fine", S.sortStageProblem({ toStageName: "IEB", finalOwner: "kim", pipelineChanged: false }) === null);

console.log("7 · Assign (from Staffing needed)");
const waiting = lead({ stage: "REASSIGN" });
ok("Off: refused", !S.canAssignStaffing(waiting, kim, "kim").ok);
ok("Take for myself: me yes, a colleague no", S.canAssignStaffing(waiting, kimSelf, "kim").ok && !S.canAssignStaffing(waiting, kimSelf, "bill").ok);
ok("Assign to anyone: anyone", S.canAssignStaffing(waiting, kimAny, "bill").ok);
ok("not in a pipeline I hold: refused", !S.canAssignStaffing({ ...waiting, pipelineId: PP }, kimAny, "kim").ok);
ok("already owned, or not waiting: refused", !S.canAssignStaffing({ ...waiting, ownerId: "x" }, kimAny, "kim").ok && !S.canAssignStaffing(lead(), kimAny, "kim").ok);
ok("an owner is required", !S.canAssignStaffing(waiting, admin, "").ok && S.canAssignStaffing(waiting, admin, "kim").ok);

console.log("8 · Send to Staffing needed / pick up an unowned case / transfer to the other company");
ok("send: own case yes, colleague's no, unowned in my pipeline yes", S.canSendToStaffing(lead({ stage: "IEB", ownerId: "kim" }), kim).ok && !S.canSendToStaffing(lead({ stage: "IEB", ownerId: "bill" }), kim).ok && S.canSendToStaffing(lead({ stage: "IEB" }), kim).ok);
ok("send: not when it's already there", !S.canSendToStaffing(waiting, admin).ok);
ok("pick up: an unowned case in my pipeline (was admin-only)", S.canTakeUnowned(lead({ stage: "IEB" }), kim, "kim").ok);
ok("pick up: a waiting case follows the Staffing setting", !S.canTakeUnowned(waiting, kim, "kim").ok && S.canTakeUnowned(waiting, kimSelf, "kim").ok && !S.canTakeUnowned(waiting, kimSelf, "bill").ok);
ok("transfer: needs the tick", !S.canPeerTransfer(lead({ ownerId: "kim" }), kim).ok && S.canPeerTransfer(lead({ ownerId: "kim" }), kimPeer).ok);
ok("transfer: unowned in my pipeline yes; a followed or colleague's case no", S.canPeerTransfer(lead(), kimPeer).ok && !S.canPeerTransfer(lead({ ownerId: "bill", followerIds: ["kim"] }), kimPeer).ok && !S.canPeerTransfer(lead({ pipelineId: PP }), kimPeer).ok);
ok("transfer: admin always", S.canPeerTransfer(lead({ ownerId: "bill", pipelineId: ODP }), admin).ok);

console.log("9 · The routes use these rules, and the old paths are untouched");
const mv = read("../app/api/opportunities/[id]/move/route.ts");
ok("move: sort/assign have their own gate and write path", /body\.mode === "sort" \|\| body\.mode === "assign"/.test(mv) && /canSort\(target, v,/.test(mv) && /canAssignStaffing\(target, v,/.test(mv) && /await sortOpportunity\(/.test(mv));
ok("move: the sort branch returns before the transfer logic", mv.indexOf("await sortOpportunity(") < mv.indexOf("await moveOpportunity({"));
ok("move: an ordinary Move can't land a case in New lead", /isNewLeadStage\(destStageName\)/.test(mv));
ok("sortOpportunity writes NO transfer stamps and refuses other starting stages",
  (() => { const i = ghl.indexOf("export async function sortOpportunity"); const body = ghl.slice(i, ghl.indexOf("export async function moveOpportunity", i));
    return i > 0 && !/Transferred From|Transferred Date|Transfer Reason|TRANSFERRED IN/.test(body.replace(/\/\*\*[\s\S]*?\*\//, "")) && /fromStage !== "NEW LEAD"/.test(body) && /fromStage !== REASSIGN_STAGE_NAME/.test(body); })());
ok("sortOpportunity keeps an Assign in its own pipeline", /Assign keeps the case in its pipeline/.test(ghl));
const pt = read("../app/api/opportunities/[id]/route.ts");
ok("record save: owner rule gets the new owner; New lead can't be chosen", /canChangeOwner\(target, session, body\.assignedTo \|\| ""\)/.test(pt) && /New lead can't be chosen/.test(pt));
const vis = read("../lib/visibility.ts");
ok("owner rule: owned cases unchanged (owner or admin)", /if \(rec\.ownerId\) return rec\.ownerId === session\.userId;/.test(vis));
const tr = read("../app/api/opportunities/[id]/transfer/route.ts");
ok("transfer: both GET and POST use the new gate with the record", (tr.match(/await gate\(/g) || []).length === 2 && /canPeerTransfer\(rec, viewerFor\(s\)\)/.test(tr));
const acc = read("../app/api/admin/pipeline-access/route.ts");
ok("Access route reads and saves both switches", /staffing: stored\?\.staffing \?\? \{\}/.test(acc) && /\.\.\.\(staffingPatch \? \{ staffing: staffingPatch \} : \{\}\)/.test(acc) && /\.\.\.\(peerPatch \? \{ peerTransfer: peerPatch \} : \{\}\)/.test(acc));
const opp = read("../app/api/opportunities/route.ts");
ok("the payload carries staffing, the transfer tick and the tab names", /staffing: staffingLevel\(session\.userId, admin\)/.test(opp) && /canPeerTransfer: canUsePeerTransfer\(session\.userId, admin\)/.test(opp) && /\n    tabLabels,\n/.test(opp));

console.log("10 · The page is wired to the same rules");
const page = read("../app/page.tsx");
const tab = read("../components/SortingTab.tsx");
const dlg = read("../components/SortDialog.tsx");
const mvd = read("../components/MoveDialog.tsx");
ok("All clients is switched off, its code kept behind one line", /const SHOW_ALL_CLIENTS = false;/.test(page) && /\{SHOW_ALL_CLIENTS \? \(/.test(page));
ok("the two sorting tabs are the first Clients entries", /\["newleads", "newLeads", tabLabels\.newLeads/.test(page) && /\["staffing", "staffingTab", tabLabels\.staffingTab/.test(page));
ok("Staffing needed lead shows only for admins or a Staffing setting", /const showStaffingTab = isAdminViewer \|\| viewerStaffing === "any" \|\| viewerStaffing === "self";/.test(page) && /\.\.\.\(showStaffingTab/.test(page));
ok("pipeline tabs drop NEW LEAD from rows, totals, people, board columns and sidebar counts",
  (page.match(/!isNewLeadStage\(r\.stage\) &&/g) || []).length >= 3 && /!isReassignStage\(n\) && !isNewLeadStage\(n\)/.test(page) && /isReassignRec\(r\) \|\| isNewLeadStage\(r\.stage\)/.test(page));
ok("New Leads lists every NEW LEAD case; Staffing needed only unowned REASSIGN", /data\.filter\(\(r\) => isNewLeadStage\(r\.stage\)\)/.test(page) && /data\.filter\(\(r\) => isStaffingStage\(r\.stage\) && !r\.ownerId\)/.test(page));
ok("the Unassigned tile reuses the existing unassigned focus", /data-tile="unassigned"/.test(page) && /onClick=\{\(\) => setClientF\("rep", ""\)\}/.test(page));
ok("the panel stage dropdown offers no NEW LEAD / REASSIGN (current stage kept, disabled)", /isPickableStage\(s\.name\) \|\| s\.id === selected\.stageId/.test(page) && /disabled=\{!isPickableStage\(s\.name\)\}/.test(page));
ok("the Move dialog never offers NEW LEAD as a destination", /s2\.name\.trim\(\)\.toUpperCase\(\) !== "NEW LEAD"/.test(mvd));
ok("panel: Send to Staffing needed + Assign are gated by the shared rules", /canSendToStaffing\(selected, sortViewer\)\.ok/.test(page) && /canAssignStaffing\(selected, sortViewer, viewerId \|\| "x"\)\.ok/.test(page));
ok("panel: Transfer to the other company follows the tick rule; delete + GHL link stay admin-only", (page.match(/canPeerTransferRule\(selected, sortViewer\)\.ok/g) || []).length === 2);
ok("the dialog posts mode sort|assign, keeps an unchanged owner as undefined", /mode,\n          toPipelineId,/.test(dlg) && /\(ownerId \|\| ""\) === \(record\.ownerId \|\| ""\) \? undefined : ownerId/.test(dlg));
ok("the dialog: Cancel + primary on the right, the other-company link on the left", dlg.indexOf("sortlink") < dlg.indexOf("sortbtns") && /className="sortbtn primary"/.test(dlg));
ok("Take for myself locks the owner to Me", /const ownerLocked = mode === "assign" && staffing === "self";/.test(dlg));
ok("the tab: List and Board, Enroll · Transfer · Staffing, Assign on the queue", /view === "list"/.test(tab) && /"Enroll"/.test(tab) && /"Transfer"/.test(tab) && /"Staffing"/.test(tab) && /Assign/.test(tab));
ok("the tab: unopened first then newest; the queue oldest first", /Number\(!!b\.newLead\) - Number\(!!a\.newLead\)/.test(tab) && /ts\(a\.stageChangedAt \|\| a\.createdAt\) - ts\(b\.stageChangedAt/.test(tab));
// ROUND 198 — renaming moved to the Pipelines screen (round198-proof checks it there).
ok("rename: saved through the admin-only rename-tab action", /action: "rename-tab"/.test(read("../components/PipelineAdmin.tsx")));
ok("Master's column reads the Staffing needed label", /staffingLabel=\{tabLabels\.staffingStage\}/.test(page));
ok("the build is 197 or later", Number((/round: "(\d+)/.exec(read("../lib/build.ts")) || [])[1]) >= 197);

console.log(`\n${pass} passed · ${fail} failed`);
if (fail) process.exit(1);
