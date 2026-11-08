// ---------------------------------------------------------------------------
// ROUND 193 PROOF — find a lead by owner reliably, and search shortcuts.
//
//   1. lib/owners.ts — matched by owner ID; options counted, "Me" first, the
//      selected owner never dropped from the list.
//   2. app/page.tsx — an Owner filter on Clients and Master (shared), a
//      Recruiter filter on Recruiting, each named wherever filters are named,
//      and never able to disagree with an owner tile.
//   3. app/page.tsx — "/" jumps to the search box, Esc clears it, × clears it.
//
// Run: npx tsx scripts/round193-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const O = await import("../lib/owners.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1 · The owner filter (lib/owners.ts)");
{
  // Two different people both called "Chris" — the reason it goes by id.
  const rows = [
    { id: "1", ownerId: "U_CHRIS_A", rep: "Chris" },
    { id: "2", ownerId: "U_CHRIS_B", rep: "Chris" },
    { id: "3", ownerId: "U_DANA", rep: "Dana" },
    { id: "4", ownerId: "U_DANA", rep: "Dana" },
    { id: "5", ownerId: "", rep: "—" },
    { id: "6", ownerId: "U_GONE", rep: "—" },
  ];
  const pick = (f) => rows.filter((r) => O.matchesOwner(r, f)).map((r) => r.id);
  ok("by id: one Chris is not the other Chris", eq(pick("U_CHRIS_A"), ["1"]), pick("U_CHRIS_A"));
  ok("Everyone keeps every record", pick(O.EVERYONE).length === 6);
  ok("Unassigned is exactly the records with no owner", eq(pick(O.UNASSIGNED), ["5"]), pick(O.UNASSIGNED));

  const opts = O.ownerOptions(rows, { viewerId: "U_DANA" });
  ok("each owner is counted", eq(opts.owners.map((o) => [o.id, o.n]), [["U_DANA", 2], ["U_CHRIS_A", 1], ["U_CHRIS_B", 1], ["U_GONE", 1]]), opts.owners);
  ok('the viewer is listed first, as "Me"', opts.owners[0].id === "U_DANA" && opts.owners[0].me === true);
  ok("unassigned is counted separately", opts.unassigned === 1);
  ok('an owner with no name reads "Former user", not "—"', opts.owners.find((o) => o.id === "U_GONE").name === "Former user");

  const names = O.ownerNames(rows, [{ ownerId: "U_EVE", rep: "Eve" }]);
  const kept = O.ownerOptions(rows, { selected: "U_EVE", names });
  ok("🔴 the selected owner stays listed (with 0) when nothing of theirs is in view", kept.owners.some((o) => o.id === "U_EVE" && o.n === 0 && o.name === "Eve"), kept.owners);
  ok("names come from either board", names.get("U_EVE") === "Eve" && names.get("U_DANA") === "Dana");
  ok("described for 'filtered by …' lines", O.describeOwner("U_DANA", names) === "owner Dana" && O.describeOwner(O.UNASSIGNED, names) === "unassigned" && O.describeOwner(O.EVERYONE, names) === "" && O.describeOwner("U_DANA", names, "recruiter") === "recruiter Dana");
}

const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const at = (start, len) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + len); };

