# v2 Build Report — Account fixes + Task 4 (folder-driven field sets)

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26
**Build:** `next build` compiles clean.

Commits in this batch:
- 10fffac fix: Harmony ID and County ID editable; add derived fields to blocklist
- 9a2f88a feat: folder-driven field sets per pipeline
- ae8a02a fix: v2 account correctness — location, deep-links, probe user check

Contains the **complete unified diff for every changed line**.

## Answers to your two open items

**Blocker #1 (stale IDs):** fixed `GHL_LOCATION_ID` -> `anzcWt3S0tzpu2fEaS8X`, moved the frontend deep-link location to `NEXT_PUBLIC_GHL_LOCATION_ID`, flagged `RESOURCES_FOLDER_ID`/`CAREGIVER_ASSOCIATION_ID` + the access-map user ids as RE-DERIVE, and extended the probe to **list this account's users and flag any `PIPELINE_ACCESS_MAP` id not present**. The map values still need rebuilding from the probe output (your action).

**Blocker #2 (followers survive a transfer):** logged as gap **G1** in V2-REPORT-02, **not built**. Recommendation: fix it in **Task 6 (Move action)** using the **Task 5** follower-write mechanism — that's the only place the 'old owner loses access' requirement is defined (Option B), and `followers` isn't writable until Task 5. A standalone task would duplicate Task 6's transfer logic; Task 4 is unrelated. Awaiting your confirmation of that placement.

## Direction #3 — the GHL user custom field (so you can create it)

See the section at the end of this report.

---

## fix: v2 account correctness — location, deep-links, probe user check

```diff
diff --git a/.env.example b/.env.example
index 825b15c..85037ec 100644
--- a/.env.example
+++ b/.env.example
@@ -16,12 +16,18 @@ GHL_PIT=
 # to decrypt the SSO blob in /api/decrypt-sso. Never exposed to the browser.
 GHL_SSO_SECRET=
 
-# REQUIRED — the GHL sub-account (location) ID.
-GHL_LOCATION_ID=YVPhIAECw9q1M9Jw6A8L
+# REQUIRED — the GHL sub-account (location) ID. ⭐ v2 NEW ACCOUNT.
+GHL_LOCATION_ID=anzcWt3S0tzpu2fEaS8X
 
-# OPTIONAL — the OLTL Resources media folder ID (for the Resources tab).
-# The tab shows ONLY files whose parentId equals this folder, so the shared
-# sub-account Media Library never leaks in. Defaults to the created folder.
+# OPTIONAL — the same location id exposed to the browser, used ONLY to build
+# GHL deep-link URLs (e.g. a caregiver contact link). Not secret. Defaults to
+# the v2 account if unset.
+NEXT_PUBLIC_GHL_LOCATION_ID=anzcWt3S0tzpu2fEaS8X
+
+# ⬜ RE-DERIVE for the new account — the OLTL Resources media folder ID.
+# The value below is the OLD account's folder and will NOT exist here; run
+# scripts/rederive-ids-probe.mjs and replace it (the tab shows only files whose
+# parentId equals this folder, so the shared Media Library never leaks in).
 RESOURCES_FOLDER_ID=6a75ea609994d35aa0c66e9a
 
 # OPTIONAL — the pipelines the dashboard spans (v2 multi-pipeline).
@@ -41,10 +47,17 @@ PIPELINE_IDS=KGjdCMG4F8xILk0ineB9,74Pt3XX4hgBIqD10mW4G,a14NtTi18ACxs99bHPmL,PIs1
 #   Lamarr 2635GTUGcn7XLPeSa3as OLTL ; Chris w90ItEk0IDeSeTL7hAYJ OLTL-CHC
 PIPELINE_ACCESS_MAP=On2hTvaKMQ1ktEYcNs32:BJBWdRim6SOgjoMelVSZ,tR8rV1dcVfs3Z0wH5Ogg:a14NtTi18ACxs99bHPmL|PIs1iWVk0HqHZFNtmoTn,2635GTUGcn7XLPeSa3as:KGjdCMG4F8xILk0ineB9|74Pt3XX4hgBIqD10mW4G,w90ItEk0IDeSeTL7hAYJ:KGjdCMG4F8xILk0ineB9|74Pt3XX4hgBIqD10mW4G
 
-# OPTIONAL — the caregiver↔client many-to-many association ID (Task 4).
-# Defaults to the known caregiver_client association for this tenant.
+# ⬜ RE-DERIVE for the new account — the caregiver↔client association ID.
+# The value below is the OLD account's association and will NOT exist here. Run
+# scripts/rederive-ids-probe.mjs; if none is returned it must be CREATED
+# (POST /associations, key "caregiver_client") — the probe prints the payload.
 CAREGIVER_ASSOCIATION_ID=6a6e26c9884def7a1438b965
 
+# ⚠️ PIPELINE_ACCESS_MAP above uses OLD-account user IDs — they will not match
+# users in anzcWt3S0tzpu2fEaS8X. Run the probe (it lists this account's users +
+# warns on unmatched ids) and replace them, or every non-admin will (fail-closed)
+# see only what they own/follow.
+
 # OPTIONAL — GHL API version header. Defaults to 2021-07-28 if unset.
 GHL_API_VERSION=2021-07-28
 
diff --git a/V2-REPORT-02-ACCESS-SCOPING.md b/V2-REPORT-02-ACCESS-SCOPING.md
index b53300f..05e2ab8 100644
--- a/V2-REPORT-02-ACCESS-SCOPING.md
+++ b/V2-REPORT-02-ACCESS-SCOPING.md
@@ -274,3 +274,39 @@ index 5034b6f..b29aa10 100644
  
  // Edit permission == visibility (same rule). Kept as a named alias so intent is
 ```
