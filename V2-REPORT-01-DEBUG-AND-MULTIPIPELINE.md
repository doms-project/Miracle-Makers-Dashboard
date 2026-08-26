# v2 Build Report — Commits 1–2 (+ re-derive probe)

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26
**Build:** `next build` compiles clean after each commit.

Commits in this batch:
- d9201ad chore: add re-derive-IDs probe for the new account
- 7a6249d feat: multi-pipeline fetch with per-pipeline stage map
- 093bdde chore: remove debug instrumentation and session logging

This report includes the **complete unified diff for every changed line** (including punctuation).

---

## Task 1 — chore: remove debug instrumentation and session logging

**Why:** `decrypt-sso` was writing a *decrypted* session to Vercel logs; the opportunities route carried temporary `[visibility]` console logs and `debug{}` response blocks + `rawSample` plumbing.

```diff
diff --git a/app/api/decrypt-sso/route.ts b/app/api/decrypt-sso/route.ts
index 44d22df..033a0aa 100644
--- a/app/api/decrypt-sso/route.ts
+++ b/app/api/decrypt-sso/route.ts
@@ -28,16 +28,6 @@ export async function POST(request: Request) {
 
   try {
     const session = decryptSso(blob as string);
-    // TEMPORARY diagnostic — log the decrypted session (role/type are the ones
-    // that decide the admin bypass). Remove after the filter is confirmed.
-    // eslint-disable-next-line no-console
-    console.log("[sso-session]", {
-      userId: session.userId,
-      role: session.role ?? null,
-      type: session.type ?? null,
-      companyId: session.companyId ?? null,
-      activeLocation: session.activeLocation ?? null,
-    });
     // Return only the fields the UI needs; the whole object is fine too since
     // it is the viewer's own session, but keep it tidy.
     return NextResponse.json(
diff --git a/app/api/opportunities/route.ts b/app/api/opportunities/route.ts
index 72efe3b..2d3031b 100644
--- a/app/api/opportunities/route.ts
+++ b/app/api/opportunities/route.ts
@@ -29,7 +29,7 @@ function visibleTo(
 }
 
 async function buildResponse(blob: string | null): Promise<Response> {
-  const { records, pipeline, stages, users, fieldDefs, rawSample } =
+  const { records, pipeline, stages, users, fieldDefs } =
     await getOltlOpportunities();
   const meta = { stages, users, fieldDefs };
 
@@ -37,11 +37,6 @@ async function buildResponse(blob: string | null): Promise<Response> {
   // (initial setup / local dev without GHL_SSO_SECRET) the route runs "open"
   // so the dashboard is usable; the UI still shows it as an unauthenticated view.
   if (!ssoConfigured()) {
-    // eslint-disable-next-line no-console
-    console.log("[visibility]", {
-      branch: "open-no-sso",
-      preFilterCount: records.length,
-    });
     const body: OpportunitiesResponse = {
       records,
       pipeline,
@@ -53,17 +48,6 @@ async function buildResponse(blob: string | null): Promise<Response> {
         role: null,
         total: records.length,
       },
-      debug: {
-        ssoConfigured: false,
-        branch: "open-no-sso",
-        userId: null,
-        role: null,
-        type: null,
-        preFilterCount: records.length,
-        postFilterCount: records.length,
-        sampleAssignedTo: rawSample.assignedTo,
-        sampleFollowers: rawSample.followers,
-      },
       ...meta,
     };
     return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
@@ -85,19 +69,6 @@ async function buildResponse(blob: string | null): Promise<Response> {
   const admin = isAdminSession(session.role, session.type);
   const visible = admin ? records : visibleTo(records, session.userId);
 
-  // TEMPORARY diagnostic — which branch ran + pre/post counts + session id/role/type.
-  // eslint-disable-next-line no-console
-  console.log("[visibility]", {
-    branch: admin ? "admin" : "restricted",
-    userId: session.userId,
-    role: session.role ?? null,
-    type: session.type ?? null,
-    preFilterCount: records.length,
-    postFilterCount: visible.length,
-    sampleAssignedTo: rawSample.assignedTo,
-    sampleFollowers: rawSample.followers,
-  });
-
   const body: OpportunitiesResponse = {
     records: visible,
     pipeline,
@@ -110,17 +81,6 @@ async function buildResponse(blob: string | null): Promise<Response> {
       type: session.type ?? null,
       total: records.length,
     },
-    debug: {
-      ssoConfigured: true,
-      branch: admin ? "admin" : "restricted",
-      userId: session.userId,
-      role: session.role ?? null,
-      type: session.type ?? null,
-      preFilterCount: records.length,
-      postFilterCount: visible.length,
-      sampleAssignedTo: rawSample.assignedTo,
-      sampleFollowers: rawSample.followers,
-    },
     ...meta,
   };
   return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 6e76b21..8fa9756 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -566,7 +566,6 @@ export async function getOltlOpportunities(): Promise<{
   stages: { id: string; name: string }[];
   users: { id: string; name: string }[];
   fieldDefs: EditableFieldDef[];
-  rawSample: { assignedTo: unknown; followers: unknown };
 }> {
   const pipeline = await resolvePipeline();
   const stageMap = new Map<string, string>();
@@ -591,10 +590,6 @@ export async function getOltlOpportunities(): Promise<{
     stages: (pipeline.stages || []).map((s) => ({ id: s.id, name: s.name })),
     users,
     fieldDefs,
-    rawSample: {
-      assignedTo: raw[0]?.assignedTo ?? null,
-      followers: raw[0]?.followers ?? null,
-    },
   };
 }
 
diff --git a/lib/types.ts b/lib/types.ts
index dcca2df..4e9a964 100644
--- a/lib/types.ts
+++ b/lib/types.ts
@@ -53,21 +53,6 @@ export interface Viewer {
   total: number; // total records before the visibility filter
 }
 
-// TEMPORARY diagnostic block surfaced in the /api/opportunities response so the
-// visibility path can be inspected in the browser Network tab. Remove after the
-// filter is confirmed.
-export interface VisibilityDebug {
-  ssoConfigured: boolean;
-  branch: "open-no-sso" | "admin" | "restricted";
-  userId: string | null;
-  role: string | null;
-  type: string | null;
-  preFilterCount: number;
-  postFilterCount: number;
-  sampleAssignedTo: unknown; // raw shape of one opp's owner
-  sampleFollowers: unknown; // raw shape of one opp's followers
-}
-
 export interface OpportunitiesResponse {
   records: OpportunityRecord[];
   pipeline: { id: string; name: string } | null;
@@ -77,7 +62,6 @@ export interface OpportunitiesResponse {
   fieldDefs?: EditableFieldDef[]; // OLTL opportunity custom-field definitions
   stages?: { id: string; name: string }[]; // OLTL pipeline stages (name→id)
   users?: { id: string; name: string }[]; // location users (owner picker)
-  debug?: VisibilityDebug; // TEMPORARY — visibility diagnostic
 }
 
 export interface ApiError {
```

