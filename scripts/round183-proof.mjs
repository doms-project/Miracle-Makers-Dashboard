// ---------------------------------------------------------------------------
// ROUND 183 PROOF — the card badge follows a link change without a reload.
//
// Two halves:
//   A. lib/linkCounts.ts, the pure logic page.tsx now calls when the panel
//      links, unlinks or opens.
//   B. The panel's count and the badge route's count agree. The panel counts
//      the list `listCaregiverRelations` returns; the badge route uses
//      `countCaregiverRelations`. Both run here against one fake GoHighLevel,
//      in BOTH slot orders, so the card cannot jump from one number to another
//      the next time it is recounted.
//
// Run: npx tsx scripts/round183-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Part B runs once per slot order in a CHILD process. The slot direction is
// cached for the life of the module (as on a warm server), and tsx ignores a
// query string on import, so one process cannot test both orders honestly.
const CHILD = process.env.ROUND183_ORDER; // "caregiver-first" | "client-first"

let pass = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const L = await import("../lib/linkCounts.ts");

if (!CHILD) {
console.log("A. lib/linkCounts.ts");
{
  const cg = (id) => ({ relationId: "r" + id, contactId: id, name: id, role: "caregiver" });
  const cl = (id) => ({ relationId: "r" + id, contactId: id, name: id, role: "client" });

  // 1. A caregiver is linked from a client's panel.
  const before = { CLIENT: { caregivers: 0, clients: 0 }, CG: { caregivers: 0, clients: 0 }, OTHER: { caregivers: 2, clients: 0 } };
  const after = L.applyLinkChangeToCounts(before, "CLIENT", [cg("CG")], "CG");
  ok("1 · linking from a client's panel sets that card to 1 caregiver", eq(after.CLIENT, { caregivers: 1, clients: 0 }), JSON.stringify(after.CLIENT));
  ok("1 · the caregiver's own count is cleared so it is re-asked", !("CG" in after));
  ok("1 · nobody else's count is touched", eq(after.OTHER, before.OTHER));
  ok("1 · the previous state is not mutated", eq(before.CG, { caregivers: 0, clients: 0 }));

  // 2. A caregiver's panel lists clients.
  const c2 = L.applyLinkChangeToCounts({}, "CG", [cl("A"), cl("B")], "B");
  ok("2 · a caregiver with two clients reads 2 clients, not caregivers", eq(c2.CG, { caregivers: 0, clients: 2 }), JSON.stringify(c2.CG));

  // 3. Unlinking.
  const c3 = L.applyLinkChangeToCounts({ CLIENT: { caregivers: 1, clients: 0 }, CG: { caregivers: 0, clients: 1 } }, "CLIENT", [], "CG");
  ok("3 · unlinking the only caregiver clears the badge to zero", eq(c3.CLIENT, { caregivers: 0, clients: 0 }));
  ok("3 · and the unlinked caregiver is re-asked", !("CG" in c3));

  // 4. Opening a panel whose count is already right changes nothing.
  const same = { CLIENT: { caregivers: 1, clients: 0 } };
  ok("4 · an unchanged count returns the same object (no re-render, no refetch)", L.applyLinkChangeToCounts(same, "CLIENT", [cg("CG")]) === same);

  // 5. Opening a panel whose count went stale elsewhere corrects it.
  const c5 = L.applyLinkChangeToCounts({ CLIENT: { caregivers: 0, clients: 0 } }, "CLIENT", [cg("X"), cg("Y")]);
  ok("5 · opening the panel corrects a stale badge", eq(c5.CLIENT, { caregivers: 2, clients: 0 }));

  // 6. "links unknown" is replaced by a real count.
  const c6 = L.applyLinkChangeToCounts({ CLIENT: { unknown: true } }, "CLIENT", []);
  ok("6 · a 'links unknown' badge is replaced by the real count", eq(c6.CLIENT, { caregivers: 0, clients: 0 }));

  // 7. Defensive edges.
  const keep = { CLIENT: { caregivers: 1, clients: 0 } };
  ok("7 · other === self is not deleted", eq(L.applyLinkChangeToCounts(keep, "CLIENT", [cg("Z")], "CLIENT").CLIENT, { caregivers: 1, clients: 0 }));
  ok("7 · no contact id changes nothing", L.applyLinkChangeToCounts(keep, "", [cg("Z")], "CG") === keep);
  ok("7 · a link with no role counts as a caregiver, as the server does", eq(L.countFromLinks([{ relationId: "r", contactId: "q", name: "q" }]), { caregivers: 1, clients: 0 }));
}

}