+
+---
+
+## Known gaps (logged, not yet built)
+
+### G1 — Followers survive a transfer; nothing clears them
+`applyAccess`'s shared branch tests `owner OR follower` against **any** pipeline.
+The PATCH route (`app/api/opportunities/[id]/route.ts`) writes `assignedTo`
+only — `followers` is *read* in `normalizeOpportunity` but **never written**.
+So reassigning a lead removes the old rep's **owner** path but not their
+**follower** path: if they were a follower they keep the record as `shared`
+permanently, which violates the requirement that a transferred lead leaves the
+old rep's view entirely.
+
+**Recommendation — this belongs in Task 6 (the Move action), using the mechanism
+from Task 5, not its own task and not Task 4.**
+- Task 5 builds the dedicated follower add/remove endpoints — that's the *write*
+  mechanism (`followers` is not writable today).
+- Task 6's owner-changed (transfer) path is the only place the requirement
+  "old owner loses access" is defined and client-confirmed (Option B). The clean
+  fix is: on the transfer path, after setting the new owner, **remove the prior
+  owner (and any transferring-division followers) from `followers`** via the
+  Task 5 endpoint.
+- Putting it in Task 4 (field sets) would be unrelated; a standalone task would
+  duplicate Task 6's transfer logic.
+
+Not built pending your confirmation of that placement.
+
+### G2 — Account-specific IDs / access-map user IDs are from the old account
+`PIPELINE_ACCESS_MAP`, `RESOURCES_FOLDER_ID`, `CAREGIVER_ASSOCIATION_ID`, and the
+frontend deep-link location were all still on the old account. Addressed this
+round: `GHL_LOCATION_ID` → `anzcWt3S0tzpu2fEaS8X`, frontend location is now
+`NEXT_PUBLIC_GHL_LOCATION_ID` (defaulting to the v2 account), the two IDs are
+flagged RE-DERIVE in `.env.example`, and `rederive-ids-probe.mjs` now lists this
+account's users and warns on any `PIPELINE_ACCESS_MAP` id not present. The map
+values themselves still need rebuilding from the probe output (their action).
diff --git a/app/page.tsx b/app/page.tsx
index 47d5b68..b97c67d 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -26,7 +26,8 @@ import ImportWizard from "@/components/ImportWizard";
 import CaregiversSection from "@/components/CaregiversSection";
 import EmailComposer from "@/components/EmailComposer";
 
-const LOCATION_ID = "YVPhIAECw9q1M9Jw6A8L";
+const LOCATION_ID =
+  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
 
 // Preferred stage order for chips + board columns. Any stage present in the
 // live data but not listed here is appended after these, in first-seen order.