---

## Task 2 — feat: multi-pipeline fetch with per-pipeline stage map

**Why:** the dashboard now spans 5 pipelines (data-driven via `PIPELINE_IDS`). Stage names repeat across pipelines, so the stage map is keyed by `pipelineId::stageId`. Records carry `pipelineId`/`pipelineName`/`shared`. `OLTL_PIPELINE_ID` + the `/oltl/i` fallback are retired.

**Rate-limit check (as requested):** pipelines are fetched **sequentially**. Budget = ceil(records/100) pages per pipeline; largest observed is OLTL Transfer (100+ ≈ 2 pages). Five pipelines + 3 shared lookups ≈ 10–15 requests total — far under GHL's 100-req/10s burst.

```diff
diff --git a/.env.example b/.env.example
index 05efc77..c77781c 100644
--- a/.env.example
+++ b/.env.example
@@ -24,11 +24,12 @@ GHL_LOCATION_ID=YVPhIAECw9q1M9Jw6A8L
 # sub-account Media Library never leaks in. Defaults to the created folder.
 RESOURCES_FOLDER_ID=6a75ea609994d35aa0c66e9a
 
-# OPTIONAL — the OLTL Enrollments pipeline ID.
-# If left blank, the API route looks the pipeline up by name (matches /oltl/i)
-# among the location's pipelines. Set this once you have the exact ID to skip
-# the lookup and remove any ambiguity.
-OLTL_PIPELINE_ID=
+# OPTIONAL — the pipelines the dashboard spans (v2 multi-pipeline).
+# Comma / pipe / whitespace separated pipeline IDs, in the order they should
+# appear. If left blank, defaults to the five confirmed for this account:
+#   OLTL Enrollment, OLTL Transfer, ODP Enrollment, ODP Transfer, Private Pay Clients.
+# (Replaces the retired OLTL_PIPELINE_ID + the /oltl/i name fallback.)
+PIPELINE_IDS=KGjdCMG4F8xILk0ineB9,74Pt3XX4hgBIqD10mW4G,a14NtTi18ACxs99bHPmL,PIs1iWVk0HqHZFNtmoTn,BJBWdRim6SOgjoMelVSZ
 
 # OPTIONAL — the caregiver↔client many-to-many association ID (Task 4).
 # Defaults to the known caregiver_client association for this tenant.
diff --git a/app/api/opportunities/route.ts b/app/api/opportunities/route.ts
index 2d3031b..aedcd95 100644
--- a/app/api/opportunities/route.ts
+++ b/app/api/opportunities/route.ts
@@ -29,9 +29,9 @@ function visibleTo(
 }
 
 async function buildResponse(blob: string | null): Promise<Response> {
-  const { records, pipeline, stages, users, fieldDefs } =
+  const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs } =
     await getOltlOpportunities();
-  const meta = { stages, users, fieldDefs };
+  const meta = { stages, users, fieldDefs, pipelines, stagesByPipeline };
 
   // SSO is enforced only once a Shared Secret is configured. Before that
   // (initial setup / local dev without GHL_SSO_SECRET) the route runs "open"
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 8fa9756..552ec59 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -221,28 +221,54 @@ async function getPipelines(): Promise<Pipeline[]> {
   return cache.pipelines;
 }
 
-export async function resolvePipeline(): Promise<Pipeline> {
+// Multi-pipeline (v2). The dashboard now spans several client pipelines. The
+// set is data-driven (env PIPELINE_IDS), defaulting to the five confirmed for
+// the anzcWt3S0tzpu2fEaS8X account. `OLTL_PIPELINE_ID` and the `/oltl/i` name
+// fallback are retired — four pipelines match that name now.
+const DEFAULT_PIPELINE_IDS = [
+  "KGjdCMG4F8xILk0ineB9", // OLTL Enrollment      12 stages
+  "74Pt3XX4hgBIqD10mW4G", // OLTL Transfer         8
+  "a14NtTi18ACxs99bHPmL", // ODP Enrollment        9
+  "PIs1iWVk0HqHZFNtmoTn", // ODP Transfer          9
+  "BJBWdRim6SOgjoMelVSZ", // Private Pay Clients  11
+];
+
+// Parse PIPELINE_IDS (comma / pipe / whitespace separated); fall back to the
+// defaults above. Order is preserved — it drives the admin selector order.
+export function pipelineIds(): string[] {
+  const raw = (process.env.PIPELINE_IDS || "").trim();
+  if (!raw) return DEFAULT_PIPELINE_IDS;
+  const ids = raw.split(/[\s,|]+/).map((s) => s.trim()).filter(Boolean);
+  return ids.length ? ids : DEFAULT_PIPELINE_IDS;
+}
+
+// Resolve the configured pipeline IDs to full Pipeline objects, in configured
+// order. Unknown IDs are skipped (logged via the error only if NONE match).
+export async function getSelectedPipelines(): Promise<Pipeline[]> {
   const pipelines = await getPipelines();
-  const configured = process.env.OLTL_PIPELINE_ID;
-  if (configured) {
-    const match = pipelines.find((p) => p.id === configured);
-    if (match) return match;
+  const byId = new Map(pipelines.map((p) => [p.id, p]));
+  const selected: Pipeline[] = [];
+  for (const id of pipelineIds()) {
+    const p = byId.get(id);
+    if (p) selected.push(p);
+  }
+  if (!selected.length) {
     throw new GhlError(
-      `No pipeline found with id "${configured}".`,
+      "None of the configured PIPELINE_IDS matched this account's pipelines.",
       404,
-      `Available pipelines: ${pipelines.map((p) => `${p.name} (${p.id})`).join(", ")}`,
+      `Configured: ${pipelineIds().join(", ")}. Available: ${pipelines
+        .map((p) => `${p.name} (${p.id})`)
+        .join(", ")}`,
     );
   }
-  // Fall back to matching by name when no id is configured.
-  const byName = pipelines.find((p) => /oltl/i.test(p.name));
-  if (byName) return byName;
-  throw new GhlError(
-    "Could not identify the OLTL Enrollments pipeline.",
-    404,
-    `Set OLTL_PIPELINE_ID. Available pipelines: ${pipelines
-      .map((p) => `${p.name} (${p.id})`)
-      .join(", ")}`,
-  );
+  return selected;
+}
+
+// Composite stage-map key — stage names repeat across pipelines
+// (TRANSFERRED IN, UNCATEGORIZED, INACTIVE, LOST all exist in several), so the
+// map MUST be keyed by pipelineId + stageId, never by name alone.
+function stageKey(pipelineId: string, stageId: string): string {
+  return `${pipelineId}::${stageId}`;
 }
 
 async function getFieldMap(): Promise<Map<string, string>> {
@@ -402,6 +428,9 @@ const FIELD_ALIASES: Record<keyof OpportunityRecord, string[]> = {
   monetaryValue: [],
   cf: [],
   contactId: [],
+  pipelineId: [],
+  pipelineName: [],
+  shared: [],
 };
 
 // Reverse lookup: normalized alias -> target key.
@@ -431,8 +460,10 @@ function normalizeOpportunity(
   opp: RawOpportunity,
   fieldMap: Map<string, string>,
   userMap: Map<string, string>,
-  stageMap: Map<string, string>,
+  stageNameByKey: Map<string, string>, // key = pipelineId::stageId
+  pipelineNameById: Map<string, string>,
 ): OpportunityRecord {
+  const pipelineId = opp.pipelineId || "";
   const rec: OpportunityRecord = {
     id: opp.id,
     first: "",
@@ -461,6 +492,9 @@ function normalizeOpportunity(
     monetaryValue: typeof opp.monetaryValue === "number" ? opp.monetaryValue : 0,
     cf: {},
     contactId: opp.contactId || opp.contact?.id || "",
+    pipelineId,
+    pipelineName: pipelineNameById.get(pipelineId) || "",
+    shared: false, // set true later by the access filter for non-home pipelines
   };
   // Resolve follower ids -> names via the same users lookup used for the owner.
   rec.followerNames = rec.followerIds.map((id) => userMap.get(id) || id);
@@ -485,9 +519,9 @@ function normalizeOpportunity(
     rec.last = parts.join(" ");
   }
 
-  // Stage name from stage id.
+  // Stage name from pipelineId + stage id (names repeat across pipelines).
   const stageId = opp.pipelineStageId || opp.stageId || "";
-  rec.stage = stageMap.get(stageId) || "";
+  rec.stage = stageNameByKey.get(stageKey(pipelineId, stageId)) || "";
 
   // Owner name.
   if (opp.assignedTo) {
@@ -562,32 +596,66 @@ export async function getEditableFieldDefs(): Promise<EditableFieldDef[]> {
 
 export async function getOltlOpportunities(): Promise<{
   records: OpportunityRecord[];
-  pipeline: { id: string; name: string };
+  pipeline: { id: string; name: string } | null;
+  pipelines: { id: string; name: string }[];
   stages: { id: string; name: string }[];
+  stagesByPipeline: Record<string, { id: string; name: string }[]>;
   users: { id: string; name: string }[];
   fieldDefs: EditableFieldDef[];
 }> {
-  const pipeline = await resolvePipeline();
-  const stageMap = new Map<string, string>();
-  for (const s of pipeline.stages || []) stageMap.set(s.id, s.name);
+  const selected = await getSelectedPipelines();
+
+  // Build: composite stage map (pipelineId::stageId -> name), pipeline-name
+  // lookup, per-pipeline stage lists, and a deduped union of stages.
+  const stageNameByKey = new Map<string, string>();
+  const pipelineNameById = new Map<string, string>();
+  const stagesByPipeline: Record<string, { id: string; name: string }[]> = {};
+  const unionSeen = new Set<string>();
+  const unionStages: { id: string; name: string }[] = [];
+  for (const p of selected) {
+    pipelineNameById.set(p.id, p.name);
+    stagesByPipeline[p.id] = (p.stages || []).map((s) => ({ id: s.id, name: s.name }));
+    for (const s of p.stages || []) {
+      stageNameByKey.set(stageKey(p.id, s.id), s.name);
+      if (!unionSeen.has(s.id)) {
+        unionSeen.add(s.id);
+        unionStages.push({ id: s.id, name: s.name });
+      }
+    }
+  }
 
-  const [fieldMap, userMap, raw, fieldDefs] = await Promise.all([
+  // Shared lookups (fetched once, in parallel).
+  const [fieldMap, userMap, fieldDefs] = await Promise.all([
     getFieldMap(),
     getUserMap(),
-    searchAll(pipeline.id),
     getEditableFieldDefs(),
   ]);
 
+  // Fetch each pipeline's opportunities SEQUENTIALLY to stay well under GHL's
+  // 100-req/10s burst limit. Budget: ceil(records/100) pages per pipeline. Even
+  // the largest observed (OLTL Transfer, 100+ ≈ 2 pages) across five pipelines
+  // plus the three shared lookups totals ~10-15 requests — comfortably safe.
+  const raw: RawOpportunity[] = [];
+  for (const p of selected) {
+    const batch = await searchAll(p.id);
+    // GHL returns pipelineId on each opp; stamp it as a fallback so stage +
+    // pipeline resolution is never ambiguous.
+    for (const o of batch) if (!o.pipelineId) o.pipelineId = p.id;
+    raw.push(...batch);
+  }
+
   const records = raw.map((o) =>
-    normalizeOpportunity(o, fieldMap, userMap, stageMap),
+    normalizeOpportunity(o, fieldMap, userMap, stageNameByKey, pipelineNameById),
   );
 
   const users = [...userMap.entries()].map(([id, name]) => ({ id, name }));
 
   return {
     records,
-    pipeline: { id: pipeline.id, name: pipeline.name },
-    stages: (pipeline.stages || []).map((s) => ({ id: s.id, name: s.name })),
+    pipeline: null, // v2: no single pipeline — see `pipelines`
+    pipelines: selected.map((p) => ({ id: p.id, name: p.name })),
+    stages: unionStages,
+    stagesByPipeline,
     users,
     fieldDefs,
   };
@@ -700,11 +768,17 @@ export async function getOpportunityById(
   }
   const opp = data.opportunity;
   if (!opp) return null;
-  const pipeline = await resolvePipeline();
-  const stageMap = new Map<string, string>();
-  for (const s of pipeline.stages || []) stageMap.set(s.id, s.name);
+  // Build the composite stage map + pipeline-name lookup across all selected
+  // pipelines, so this single opp resolves its stage name by pipelineId+stageId.
+  const selected = await getSelectedPipelines();
+  const stageNameByKey = new Map<string, string>();
+  const pipelineNameById = new Map<string, string>();
+  for (const p of selected) {
+    pipelineNameById.set(p.id, p.name);
+    for (const s of p.stages || []) stageNameByKey.set(stageKey(p.id, s.id), s.name);
+  }
   const [fieldMap, userMap] = await Promise.all([getFieldMap(), getUserMap()]);
-  return normalizeOpportunity(opp, fieldMap, userMap, stageMap);
+  return normalizeOpportunity(opp, fieldMap, userMap, stageNameByKey, pipelineNameById);
 }
 
 // ---------------------------------------------------------------------------
diff --git a/lib/types.ts b/lib/types.ts
index 4e9a964..0307d97 100644
--- a/lib/types.ts
+++ b/lib/types.ts
@@ -27,6 +27,10 @@ export interface OpportunityRecord {
   monetaryValue: number; // native value
   cf: Record<string, unknown>; // fieldId -> current raw value (arrays preserved)
   contactId: string; // linked contact — notes are stored on the contact
+  // Multi-pipeline (v2). A record now belongs to one of several pipelines.
+  pipelineId: string; // the opportunity's native pipelineId
+  pipelineName: string; // resolved pipeline name (for the division badge)
+  shared: boolean; // true when surfaced via a NON-home pipeline (owner/follower)
 }
 
 // Custom-field definition sent to the client to drive the dynamic editors.
@@ -55,13 +59,16 @@ export interface Viewer {
 
 export interface OpportunitiesResponse {
   records: OpportunityRecord[];
-  pipeline: { id: string; name: string } | null;
+  pipeline: { id: string; name: string } | null; // legacy single-pipeline summary (v2: null)
   count: number;
   viewer?: Viewer;
   // Metadata for the Phase 2 editors (same for all records).
   fieldDefs?: EditableFieldDef[]; // OLTL opportunity custom-field definitions
-  stages?: { id: string; name: string }[]; // OLTL pipeline stages (name→id)
+  stages?: { id: string; name: string }[]; // union of stages across pipelines (deduped by id)
   users?: { id: string; name: string }[]; // location users (owner picker)
+  // Multi-pipeline (v2).
+  pipelines?: { id: string; name: string }[]; // the selected pipelines, in order
+  stagesByPipeline?: Record<string, { id: string; name: string }[]>; // pipelineId -> its stages
 }
 
 export interface ApiError {
```

