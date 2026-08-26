# v2 Build Report — Commit 3: Pipeline access + division scoping

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26
**Build:** `next build` compiles clean.

## Pre-flight confirmations you asked for

- **`shared` is a default, not computed in Task 2.** `normalizeOpportunity` sets `shared: false` (no viewer exists at fetch time). It is now **computed per-request** in `applyAccess` (this commit).
- **Pagination is bounded.** `searchAll` loops `page < 50` (≤5000 records/pipeline) and breaks when a batch is `< limit` or the cursor stops advancing. The true bound is total records, and it is capped.
- **Probe create-when-empty.** `rederive-ids-probe.mjs` now prints the `POST /associations` payload (and a folder-create note) when the caregiver_client association / media folder is missing — empty ≠ lookup failure.

## The rule implemented (with the asymmetry stated explicitly)
```
admin                                                -> all (shared=false)
home pipeline AND (owner OR follower OR unassigned)  -> theirs (shared=false)
ANY  pipeline AND (owner OR follower)                -> shared = true
otherwise                                            -> excluded
```
`unassigned` counts **only** in home pipelines — a non-home unassigned record never surfaces.

---

## chore: probe flags create-when-empty for the new-account IDs

```diff
diff --git a/scripts/rederive-ids-probe.mjs b/scripts/rederive-ids-probe.mjs
index fb186ae..2b683d2 100644
--- a/scripts/rederive-ids-probe.mjs
+++ b/scripts/rederive-ids-probe.mjs
@@ -35,11 +35,28 @@ async function main() {
   const assocs = (aj.associations || aj.data || []);
   for (const a of assocs)
     console.log(`  ${a.id ?? a._id}  key="${a.key ?? a.associationKey ?? ""}"  "${a.firstObjectLabel ?? ""} <-> ${a.secondObjectLabel ?? ""}"`);
-  if (!assocs.length) console.log("  (none returned — the endpoint shape may differ; paste the raw body)");
+
+  const hasCaregiver = assocs.some((a) =>
+    String(a.key ?? a.associationKey ?? "").toLowerCase().includes("caregiver"),
+  );
+  if (!assocs.length || !hasCaregiver) {
+    console.log("\n  ⚠️ No caregiver_client association found. On the OLD account it was");
+    console.log("     user-defined (6a6e26c9884def7a1438b965) — it likely needs CREATING here:");
+    console.log("     POST /associations");
+    console.log("     { locationId, key: \"caregiver_client\",");
+    console.log("       firstObjectLabel: \"Caregiver\", firstObjectKey: \"contact\",");
+    console.log("       secondObjectLabel: \"Client\",  secondObjectKey: \"contact\" }");
+    console.log("     Then use the returned association id as CAREGIVER_ASSOCIATION_ID.");
+  }
   if (typeof aj !== "object") console.log("raw:", String(aj).slice(0, 500));
 
+  if (!folders.length) {
+    console.log("\n  ⚠️ No media folders returned. RESOURCES_FOLDER_ID is a folder someone");
+    console.log("     creates in the GHL Media Library — make it, then read its id back here.");
+  }
+
   console.log("\n>> Set in the new account's env:");
-  console.log(">>   RESOURCES_FOLDER_ID    = the resources folder id above");
-  console.log(">>   CAREGIVER_ASSOCIATION_ID = the caregiver_client association id above");
+  console.log(">>   RESOURCES_FOLDER_ID      = the resources folder id above (create the folder if none)");
+  console.log(">>   CAREGIVER_ASSOCIATION_ID = the caregiver_client association id above (create it if none)");
 }
 main().catch((e) => { console.error(e); process.exit(1); });
```

---

## feat: pipeline access map and division scoping