diff --git a/components/CaregiversSection.tsx b/components/CaregiversSection.tsx
index c5a7b90..5654072 100644
--- a/components/CaregiversSection.tsx
+++ b/components/CaregiversSection.tsx
@@ -3,7 +3,8 @@
 import { useCallback, useEffect, useRef, useState } from "react";
 import type { Caregiver } from "@/lib/types";
 
-const LOCATION_ID = "YVPhIAECw9q1M9Jw6A8L";
+const LOCATION_ID =
+  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
 const contactUrl = (contactId: string) =>
   `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/contacts/detail/${contactId}`;
 
diff --git a/scripts/rederive-ids-probe.mjs b/scripts/rederive-ids-probe.mjs
index 2b683d2..6d6391c 100644
--- a/scripts/rederive-ids-probe.mjs
+++ b/scripts/rederive-ids-probe.mjs
@@ -55,8 +55,46 @@ async function main() {
     console.log("     creates in the GHL Media Library — make it, then read its id back here.");
   }
 
+  // 3) USERS — so PIPELINE_ACCESS_MAP can be rebuilt with THIS account's ids.
+  console.log("\n=== USERS (rebuild PIPELINE_ACCESS_MAP from these ids) ===");
+  const ur = await fetch(`${BASE}/users/?locationId=${LOC}`, { headers: H });
+  const uj = await j(ur);
+  console.log("HTTP", ur.status);
+  const users = (uj.users || uj.data || []);
+  const userIds = new Set();
+  for (const u of users) {
+    const id = u.id ?? u._id ?? "";
+    userIds.add(String(id));
+    const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ");
+    const role = u.roles?.role ?? u.role ?? "";
+    console.log(`  ${id}  ${name}  <${u.email ?? ""}>  ${role}`);
+  }
+  if (!users.length) console.log("  (none returned — check the users.readonly scope)");
+
+  // Cross-check the configured PIPELINE_ACCESS_MAP ids against real users.
+  const mapRaw = (process.env.PIPELINE_ACCESS_MAP || "").trim();
+  if (mapRaw) {
+    console.log("\n=== PIPELINE_ACCESS_MAP id check ===");
+    const mapIds = mapRaw
+      .split(/[,;\n]+/)
+      .map((e) => e.split(":")[0]?.trim())
+      .filter(Boolean);
+    let anyMissing = false;
+    for (const id of mapIds) {
+      const ok = userIds.has(id);
+      if (!ok) anyMissing = true;
+      console.log(`  ${ok ? "✅" : "❌ NOT IN THIS ACCOUNT"}  ${id}`);
+    }
+    if (anyMissing)
+      console.log("  ⚠️ Unmatched ids mean those users see nothing but owned/followed. Rebuild the map from the USERS list above.");
+  } else {
+    console.log("\n(PIPELINE_ACCESS_MAP not set in this shell — set it to cross-check ids.)");
+  }
+
   console.log("\n>> Set in the new account's env:");
+  console.log(">>   GHL_LOCATION_ID          = anzcWt3S0tzpu2fEaS8X");
   console.log(">>   RESOURCES_FOLDER_ID      = the resources folder id above (create the folder if none)");
   console.log(">>   CAREGIVER_ASSOCIATION_ID = the caregiver_client association id above (create it if none)");
+  console.log(">>   PIPELINE_ACCESS_MAP      = rebuilt from the USERS list above");
 }
 main().catch((e) => { console.error(e); process.exit(1); });
```

---

## feat: folder-driven field sets per pipeline

```diff
diff --git a/app/page.tsx b/app/page.tsx
index b97c67d..d219318 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -25,6 +25,7 @@ import { useGhlSession } from "@/lib/useGhlSession";
 import ImportWizard from "@/components/ImportWizard";
 import CaregiversSection from "@/components/CaregiversSection";
 import EmailComposer from "@/components/EmailComposer";
+import { groupFieldsForPipeline } from "@/lib/fieldFolders";
 
 const LOCATION_ID =
   process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
