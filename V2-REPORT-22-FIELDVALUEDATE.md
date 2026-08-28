# V2 REPORT 22 — fieldValueDate, and what the users 401 was really doing

**Commit:** `fix: read DATE under fieldValueDate; stop a users 401 wiping the access map`
**Branch:** `v2-multi-pipeline` · nothing pushed, nothing merged.
**Build:** `next build` ✓ (TypeScript ✓)

---

## 1 · `fieldValueDate` — added, and a correction to my last report

Added to `KNOWN_CF_KEYS`, placed **ahead of** `fieldValueString` / `fieldValue` / `value`
so an empty-but-present generic key can never shadow it. The `fieldValue*` fallback
stays — it is what caught this, and it will catch `fieldValueNumber` or whatever comes
next instead of silently blanking it.

**A correction I owe you.** Last report I wrote that the missing `DATE` branch in
`formatValue()` meant *"all ten milestone dates are unsettable."* That was wrong, and in
the direction that matters: they were **settable the whole time**. They stored fine and
read back blank. Nothing was lost — the dates you set through the panel are in
GoHighLevel now and will appear on the next deploy.

The `DATE` → full-ISO normalization I added stays in (Move, panel and importer send one
proven-good shape, and it fixes real spreadsheet-import cases like `8/28/2026`), but it
was **not** the cause and I should not have called it a confirmed defect. The one real
defect was the blind read.

Worth noting where that leaves the instrumentation: the read-back verifier in
`putOpportunityVerified()` compares the response through the same `cfRaw()`. Before this
change it would have reported **Transferred Date as a silent drop on every transfer** —
a false positive, confidently logged. It now reads the key correctly and stays quiet.

## 2 · The users 401 — you're right, and it is bigger than the stamp

Your inference is correct, and here is the mechanism, because it is worse than a missing
name. `getLocationUserIds()` is `new Set((await getUserMap()).keys())`, and `getUserMap()`
**swallows** a failure and returns an **empty map** — deliberately, so a users outage
can't take down the read path. So in `withGrants`:

```ts
userIds = await getLocationUserIds();   // 401 -> resolves to an EMPTY Set, does NOT throw
...
const grants = buildGrants(stored, userIds, pipelineIds);
```

The `catch` never fires. Validation runs against an empty user set, and **every stored
grant is discarded as stale**. A missing `users.readonly` scope doesn't just blank names —
it **silently wipes the entire pipeline access map**:

- every non-admin browses **nothing** (not an empty division — nothing)
- Move notes get no `[DIVISION]` prefix ← the symptom you found
- and my new `[grants] N stored -> 0 effective` line would have blamed *stale ids*

An empty list means **unavailable**, not *nothing exists*. It is now treated exactly like
the throw: skip validation, keep the grants. Which is what the code already claimed to do
— *"failing open on VALIDATION, never on access"* — it just had no way to reach that path.

## 3 · The same trap was blocking every transfer

`moveOpportunity`'s preflight did `validUsers.has(args.newOwnerId)` against that same
empty set, so with the scope missing **every transfer fails** — with
`"New owner is not a user of this location."` Flatly untrue, and it points you at the
owner instead of at the token. An empty list now means *cannot verify*: it proceeds with a
warning and lets GoHighLevel reject the id on the write if it really is bad.

I would not have found this from the symptom you reported. It came out of your 401.

---

## AFTER THE SCOPE IS GRANTED

The stamp should resolve on its own — no further change needed. To confirm in one Move,
the response now echoes it directly:

```jsonc
{ "ok": true, "transferred": true, "actorDivision": "ODP", ... }   // "" = still empty
```

and the logs should fall silent — no `[users] lookup FAILED`, no `[grants] … SKIPPING`,
no `[move:division]`. If `actorDivision` is still `""` with the scope in place, cause
**b** from the last report is the live one: admins bypass the access map entirely, so an
admin performing the Move legitimately has no single division. Tell me and we'll decide
what an admin's note should say — right now it correctly says nothing.

**Unchanged from the last report:** items 3 and 4 (panel close / duplicate pre-check) are
built and untouched here.

---

## FULL DIFF — every line