```diff
diff --git a/.env.example b/.env.example
index c77781c..825b15c 100644
--- a/.env.example
+++ b/.env.example
@@ -31,6 +31,16 @@ RESOURCES_FOLDER_ID=6a75ea609994d35aa0c66e9a
 # (Replaces the retired OLTL_PIPELINE_ID + the /oltl/i name fallback.)
 PIPELINE_IDS=KGjdCMG4F8xILk0ineB9,74Pt3XX4hgBIqD10mW4G,a14NtTi18ACxs99bHPmL,PIs1iWVk0HqHZFNtmoTn,BJBWdRim6SOgjoMelVSZ
 
+# OPTIONAL — pipeline access map (division scoping). Maps a GHL user id to the
+# HOME pipeline(s) of their division. Format: "userId:pid|pid,userId:pid|pid".
+# A user not listed here is ungranted — they browse nothing, but still see any
+# record they own or follow (flagged "shared"). Admins see all. Fails closed.
+# Interim source; the durable answer is a custom field on the GHL user record —
+# getUserHomePipelines() is the single swap point. Roster (Dom = placeholder):
+#   Jackie On2hTvaKMQ1ktEYcNs32 Private Pay ; Bill tR8rV1dcVfs3Z0wH5Ogg ODP ;
+#   Lamarr 2635GTUGcn7XLPeSa3as OLTL ; Chris w90ItEk0IDeSeTL7hAYJ OLTL-CHC
+PIPELINE_ACCESS_MAP=On2hTvaKMQ1ktEYcNs32:BJBWdRim6SOgjoMelVSZ,tR8rV1dcVfs3Z0wH5Ogg:a14NtTi18ACxs99bHPmL|PIs1iWVk0HqHZFNtmoTn,2635GTUGcn7XLPeSa3as:KGjdCMG4F8xILk0ineB9|74Pt3XX4hgBIqD10mW4G,w90ItEk0IDeSeTL7hAYJ:KGjdCMG4F8xILk0ineB9|74Pt3XX4hgBIqD10mW4G
+
 # OPTIONAL — the caregiver↔client many-to-many association ID (Task 4).
 # Defaults to the known caregiver_client association for this tenant.
 CAREGIVER_ASSOCIATION_ID=6a6e26c9884def7a1438b965
diff --git a/app/api/opportunities/route.ts b/app/api/opportunities/route.ts
index aedcd95..4f7336d 100644
--- a/app/api/opportunities/route.ts
+++ b/app/api/opportunities/route.ts
@@ -2,31 +2,20 @@ import { NextResponse } from "next/server";
 import { getOltlOpportunities, GhlError } from "@/lib/ghl";
 import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
 import { isAdminSession } from "@/lib/visibility";
-import type {
-  OpportunitiesResponse,
-  ApiError,
-  OpportunityRecord,
-} from "@/lib/types";
+import { applyAccess } from "@/lib/pipelineAccess";
+import type { OpportunitiesResponse, ApiError } from "@/lib/types";
 
 // Always dynamic; the GHL token and SSO secret are only ever read server-side.
 export const dynamic = "force-dynamic";
 export const runtime = "nodejs";
 
-// PHASE 3 visibility rule — ASSIGNMENT ONLY.
-// A restricted (non-admin) user sees an opportunity if and only if they OWN it
-// (assignedTo === userId) OR they are a FOLLOWER (co-rep) of it. Followers MUST
-// be included — an owner-only filter would wrongly hide co-repped cases.
-// Office is NOT a permission gate; it is only a UI dimension.
-// Consequence (intended): an unassigned opportunity is visible to NO restricted
-// user — only admins see it. Do not "fix" this; it is the defined behavior.
-function visibleTo(
-  records: OpportunityRecord[],
-  userId: string,
-): OpportunityRecord[] {
-  return records.filter(
-    (o) => o.ownerId === userId || o.followerIds.includes(userId),
-  );
-}
+// v2 visibility — division scoping (see lib/pipelineAccess.applyAccess):
+//   admin                                          -> all
+//   home pipeline AND (owner OR follower OR unassigned) -> theirs (shared=false)
+//   ANY pipeline  AND (owner OR follower)               -> shared = true
+//   otherwise                                           -> excluded
+// The unassigned branch is HOME-ONLY on purpose — an unassigned record in
+// another division must never surface.
 
 async function buildResponse(blob: string | null): Promise<Response> {
   const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs } =
@@ -67,7 +56,8 @@ async function buildResponse(blob: string | null): Promise<Response> {
 
   const session = decryptSso(blob); // throws SsoError on bad secret/blob
   const admin = isAdminSession(session.role, session.type);
-  const visible = admin ? records : visibleTo(records, session.userId);
+  // Division scoping + per-viewer `shared` tagging.
+  const visible = applyAccess(records, { userId: session.userId, isAdmin: admin });
 
   const body: OpportunitiesResponse = {
     records: visible,
diff --git a/lib/pipelineAccess.ts b/lib/pipelineAccess.ts
new file mode 100644
index 0000000..f4ad065
--- /dev/null
+++ b/lib/pipelineAccess.ts
@@ -0,0 +1,83 @@
+import type { OpportunityRecord } from "./types";
+
+// Task 3 — pipeline access (division scoping).
+//
+// Two separate ways a user reaches a record:
+//   1. HOME pipelines — their division(s). They browse these, and may also see
+//      UNASSIGNED work there so it can be picked up.
+//   2. SHARED records — a record in ANY pipeline they own or follow. They get
+//      the RECORD (flagged shared), never the pipeline.
+//
+// Rule (per viewer, non-admin):
+//   home pipeline AND (owner OR follower OR unassigned)  -> visible, shared = false
+//   ANY  pipeline AND (owner OR follower)                -> visible, shared = true
+//   otherwise                                            -> excluded
+// Admin -> everything, shared = false. Fails closed: an ungranted user (no home
+// pipelines) browses nothing, but still sees what they own/follow (as shared).
+//
+// ⚠️ ASYMMETRY: `unassigned` counts ONLY in home pipelines. An unassigned record
+// in another division must never surface — otherwise every rep would see every
+// unowned lead account-wide, which defeats the scoping.
+//
+// The MAP SOURCE is deliberately behind getUserHomePipelines() so it can move
+// from the env var to a GHL user custom field later without touching callers.
+// Env now: PIPELINE_ACCESS_MAP = "userId:pid|pid,userId:pid|pid".
+
+type AccessMap = Map<string, Set<string>>;
+let _cache: AccessMap | null = null;
+
+function parseAccessMap(): AccessMap {
+  const map: AccessMap = new Map();
+  const raw = (process.env.PIPELINE_ACCESS_MAP || "").trim();
+  if (!raw) return map;
+  // Entries separated by comma / semicolon / newline; within an entry:
+  //   userId : pipelineId | pipelineId | ...
+  for (const entry of raw.split(/[,;\n]+/)) {
+    const e = entry.trim();
+    if (!e) continue;
+    const idx = e.indexOf(":");
+    if (idx < 0) continue;
+    const userId = e.slice(0, idx).trim();
+    const pids = e
+      .slice(idx + 1)
+      .split(/[|\s]+/)
+      .map((s) => s.trim())
+      .filter(Boolean);
+    if (!userId || !pids.length) continue;
+    const set = map.get(userId) || new Set<string>();
+    for (const p of pids) set.add(p);
+    map.set(userId, set);
+  }
+  return map;
+}
+
+// The user's HOME pipelines. Empty set = ungranted (sees only owned/followed).
+// Swap the body for a GHL user-field read later; the signature stays the same.
+export function getUserHomePipelines(userId: string): Set<string> {
+  if (!_cache) _cache = parseAccessMap();
+  return _cache.get(userId) || new Set<string>();
+}
+
+// Filter + tag records for one viewer. Returns a NEW array; each surviving
+// record gets its `shared` flag set correctly for this viewer.
+export function applyAccess(
+  records: OpportunityRecord[],
+  viewer: { userId: string; isAdmin: boolean },
+): OpportunityRecord[] {
+  if (viewer.isAdmin) return records.map((r) => ({ ...r, shared: false }));
+  const home = getUserHomePipelines(viewer.userId);
+  const out: OpportunityRecord[] = [];
+  for (const r of records) {
+    const owned =
+      r.ownerId === viewer.userId || r.followerIds.includes(viewer.userId);
+    const isHome = home.has(r.pipelineId);
+    const unassigned = !r.ownerId;
+    if (isHome && (owned || unassigned)) {
+      out.push({ ...r, shared: false });
+    } else if (owned) {
+      out.push({ ...r, shared: true });
+    }
+    // else: excluded (includes the asymmetry — non-home unassigned never shows)
+  }
+  return out;
+}
diff --git a/lib/visibility.ts b/lib/visibility.ts
index 5034b6f..b29aa10 100644
--- a/lib/visibility.ts
+++ b/lib/visibility.ts
@@ -1,5 +1,6 @@
 import type { OpportunityRecord } from "./types";
 import type { GhlSession } from "./sso";
+import { getUserHomePipelines } from "./pipelineAccess";
 
 // Phase 3 permission model — ASSIGNMENT ONLY (shared by the list + save routes).
 // Admins see & edit all; everyone else is limited to records they own or follow.
@@ -16,13 +17,27 @@ export function isAdminSession(role?: string, type?: string): boolean {
   return role === "admin";
 }
 
-/** Can this user SEE this record? (owner OR follower, or admin) */
+/**
+ * Can this user SEE/EDIT this record?
+ *   admin                              -> true
+ *   owner OR follower (any pipeline)   -> true  (the shared path)
+ *   home pipeline AND unassigned       -> true  (rep can claim it)
+ *   otherwise                          -> false
+ * Matches the list-scoping rule in pipelineAccess.applyAccess, minus the
+ * `shared` tagging (which only the list needs). The home+unassigned branch is
+ * why a rep can open and claim an unowned lead in their own division.
+ */
 export function canSeeRecord(
-  rec: Pick<OpportunityRecord, "ownerId" | "followerIds">,
+  rec: Pick<OpportunityRecord, "ownerId" | "followerIds" | "pipelineId">,
   session: Pick<GhlSession, "userId" | "role" | "type">,
 ): boolean {
   if (isAdminSession(session.role, session.type)) return true;
-  return rec.ownerId === session.userId || rec.followerIds.includes(session.userId);
+  if (rec.ownerId === session.userId || rec.followerIds.includes(session.userId))
+    return true;
+  // Division predicate: an unassigned record in a HOME pipeline is claimable.
+  const home = getUserHomePipelines(session.userId);
+  const unassigned = !rec.ownerId;
+  return unassigned && home.has(rec.pipelineId);
 }
 
 // Edit permission == visibility (same rule). Kept as a named alias so intent is
```