if (CHILD) {
  const LOC = "LOC183", ASSOC = "ASSOC183";
  let firstLabel = "Caregiver", secondLabel = "Client";
  // CLIENT has two caregivers (CG1, CG2), one family link in ANOTHER
  // association that must be ignored, and CG1 also has a second client.
  const rel = (id, a, b, assoc = ASSOC) => ({ id, associationId: assoc, firstRecordId: a, secondRecordId: b });
  let relations = [];
  const setOrder = (caregiverFirst) => {
    firstLabel = caregiverFirst ? "Caregiver" : "Client";
    secondLabel = caregiverFirst ? "Client" : "Caregiver";
    const pair = (cgId, clId, id) => (caregiverFirst ? rel(id, cgId, clId) : rel(id, clId, cgId));
    relations = [pair("CG1", "CLIENT", "r1"), pair("CG2", "CLIENT", "r2"), pair("CG1", "CLIENT2", "r3"), rel("rf", "FAMILY", "CLIENT", "FAMILY_ASSOC")];
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (p === `/associations/${ASSOC}`) return send({ association: { firstObjectLabel: firstLabel, secondObjectLabel: secondLabel } });
    const m = p.match(/^\/associations\/relations\/([^/]+)$/);
    if (m) return send({ relations: relations.filter((r) => r.firstRecordId === m[1] || r.secondRecordId === m[1]) });
    const c = p.match(/^\/contacts\/([^/]+)$/);
    if (c) return send({ contact: { id: c[1], firstName: c[1], lastName: "" } });
    return send({});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    GHL_API_BASE: `http://127.0.0.1:${server.address().port}`, GHL_PIT: "pit_test",
    GHL_LOCATION_ID: LOC, CAREGIVER_ASSOCIATION_ID: ASSOC,
  });

  {
    const caregiverFirst = CHILD === "caregiver-first";
    setOrder(caregiverFirst);
    const G = await import("../lib/ghl.ts");
    const tag = caregiverFirst ? "Caregiver-first labels" : "Client-first labels";
    for (const id of ["CLIENT", "CG1", "CLIENT2"]) {
      const links = await G.listCaregiverRelations(id);
      const panel = L.countFromLinks(links);
      const route = await G.countCaregiverRelations(id);
      ok(`${tag} · ${id}: panel ${panel.caregivers}cg/${panel.clients}cl == route ${route.caregivers}cg/${route.clients}cl`, eq(panel, route));
    }
    const client = L.countFromLinks(await G.listCaregiverRelations("CLIENT"));
    ok(`${tag} · CLIENT reads 2 caregivers (the family link is ignored)`, eq(client, { caregivers: 2, clients: 0 }), JSON.stringify(client));
    const cg1 = L.countFromLinks(await G.listCaregiverRelations("CG1"));
    ok(`${tag} · CG1 reads 2 clients`, eq(cg1, { caregivers: 0, clients: 2 }), JSON.stringify(cg1));
  }
  server.close();
  // Hand the tally back to the parent on the last line.
  console.log(`@@${pass}:${failed}`);
  process.exit(0);
}

console.log("B. panel count == badge-route count, both slot orders");
for (const order of ["caregiver-first", "client-first"]) {
  const r = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url)], {
    env: { ...process.env, ROUND183_ORDER: order },
    encoding: "utf8",
  });
  const out = (r.stdout || "").trimEnd().split("\n");
  const tally = out.pop() || "";
  const m = tally.match(/^@@(\d+):(\d+)$/);
  for (const line of out) console.log(line);
  if (!m) { failed++; console.log(`  ✗ ${order} child did not finish — ${(r.stderr || tally).slice(0, 300)}`); continue; }
  pass += Number(m[1]); failed += Number(m[2]);
}

console.log(`\n${pass} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