@@ -131,8 +132,6 @@ const BlockPill = ({ b }: { b: string }) => (
 // ---- Phase 2 field editors ----
 type SaveState = { status: "saving" | "error"; msg?: string } | undefined;
 
-const normName = (s: string): string =>
-  s.toLowerCase().replace(/[^a-z0-9]/g, "");
 // Multi-select / long-text fields get a full-width row.
 const isWideField = (dt: string): boolean =>
   ["MULTIPLE_OPTIONS", "LARGE_TEXT"].includes((dt || "").toUpperCase());
@@ -987,6 +986,15 @@ export default function Dashboard() {
     [data, selId],
   );
 
+  // Folder-driven field sections for the open record's pipeline (Task 4).
+  const fieldGroups = useMemo(
+    () =>
+      selected
+        ? groupFieldsForPipeline(fieldDefs, selected.pipelineId)
+        : { sections: [], systemInfo: [], orphans: [] },
+    [selected, fieldDefs],
+  );
+
   const ssoHeader = (): Record<string, string> =>
     sso.status === "ready" ? { "x-ghl-sso-key": sso.blob } : {};
 
@@ -1134,29 +1142,24 @@ export default function Dashboard() {
     saveState[skey(id, fk)]?.status === "saving";
 
   // Look up a field definition by (fuzzy) name, and render its editor cell.
-  const fieldByName = (name: string) =>
-    fieldDefs.find((d) => normName(d.name) === normName(name));
-
-  // Render a set of custom fields by name (skips any not present here).
-  const renderCFs = (rec: OpportunityRecord, names: string[]): ReactNode =>
-    names.map((name) => {
-      const def = fieldByName(name);
-      if (!def) return null;
-      return (
-        <div
-          className={`f${isWideField(def.dataType) ? " wide" : ""}`}
-          key={`${rec.id}:${def.id}`}
-        >
-          <label>{def.name}</label>
-          <FieldControl
-            def={def}
-            value={rec.cf[def.id]}
-            save={saveState[skey(rec.id, def.id)]}
-            onSave={(val) => saveCustomField(rec, def, val)}
-          />
-        </div>
-      );
-    });
+  // Render one custom field from its definition (folder-driven path).
+  const renderField = (
+    rec: OpportunityRecord,
+    def: EditableFieldDef,
+  ): ReactNode => (
+    <div
+      className={`f${isWideField(def.dataType) ? " wide" : ""}`}
+      key={`${rec.id}:${def.id}`}
+    >
+      <label>{def.name}</label>
+      <FieldControl
+        def={def}
+        value={rec.cf[def.id]}
+        save={saveState[skey(rec.id, def.id)]}
+        onSave={(val) => saveCustomField(rec, def, val)}
+      />
+    </div>
+  );
 
   return (
     <div className="app">
@@ -1817,7 +1820,6 @@ export default function Dashboard() {
                   </select>
                   {saveMsgFor(selected.id, "stage")}
                 </div>
-                {renderCFs(selected, ["Road Blocker"])}
                 <div className="f">
                   <label>Status</label>
                   <select
@@ -1841,11 +1843,6 @@ export default function Dashboard() {
                   </select>
                   {saveMsgFor(selected.id, "status")}
                 </div>
-                {renderCFs(selected, [
-                  "Checked This Week",
-                  "Appeal",
-                  "Waiting",
-                ])}
               </div>
 
               {/* 2 — Assignment */}
@@ -1897,30 +1894,18 @@ export default function Dashboard() {
                     <span className="readonly-note">native GHL</span>
                   </div>
                 </div>
-                {renderCFs(selected, [
-                  "Case Manager",
-                  "Sales Rep Assistant",
-                  "Onboarding Rep",
-                  "HR / Assigned Team",
-                ])}
-              </div>
-
-              {/* 3 — Location */}
-              <div className="sechead">Location</div>
-              <div className="grid">
-                {renderCFs(selected, ["Office", "County"])}
               </div>
 
-              {/* 4 — Enrollment Details */}
-              <div className="sechead">Enrollment Details</div>
-              <div className="grid">
-                {renderCFs(selected, [
-                  "Division",
-                  "Type",
-                  "Referral Source Type",
-                  "Caregiver Name",
-                ])}
-              </div>
+              {/* Folder-driven field sections (Task 4) — rendered from the
+                  folders mapped to this record's pipeline, in configured order. */}
+              {fieldGroups.sections.map((g) => (
+                <Fragment key={g.key}>
+                  <div className="sechead">{g.label}</div>
+                  <div className="grid">
+                    {g.fields.map((def) => renderField(selected, def))}
+                  </div>
+                </Fragment>
+              ))}
 
               {/* Caregivers (many-to-many association) */}
               <div className="sechead">Caregivers</div>
@@ -1931,18 +1916,27 @@ export default function Dashboard() {
                 canManage={canEdit(selected)}
               />
 
-              {/* 5 — System info (read-only, collapsed) */}
-              <details className="sysinfo">
-                <summary>System info · read-only</summary>
-                <div className="grid">
-                  {renderCFs(selected, [
-                    "Harmony ID",
-                    "County ID",
-                    "Airtable Record ID",
-                    "APP - Compliance Cleared",
-                  ])}
-                </div>
-              </details>
+              {/* System info — external ids / derived / automation (collapsed).
+                  Airtable Record ID is editable here; compliance/derived are
+                  read-only via the blocklist. */}
+              {fieldGroups.systemInfo.length ? (
+                <details className="sysinfo">
+                  <summary>System info</summary>
+                  <div className="grid">
+                    {fieldGroups.systemInfo.map((def) => renderField(selected, def))}
+                  </div>
+                </details>
+              ) : null}
+
+              {/* Any field not in a mapped folder — never hidden. */}
+              {fieldGroups.orphans.length ? (
+                <details className="sysinfo">
+                  <summary>Other fields</summary>
+                  <div className="grid">
+                    {fieldGroups.orphans.map((def) => renderField(selected, def))}
+                  </div>
+                </details>
+              ) : null}
               <div className="sechead">Notes</div>
               <div>
                 {notesLoading ? (
diff --git a/lib/fieldFolders.ts b/lib/fieldFolders.ts
new file mode 100644
index 0000000..979eb22
--- /dev/null
+++ b/lib/fieldFolders.ts
@@ -0,0 +1,155 @@
+import type { EditableFieldDef } from "./types";
+
+// Task 4 — folder-driven field sets.
+//
+// Every opportunity custom field carries a `parentId` (its GHL custom-field
+// FOLDER). The record panel renders sections from the folders mapped to the
+// record's pipeline — replacing the old hardcoded, name-based five sections.
+// Adding/moving a field in GHL changes the panel with no code change.
+
+// Folder id ↔ semantic key (ids from the account build log).
+export const FOLDERS = {
+  webIntake: "q9YrpYwe9T0mQyRIJOr9", // 4
+  shared: "B6cunntgpATjWseEb1iC", // 6
+  client: "KKiWnjidBN65xGhJESgc", // 8
+  enrollment: "Jh2YEtaeoFYkx0o1YC2M", // 8
+  flags: "16CS34KrKsL8MCQHrbMG", // 3
+  milestones: "qsILANZN39yUarsgINk6", // 10
+  transfer: "7qJlA2QBcha929nsphFk", // 3
+  odp: "TIMuXWr8CgAVJhnBJtTj", // 3
+  lostReason: "EpVxmToo9FWx2Vsf9iLA", // 6
+  ppIntake: "P01rOtXIQddconuzrunx", // 6
+  adAttrib: "YwoE8EaNqcnd76TwMvkw", // 7
+  fbForm: "CVwUcXV27zGPUvRDOfBh", // 4
+} as const;
+
+type FolderKey = keyof typeof FOLDERS;
+
+// Section header shown for each folder.
+export const FOLDER_LABELS: Record<FolderKey, string> = {
+  webIntake: "Web Intake",
+  shared: "Shared",
+  client: "Client",
+  enrollment: "Enrollment",
+  flags: "Flags",
+  milestones: "Milestones",
+  transfer: "Transfer",
+  odp: "ODP",
+  lostReason: "Lost Reason",
+  ppIntake: "Private Pay Intake",
+  adAttrib: "Ad Attribution",
+  fbForm: "Facebook Form",
+};
+
+// Which folders render for which pipeline (order = section order).
+const F = FOLDERS;
+export const PIPELINE_FOLDERS: Record<string, string[]> = {
+  // OLTL Enrollment
+  KGjdCMG4F8xILk0ineB9: [
+    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.milestones, F.transfer, F.lostReason,
+  ],
+  // OLTL Transfer
+  "74Pt3XX4hgBIqD10mW4G": [
+    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.transfer, F.lostReason,
+  ],
+  // ODP Enrollment
+  a14NtTi18ACxs99bHPmL: [
+    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
+  ],
+  // ODP Transfer
+  PIs1iWVk0HqHZFNtmoTn: [
+    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
+  ],
+  // Private Pay Clients
+  BJBWdRim6SOgjoMelVSZ: [
+    F.webIntake, F.shared, F.client, F.ppIntake, F.adAttrib, F.fbForm, F.transfer, F.lostReason,
+  ],
+};
+
+// Option B — the Lost Reasons folder holds six fields (one per pipeline +
+// Caregiver Rejection). A lost-reason field renders ONLY on its pipeline.
+export const LOST_REASON_OVERRIDES: Record<string, string> = {
+  mf2biwVVXPgJv02laVs2: "KGjdCMG4F8xILk0ineB9", // OLTL Enrollment Lost Reason
+  "69Xa84NK1bCjWZRPDFhE": "74Pt3XX4hgBIqD10mW4G", // OLTL Transfer Lost Reason
+  "0lBuWb1a20jI5bwHuLjr": "a14NtTi18ACxs99bHPmL", // ODP Enrollment Lost Reason
+  nd271LsbIi4u2eZMXOCh: "PIs1iWVk0HqHZFNtmoTn", // ODP Transfer Lost Reason
+  dgP14Vpa1iqybLSnNPs1: "BJBWdRim6SOgjoMelVSZ", // Private Pay Lost Reason
+  AiuRVUF6UPcnLbZnHC7w: "EXVMveGzgDy9qf4wQR2H", // Caregiver Rejection Reason (recruiting pipeline)
+};
+
+// Fields that always live in the collapsed System info section, regardless of
+// their folder (external ids / derived / automation). Matched by normalized name.
+const SYSTEM_INFO_NAMES = [
+  "Airtable Record ID",
+  "APP - Compliance Cleared",
+  "Transferred From",
+  "Transferred Date",
+];
+
+const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
+const SYSTEM_INFO_SET = new Set(SYSTEM_INFO_NAMES.map(norm));
+
+// Reverse: folder id -> semantic key.
+const KEY_BY_ID = new Map<string, FolderKey>(
+  (Object.keys(FOLDERS) as FolderKey[]).map((k) => [FOLDERS[k], k]),
+);
+
+export interface FieldGroup {
+  key: string;
+  label: string;
+  fields: EditableFieldDef[];
+}
+
+// Group a record's fields for its pipeline:
+//   sections  — folder sections (in PIPELINE_FOLDERS order) with ≥1 field
+//   systemInfo — the collapsed read-only-ish block
+//   orphans   — fields with no/unknown folder (collapsed "Other", never hidden)
+export function groupFieldsForPipeline(
+  defs: EditableFieldDef[],
+  pipelineId: string,
+): { sections: FieldGroup[]; systemInfo: EditableFieldDef[]; orphans: EditableFieldDef[] } {
+  const allowed =
+    PIPELINE_FOLDERS[pipelineId]?.length
+      ? PIPELINE_FOLDERS[pipelineId]
+      : Object.values(FOLDERS); // unmapped pipeline → show all folders
+  const allowedKeys = new Set(
+    allowed.map((id) => KEY_BY_ID.get(id)).filter(Boolean) as FolderKey[],
+  );
+
+  const buckets = new Map<FolderKey, EditableFieldDef[]>();
+  const systemInfo: EditableFieldDef[] = [];
+  const orphans: EditableFieldDef[] = [];
+
+  for (const def of defs) {
+    if (SYSTEM_INFO_SET.has(norm(def.name))) {
+      systemInfo.push(def);
+      continue;
+    }
+    const key = def.parentId ? KEY_BY_ID.get(def.parentId) : undefined;
+    if (!key) {
+      orphans.push(def);
+      continue;
+    }
+    if (key === "lostReason") {
+      // Option B: only the lost-reason field mapped to THIS pipeline renders.
+      if (LOST_REASON_OVERRIDES[def.id] !== pipelineId) continue;
+    }
+    if (!allowedKeys.has(key)) continue; // folder not mapped to this pipeline
+    const arr = buckets.get(key) || [];
+    arr.push(def);
+    buckets.set(key, arr);
+  }
+
+  // Emit sections in the pipeline's configured folder order.
+  const sections: FieldGroup[] = [];
+  for (const folderId of allowed) {
+    const key = KEY_BY_ID.get(folderId);
+    if (!key) continue;
+    const fields = buckets.get(key);
+    if (fields && fields.length) {
+      sections.push({ key, label: FOLDER_LABELS[key], fields });
+    }
+  }
+
+  return { sections, systemInfo, orphans };
+}
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 552ec59..98e6693 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -591,6 +591,11 @@ export async function getEditableFieldDefs(): Promise<EditableFieldDef[]> {
     dataType: d.dataType,
     options: optionStrings(d),
     editable: isFieldEditable(d.name),
+    parentId: String(
+      (d as Record<string, unknown>).parentId ??
+        (d as Record<string, unknown>).folderId ??
+        "",
+    ),
   }));
 }
 
diff --git a/lib/types.ts b/lib/types.ts
index 0307d97..93dea14 100644
--- a/lib/types.ts
+++ b/lib/types.ts
@@ -40,6 +40,7 @@ export interface EditableFieldDef {
   dataType: string; // TEXT | LARGE_TEXT | SINGLE_OPTIONS | MULTIPLE_OPTIONS | DATE | NUMERICAL | MONETORY | CHECKBOX
   options: string[]; // option strings for *_OPTIONS / CHECKBOX
   editable: boolean; // false for the read-only blocklist
+  parentId: string; // custom-field folder id (drives folder-driven field sets)
 }
 
 export interface Note {
```

---

## fix: Harmony ID and County ID editable; add derived fields to blocklist

```diff
diff --git a/lib/editable.ts b/lib/editable.ts
index b86512e..a9a464f 100644
--- a/lib/editable.ts
+++ b/lib/editable.ts
@@ -11,13 +11,20 @@
 //   2. Automation-critical — editing misfires a GHL automation.
 // ---------------------------------------------------------------------------
 
+// v2 correction (Task 4): only fields where editing causes HARM are read-only.
+//   - Harmony ID / County ID are now EDITABLE — the state assigns a Harmony ID
+//     weeks into enrollment and a rep types it; nobody else can enter it.
+//   - Airtable Record ID is EDITABLE (rendered in a collapsed System info
+//     section); expected empty on a clean build. Switch to read-only later if a
+//     live Airtable sync is ever set up.
 export const READ_ONLY_FIELDS: string[] = [
-  // External identifiers
-  "Harmony ID",
-  "County ID",
-  "Airtable Record ID",
-  // Automation-critical — this field TRIGGERS the compliance automation.
+  // Automation-critical — this field TRIGGERS the compliance automation (WF3).
   "APP - Compliance Cleared",
+  // Derived by the Move action — must not be hand-edited.
+  "Transferred From",
+  "Transferred Date",
+  // Synced from the caregiver associations.
+  "Caregiver Name",
 ];
 
 const norm = (s: string): string =>
```

---

## Direction #3 — GHL user custom field spec (create this, then we swap the source)

`getUserHomePipelines()` is the single swap point. To move the division mapping
off the env var and onto the GHL user record:

**Create a custom field on the USER object:**
- **Name:** `Home Divisions` (or `Home Pipelines`)
- **Type:** Single-line **Text** (simplest) — or Multi-select if the UI offers it on users
- **Value format (recommended): division codes**, comma-separated — `OLTL`, `ODP`, `PP`
  - e.g. Lamarr = `OLTL`, Bill = `ODP`, Jackie = `PP`, a cross-division user = `OLTL,ODP`
  - Code maps to pipeline IDs in our code (OLTL → Enrollment+Transfer, etc.), so it
    survives pipeline-ID changes and is human-editable by an admin with no redeploy.
  - Storing raw pipeline IDs also works, but codes are far easier to maintain.

**What we need to confirm before wiring it (one probe):**
1. That GHL supports a custom field on the **user** object on this account, and
2. that the users API (`GET /users/?locationId=…` or `GET /users/{id}`) **returns
   that custom field's value**. If it doesn't come back on the list call, we read
   per-user or fall back to keeping the env map.

Once the field exists and returns, the swap is: `getUserHomePipelines()` reads the
user's `Home Divisions`, maps codes → pipeline IDs, done — no caller changes.
`PIPELINE_IDS` stays as the allowlist (deliberate scope), and pipelines keep being
fetched from the API. Tell me the field is created and I'll wire the read.