```diff
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 64426ef..b11a918 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -521,17 +521,32 @@ interface RawOpportunity {
 
 // Raw custom-field value, arrays preserved (for MULTIPLE_OPTIONS / CHECKBOX).
 //
-// ITEM 1 (read side). This used to read exactly four fixed keys. GHL returns a
-// custom field's value under a key that varies by dataType and API surface
-// (fieldValueString / fieldValueArray / fieldValue / value — and typed variants
-// such as fieldValueDate / fieldValueNumber appear on some responses). Any key
-// outside that fixed list read back as "" — which is INDISTINGUISHABLE from
-// "never written". A stamp could land in GHL and still show blank here.
+// ITEM 1 (read side) — SETTLED, live.
 //
-// So: try the known keys first (order matters — array before string), then fall
-// back to ANY `fieldValue*` property that holds a value. The unknown key is
-// logged once so we learn the real shape instead of guessing at it.
-const KNOWN_CF_KEYS = ["fieldValueArray", "fieldValueString", "fieldValue", "value"];
+// This used to read exactly four fixed keys. GHL returns a custom field's value
+// under a key that varies by dataType, and DATE fields come back under
+// **fieldValueDate** — which was not in the list, so every DATE read back as ""
+// and was INDISTINGUISHABLE from "never written".
+//
+// That was the whole of the Transferred Date bug. The write was correct all
+// along; the READ was blind. Confirmed by the fallback below firing in
+// production:
+//   [ghl] custom-field value found under the unhandled key "fieldValueDate"
+//         (field XheOieRRGOFtSZc4TBWi)
+// The same applied to all ten Milestone dates — they were storing fine and
+// showing empty.
+//
+// fieldValueDate is now a KNOWN key, placed ahead of the generic ones so an
+// empty-but-present fieldValueString/fieldValue can never shadow it. The
+// `fieldValue*` fallback stays: it is what caught this, and it will catch the
+// next typed variant (fieldValueNumber, …) instead of silently blanking it.
+const KNOWN_CF_KEYS = [
+  "fieldValueArray",
+  "fieldValueDate",
+  "fieldValueString",
+  "fieldValue",
+  "value",
+];
 const _loggedCfKeys = new Set<string>();
 
 function cfRaw(cf: RawCustomField): unknown {
@@ -1613,13 +1628,27 @@ export async function moveOpportunity(args: {
         "Add a TRANSFERRED IN stage to that pipeline before transferring into it.",
       );
     destStageId = ti.id;
+    if (!args.newOwnerId)
+      throw new GhlError("New owner is not a user of this location.", 400, "");
     const validUsers = await getLocationUserIds();
-    if (!args.newOwnerId || !validUsers.has(args.newOwnerId))
+    // Same trap as withGrants: getUserMap() swallows a failure and returns an
+    // EMPTY map, so a PIT missing `users.readonly` would make this reject EVERY
+    // transfer with a flatly untrue message ("not a user of this location") that
+    // sends you looking at the wrong thing entirely. An empty list means we
+    // cannot verify, not that the user is invalid — let GoHighLevel be the
+    // authority and reject it on the write if it really is bad.
+    if (!validUsers.size) {
+      // eslint-disable-next-line no-console
+      console.warn(
+        `[move] cannot verify that "${args.newOwnerId}" is a location user — the users lookup is empty (check the PIT's users.readonly scope). Proceeding; GoHighLevel will reject the owner change if the id is invalid.`,
+      );
+    } else if (!validUsers.has(args.newOwnerId)) {
       throw new GhlError(
         "New owner is not a user of this location.",
         400,
-        String(args.newOwnerId ?? ""),
+        String(args.newOwnerId),
       );
+    }
   } else {
     if (!destStageId) {
       const first = (dest.stages || [])[0];
diff --git a/lib/withGrants.ts b/lib/withGrants.ts
index 0384a79..525e220 100644
--- a/lib/withGrants.ts
+++ b/lib/withGrants.ts
@@ -41,6 +41,30 @@ export async function withGrants<T>(fn: () => Promise<T>): Promise<T> {
   try {
     userIds = await getLocationUserIds();
     pipelineIds = new Set((await listPipelines()).map((p) => p.id));
+    // getLocationUserIds() is built on getUserMap(), which SWALLOWS a failure and
+    // returns an EMPTY map (deliberately — it must not take down the read path).
+    // So a PIT missing `users.readonly` does not throw here; it succeeds with
+    // zero users, and buildGrants then validates every stored grant against an
+    // empty set and discards ALL of them as stale. That is how a users-scope 401
+    // silently wipes the entire pipeline access map: no division on Move notes,
+    // and every non-admin browsing nothing.
+    //
+    // An EMPTY list is "unavailable", not "nothing exists". Treat it exactly like
+    // the throw below — skip validation, keep the grants.
+    if (!userIds.size) {
+      // eslint-disable-next-line no-console
+      console.warn(
+        "[grants] the users lookup returned ZERO users (usually a PIT missing the users.readonly scope) — SKIPPING grant validation so the access map is not wiped. Grant that scope: owner/follower names, the pickers and transfer owner-validation all depend on it.",
+      );
+      userIds = undefined;
+    }
+    if (!pipelineIds.size) {
+      // eslint-disable-next-line no-console
+      console.warn(
+        "[grants] the pipeline list came back EMPTY — SKIPPING grant validation rather than discarding every grant.",
+      );
+      pipelineIds = undefined;
+    }
   } catch (e) {
     // eslint-disable-next-line no-console
     console.warn(
diff --git a/scripts/date-write-probe.mjs b/scripts/date-write-probe.mjs
index 69bfc91..bf26594 100644
--- a/scripts/date-write-probe.mjs
+++ b/scripts/date-write-probe.mjs
@@ -35,7 +35,8 @@ const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
 
 // Read a custom field's stored value under ANY key GHL might use for it.
 const cfRaw = (cf) => {
-  for (const k of ["fieldValueArray", "fieldValueString", "fieldValue", "value"])
+  // fieldValueDate confirmed live as the key DATE fields come back under.
+  for (const k of ["fieldValueArray", "fieldValueDate", "fieldValueString", "fieldValue", "value"])
     if (cf?.[k] !== undefined && cf?.[k] !== null) return cf[k];
   for (const [k, v] of Object.entries(cf || {}))
     if (k.startsWith("fieldValue") && v !== undefined && v !== null && v !== "")

```
