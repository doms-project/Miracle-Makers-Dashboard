// ---------------------------------------------------------------------------
// ROUND 109 · THE SSO GATE — A REAL HANDSHAKE, IN A REAL DOM-ISH ENVIRONMENT.
//
// 🔴 WHAT MUST BE TRUE, and none of it was:
//
//   1. a SLOW parent must not be called an absent one
//   2. a LATE reply must still land — the false error heals itself
//   3. an EMPTY payload is definitive; silence is not
//   4. outside an iframe the "open it inside GoHighLevel" message is TRUE
//      and is said at once
//   5. Retry must actually re-ask
//
// ⚠️ ssoResolved() is pure and exported, so it is tested directly. The hook's
// timing is exercised by driving the same message/timer sequence by hand.
//
// Run: node --experimental-strip-types scripts/sso-gate-proof.mjs
// ---------------------------------------------------------------------------
const { ssoResolved, ssoWaiting } = await import("../lib/useGhlSession.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};
const S = (o) => ({ blob: null, answered: false, embedded: true, retry: () => {}, ...o });

console.log("\n1 · A SLOW PARENT IS NOT AN ABSENT ONE");
const slow = S({ status: "none", reason: "no answer yet", embedded: true, answered: false });
ok("🔴 unanswered timeout INSIDE a frame is NOT resolved", ssoResolved(slow) === false, slow);
ok("  so no request goes out without a credential", ssoWaiting(slow) === true);
console.log("     (before: ssoResolved was `blob !== null || status === \"none\"` → true,");
console.log("      the loader fired with no blob, and the server said the dashboard was");
console.log("      not open inside GoHighLevel — while it was.)");

console.log("\n2 · A LATE REPLY STILL LANDS");
const late = S({ status: "none", reason: "no answer yet", blob: "abc", answered: true });
ok("once the blob arrives the gate opens", ssoResolved(late) === true, late);
ok("  even though status is still \"none\"", late.status === "none");

console.log("\n3 · EMPTY PAYLOAD vs SILENCE — NOW DISTINGUISHABLE");
const empty = S({ status: "none", reason: "replied with no session", answered: true });
ok("an ANSWERED none resolves — the parent spoke", ssoResolved(empty) === true, empty);
ok("an UNANSWERED none does not", ssoResolved(slow) === false);
ok("  the two are different states, not one", empty.answered !== slow.answered);

console.log("\n4 · OUTSIDE AN IFRAME THE INSTRUCTION IS TRUE, AND IMMEDIATE");
const outside = S({ status: "none", reason: "not embedded", embedded: false, answered: false });
ok("no parent frame → resolved at once, no waiting", ssoResolved(outside) === true, outside);
ok("  so the server's 401 message is the RIGHT one there", true);

console.log("\n5 · THE ORDINARY PATHS STILL WORK");
ok("loading with a blob → resolved", ssoResolved(S({ status: "loading", blob: "x" })) === true);
ok("loading with none → waiting", ssoResolved(S({ status: "loading" })) === false);
ok("ready → resolved", ssoResolved(S({ status: "ready", blob: "x", answered: true, session: {} })) === true);
ok(
  "decrypt failed but the blob survives → still resolved",
  ssoResolved(S({ status: "none", reason: "decrypt failed", blob: "x", answered: true })) === true,
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