---

## Extra — chore: re-derive-IDs probe

You flagged this: the new account needs `RESOURCES_FOLDER_ID` + `CAREGIVER_ASSOCIATION_ID` re-derived (old ones don't exist here). Added `scripts/rederive-ids-probe.mjs`.

```diff
diff --git a/scripts/rederive-ids-probe.mjs b/scripts/rederive-ids-probe.mjs
new file mode 100644
index 0000000..fb186ae
--- /dev/null
+++ b/scripts/rederive-ids-probe.mjs
@@ -0,0 +1,45 @@
+#!/usr/bin/env node
+/**
+ * v2 STEP 0 — re-derive the two account-specific IDs for the NEW account
+ * (anzcWt3S0tzpu2fEaS8X): RESOURCES_FOLDER_ID (media folder) and
+ * CAREGIVER_ASSOCIATION_ID (caregiver_client association). The old account's
+ * IDs do not exist here, so the Resources tab and Caregivers panel need these.
+ *
+ *   $env:GHL_PIT="pit-..."
+ *   node scripts/rederive-ids-probe.mjs
+ */
+const BASE = "https://services.leadconnectorhq.com";
+const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
+if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
+
+const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
+const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
+
+async function main() {
+  // 1) Media FOLDERS — find the "OLTL Resources" (or equivalent) folder id.
+  console.log("=== MEDIA FOLDERS (pick the resources folder id) ===");
+  const fp = new URLSearchParams({ altType: "location", altId: LOC, type: "folder", limit: "100", offset: "0" });
+  const fr = await fetch(`${BASE}/medias/files?${fp}`, { headers: H });
+  const fj = await j(fr);
+  console.log("HTTP", fr.status);
+  const folders = (fj.files || fj.medias || []);
+  for (const f of folders) console.log(`  ${f.id ?? f._id}  "${f.name ?? f.fileName}"`);
+  if (!folders.length) console.log("  (no folders returned — check the type=folder param / scope)");
+
+  // 2) ASSOCIATIONS — find the caregiver_client association id.
+  console.log("\n=== ASSOCIATIONS (pick the caregiver_client id) ===");
+  const ar = await fetch(`${BASE}/associations/?locationId=${LOC}&limit=100&skip=0`, { headers: H });
+  const aj = await j(ar);
+  console.log("HTTP", ar.status);
+  const assocs = (aj.associations || aj.data || []);
+  for (const a of assocs)
+    console.log(`  ${a.id ?? a._id}  key="${a.key ?? a.associationKey ?? ""}"  "${a.firstObjectLabel ?? ""} <-> ${a.secondObjectLabel ?? ""}"`);
+  if (!assocs.length) console.log("  (none returned — the endpoint shape may differ; paste the raw body)");
+  if (typeof aj !== "object") console.log("raw:", String(aj).slice(0, 500));
+
+  console.log("\n>> Set in the new account's env:");
+  console.log(">>   RESOURCES_FOLDER_ID    = the resources folder id above");
+  console.log(">>   CAREGIVER_ASSOCIATION_ID = the caregiver_client association id above");
+}
+main().catch((e) => { console.error(e); process.exit(1); });
```