---

## Known gaps (logged, not yet built)

### G1 — Followers survive a transfer; nothing clears them
`applyAccess`'s shared branch tests `owner OR follower` against **any** pipeline.
The PATCH route (`app/api/opportunities/[id]/route.ts`) writes `assignedTo`
only — `followers` is *read* in `normalizeOpportunity` but **never written**.
So reassigning a lead removes the old rep's **owner** path but not their
**follower** path: if they were a follower they keep the record as `shared`
permanently, which violates the requirement that a transferred lead leaves the
old rep's view entirely.

**Recommendation — this belongs in Task 6 (the Move action), using the mechanism
from Task 5, not its own task and not Task 4.**
- Task 5 builds the dedicated follower add/remove endpoints — that's the *write*
  mechanism (`followers` is not writable today).
- Task 6's owner-changed (transfer) path is the only place the requirement
  "old owner loses access" is defined and client-confirmed (Option B). The clean
  fix is: on the transfer path, after setting the new owner, **remove the prior
  owner (and any transferring-division followers) from `followers`** via the
  Task 5 endpoint.
- Putting it in Task 4 (field sets) would be unrelated; a standalone task would
  duplicate Task 6's transfer logic.

Not built pending your confirmation of that placement.

### G2 — Account-specific IDs / access-map user IDs are from the old account
`PIPELINE_ACCESS_MAP`, `RESOURCES_FOLDER_ID`, `CAREGIVER_ASSOCIATION_ID`, and the
frontend deep-link location were all still on the old account. Addressed this
round: `GHL_LOCATION_ID` → `anzcWt3S0tzpu2fEaS8X`, frontend location is now
`NEXT_PUBLIC_GHL_LOCATION_ID` (defaulting to the v2 account), the two IDs are
flagged RE-DERIVE in `.env.example`, and `rederive-ids-probe.mjs` now lists this
account's users and warns on any `PIPELINE_ACCESS_MAP` id not present. The map
values themselves still need rebuilding from the probe output (their action).