console.log("2 · Wired into the three boards (round 195: the person is picked in the search box, not a dropdown)");
{
  ok("Clients filters by owner, after every other filter but before the date", /clientPreOwner\.filter\(\(r\) => matchesOwner\(r, ownerF\)/.test(src));
  ok("Clients' owner counts use every other filter, the date included", /inCreatedWindow\(r\.createdAt, clientWin\)/.test(at("const clientPeopleBase = useMemo", 700)) && /ownerOptions\(clientPeopleBase/.test(src));
  ok("the Clients search box carries the sales-rep tag", /which="clients"[\s\S]{0,250}chips=\{peopleChips\}/.test(src) && /Sales rep: \$\{ownerNameMap\.get\(ownerF\)/.test(src));
  ok("Clients' 'Nothing matches' names the owner", /describeOwner\(ownerF, ownerNameMap, "sales rep"\)/.test(at("Nothing matches the filters in use.", 1200)));

  ok("Master's columns filter by the same owner", /matchesOwner\(r, ownerF\)/.test(at("const match = (r: OpportunityRecord) =>", 300)));
  ok("Master's no-date count does too", /matchesOwner\(r, ownerF\)/.test(at("const masterUndated = useMemo", 500)));
  ok("the Master search box carries the same tag, on the shared state", /which="master"[\s\S]{0,250}chips=\{peopleChips\}/.test(src));
  const mbar = at('placeholder="Search by client name…"', 7000);
  ok("Master's 'filtered by' line names the owner", /describeOwner\(ownerF, ownerNameMap, "sales rep"\)/.test(mbar));
  ok("Master's Clear filters clears the owner", /setMasterFocus\(null\);\s*setOwnerF\(EVERYONE\);/.test(mbar));

  ok("Recruiting filters by its own recruiter", /cgPreOwner\.filter\(\(r\) => matchesOwner\(r, cgOwnerF\)\)/.test(src));
  ok("the Recruiting search box carries the recruiter tag", /which="recruiting"[\s\S]{0,250}chips=\{cgChips\}/.test(src) && /Recruiter: \$\{ownerNameMap\.get\(cgOwnerF\)/.test(src));
  ok("Recruiting's count line names the recruiter, with a way back", /\{cgOwnerLabel \? \(/.test(src) && /Show everyone/.test(at("{cgOwnerLabel ? (", 400)));
  ok("Recruiting's empty list names it", /if \(cgOwnerLabel\) on\.push\(cgOwnerLabel\)/.test(src));

  ok("🔴 picking an owner clears an owner tile on Clients and Master", /setClientFocus\(\(f\) => \(f && f\.kind === "rep" \? null : f\)\)/.test(at("const pickOwner = ", 300)) && /setMasterFocus\(\(f\) => \(f && f\.kind === "owner" \? null : f\)\)/.test(at("const pickOwner = ", 300)));
  ok("🔴 and picking Master's owner tile clears the dropdown", /if \(kind === "owner"\) setOwnerF\(EVERYONE\)/.test(at("const setMFocus = ", 400)));
  ok("picking a recruiter clears a recruiter tile", /setCgFocus\(\(f\) => \(f && f\.kind === "recruiter" \? null : f\)\)/.test(at("const pickCgOwner = ", 200)));
}

console.log("3 · Search shortcuts");
{
  ok("all three toolbars use the one search box", /<SearchBox\s+which="clients"/.test(src) && /<SearchBox\s+which="master"/.test(src) && /<SearchBox\s+which="recruiting"/.test(src));
  ok("the placeholders the live tour types into are unchanged", src.includes('placeholder="Search by client, office, stage, caregiver, case manager…"') && src.includes('placeholder="Search by client name…"'));
  const fn = at("function SearchBox(", 6000); // round 195: a longer component
  ok("Esc with text clears the search and stops there (the open record stays open)", /e\.key === "Escape" && value[\s\S]{0,40}e\.stopPropagation\(\);[\s\S]{0,20}onChange\(""\)/.test(fn));
  ok("an × clears it and puts the cursor back", /aria-label="Clear search"/.test(fn) && /ref\.current\?\.focus\(\)/.test(fn));
  const slash = at('e.key !== "/"', 700);
  ok('"/" jumps to the visible search box', /input\[data-search\]/.test(slash) && /offsetParent !== null/.test(slash) && /box\.focus\(\)/.test(slash));
  ok('"/" is ignored while typing, with a modifier, or under a dialog', /INPUT\|TEXTAREA\|SELECT/.test(slash) && /isContentEditable/.test(slash) && /e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey/.test(slash) && /aria-modal/.test(slash));
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
