# v2 Build Report — Move follow-ups + Task 7 (UI)

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26  •  Build: clean.

Commits:
- 1ea14ca feat: division badges, shared-with-me filter, user labels, board scoping
- 382d243 fix: Move — stranded-record reporting, PUT #2 retry, honest toggle label

Contains the **complete unified diff for every changed line**.

## Your three Move follow-ups

**1. Stranded record.** PUT #2 now **retries 3× with backoff**. On final failure `MoveResult.stranded` is set and the 500 says it outright:

> ⚠️ THIS RECORD IS STRANDED: the owner has already changed and followers were cleared, but it is STILL IN THE SOURCE PIPELINE. The new owner will only see it as 'shared' and the previous owner cannot see it at all — nobody will find it by browsing. Move it to the destination pipeline in GoHighLevel now, or re-run this Move (the owner change is already done, so it will be treated as a simple move).

**2. Toggle relabelled** to *"Keep me on this lead — I'll still see it after the transfer"*, plus an inline warning when ticked that the lead does **not** leave the originating division.

**3. `removeOpportunityFollowers` is atomic on our side** — it sends **one DELETE with the whole array**, no loop, so this code can never partially clear. GHL's handling of a failed batch is unverified, so a failure now reports `attemptedFollowerRemovals` (the exact ids requested), since any still attached keep shared access.

Transfer Reason kept alongside the note, as agreed.

## Task 7 — UI

| Requirement | Built |
|---|---|
| Division badge, chip not heading | list row, panel sub-header, board card |
| Filter All / division / Shared with me | `Show` select |
| Never name other divisions | options derived from the **filtered payload**, not the pipeline list |
| Shared record's pipeline never in the selector | shared records are excluded from division options (they appear only under "Shared with me") |
| Provenance on shared records | "Shared by <owner> · you're a follower" (or "Your record in another division" when they own it) |
| Division label on every user | `Name — DIV`, multi-division joined with ` · ` |
| No division mapped -> `—` | renders, never hidden |
| Deleted user -> "Former user" | owner picker + follower chips |
| Owner lists EVERYONE | yes |
| Board = home pipelines only | `boardVisible` excludes shared + non-home; columns from those pipelines' stages |
| Admin pipeline selector | toolbar, `isAdminViewer` only — convenience, server is the boundary |

**No hardcoded division map:** `divisionLabel()` derives the division from the pipeline **name** by stripping the workflow suffix, so it stays consistent with Task 6 where we deliberately dropped that map.

---

## fix: Move — stranded-record reporting, PUT #2 retry, honest toggle label

```diff
diff --git a/app/api/opportunities/[id]/move/route.ts b/app/api/opportunities/[id]/move/route.ts
index 9f970c7..e6f20bd 100644
--- a/app/api/opportunities/[id]/move/route.ts
+++ b/app/api/opportunities/[id]/move/route.ts
@@ -95,15 +95,30 @@ export async function POST(
 
     // A partial move is reported as 500 WITH the completed steps, so the caller
     // can finish manually instead of believing the move succeeded.
-    if (result.failedStep)
+    if (result.failedStep) {
+      const parts = [
+        `Completed: ${result.steps.join(" → ") || "nothing"}.`,
+      ];
+      if (result.stranded)
+        parts.push(
+          "⚠️ THIS RECORD IS STRANDED: the owner has already changed and followers were cleared, but it is STILL IN THE SOURCE PIPELINE. The new owner will only see it as 'shared' and the previous owner cannot see it at all — nobody will find it by browsing. Move it to the destination pipeline in GoHighLevel now, or re-run this Move (the owner change is already done, so it will be treated as a simple move).",
+        );
+      if (result.attemptedFollowerRemovals?.length)
+        parts.push(
+          `Follower removals attempted (verify in GHL; any still attached keep shared access): ${result.attemptedFollowerRemovals.join(", ")}.`,
+        );
+      if (result.error) parts.push(result.error);
       return NextResponse.json(
         {
-          error: `Move stopped at "${result.failedStep}".`,
-          detail: `Completed: ${result.steps.join(" → ") || "nothing"}. ${result.error ?? ""}`,
+          error: result.stranded
+            ? "Move incomplete — record stranded in the source pipeline."
+            : `Move stopped at "${result.failedStep}".`,
+          detail: parts.join(" "),
           status: 500,
         } as ApiError,
         { status: 500 },
       );
+    }
 
     const record = await getOpportunityById(id);
     return NextResponse.json(
diff --git a/app/globals.css b/app/globals.css
index 196f6fd..c63d70c 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -393,3 +393,4 @@ button.rescard{width:100%;text-align:left;font:inherit;cursor:pointer;background
 .movewarn{font-size:12px;line-height:1.55;color:var(--blk);background:var(--blk-soft);border:1px solid #f3c9c2;border-radius:9px;padding:11px 13px;}
 .movetoggle{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:11.5px;font-weight:600;color:var(--ink-2);cursor:pointer;}
 .movetoggle input{margin:0;accent-color:var(--plum);}
+.movetoggle-note{margin-top:6px;font-size:11px;line-height:1.5;color:var(--wait);background:var(--wait-soft);border:1px solid #f0dcae;border-radius:7px;padding:7px 10px;}
diff --git a/components/MoveDialog.tsx b/components/MoveDialog.tsx
index 0d77908..3652a12 100644
--- a/components/MoveDialog.tsx
+++ b/components/MoveDialog.tsx
@@ -175,8 +175,15 @@ export default function MoveDialog({
                   checked={addSender}
                   onChange={(e) => setAddSender(e.target.checked)}
                 />
-                Keep the current owner as a follower (retains access)
+                Keep me on this lead — I&apos;ll still see it after the transfer
               </label>
+              {addSender ? (
+                <div className="movetoggle-note">
+                  The previous owner stays a follower, so this lead does{" "}
+                  <b>not</b> leave the originating division — it keeps appearing
+                  for them as shared until removed.
+                </div>
+              ) : null}
             </div>
           ) : (
             <div className="imeta">
diff --git a/lib/ghl.ts b/lib/ghl.ts
index c6bb3cc..2fc181f 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -1014,6 +1014,8 @@ export interface MoveResult {
   steps: string[]; // completed steps, in order
   failedStep?: string; // set when we stopped early
   error?: string;
+  stranded?: boolean; // owner moved but the record never left the source pipeline
+  attemptedFollowerRemovals?: string[]; // ids we asked GHL to clear (on failure)
 }
 
 const normOpt = (s: string): string =>
@@ -1152,8 +1154,12 @@ export async function moveOpportunity(args: {
   }
 
   // 2. Clear followers — all except the new owner (G1).
+  // removeOpportunityFollowers sends ONE DELETE with the whole array (no loop),
+  // so we never partially clear from this side. GHL's server-side handling of a
+  // failed batch is unverified, so on failure we report exactly which ids were
+  // ATTEMPTED — any still attached keep shared access until cleared manually.
+  const toRemove = current.followerIds.filter((f) => f !== args.newOwnerId);
   try {
-    const toRemove = current.followerIds.filter((f) => f !== args.newOwnerId);
     if (toRemove.length) {
       await removeOpportunityFollowers(args.oppId, toRemove);
       steps.push(`cleared ${toRemove.length} follower(s)`);
@@ -1168,6 +1174,7 @@ export async function moveOpportunity(args: {
       steps,
       failedStep: "clear followers",
       error: e instanceof Error ? e.message : String(e),
+      attemptedFollowerRemovals: toRemove,
     };
   }
 
@@ -1191,22 +1198,34 @@ export async function moveOpportunity(args: {
   }
 
   // 4. Pipeline + TRANSFERRED IN — after the owner change (GHL constraint).
-  try {
-    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
-      pipelineId: args.toPipelineId,
-      pipelineStageId: destStageId,
-    });
-    steps.push("moved pipeline+stage (TRANSFERRED IN)");
-  } catch (e) {
-    return {
-      transferred: true,
-      steps,
-      failedStep: "move pipeline",
-      error: e instanceof Error ? e.message : String(e),
-    };
+  // This is the step whose failure STRANDS the record: the owner has already
+  // changed and followers are cleared, but the record is still in the SOURCE
+  // pipeline — which is not in the new owner's home set, so they see it only as
+  // "shared", and the previous owner cannot see it at all. Nobody finds it by
+  // browsing. Retry a couple of times before giving up, then flag it loudly.
+  let lastErr: unknown = null;
+  for (let attempt = 1; attempt <= 3; attempt++) {
+    try {
+      await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
+        pipelineId: args.toPipelineId,
+        pipelineStageId: destStageId,
+      });
+      steps.push(
+        `moved pipeline+stage (TRANSFERRED IN)${attempt > 1 ? ` after ${attempt} attempts` : ""}`,
+      );
+      return { transferred: true, steps };
+    } catch (e) {
+      lastErr = e;
+      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
+    }
   }
-
-  return { transferred: true, steps };
+  return {
+    transferred: true,
+    stranded: true,
+    steps,
+    failedStep: "move pipeline",
+    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
+  };
 }
 
 // ---------------------------------------------------------------------------
```

---

## feat: division badges, shared-with-me filter, user labels, board scoping

```diff
diff --git a/app/api/opportunities/route.ts b/app/api/opportunities/route.ts
index 4f7336d..c801d28 100644
--- a/app/api/opportunities/route.ts
+++ b/app/api/opportunities/route.ts
@@ -2,7 +2,11 @@ import { NextResponse } from "next/server";
 import { getOltlOpportunities, GhlError } from "@/lib/ghl";
 import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
 import { isAdminSession } from "@/lib/visibility";
-import { applyAccess } from "@/lib/pipelineAccess";
+import {
+  applyAccess,
+  userDivisions,
+  getUserHomePipelines,
+} from "@/lib/pipelineAccess";
 import type { OpportunitiesResponse, ApiError } from "@/lib/types";
 
 // Always dynamic; the GHL token and SSO secret are only ever read server-side.
@@ -20,7 +24,19 @@ export const runtime = "nodejs";
 async function buildResponse(blob: string | null): Promise<Response> {
   const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs } =
     await getOltlOpportunities();
-  const meta = { stages, users, fieldDefs, pipelines, stagesByPipeline };
+  // Label every user with their division(s) for the owner/follower pickers.
+  const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name]));
+  const labelledUsers = users.map((u) => ({
+    ...u,
+    divisions: userDivisions(u.id, pipelineNameById),
+  }));
+  const meta = {
+    stages,
+    users: labelledUsers,
+    fieldDefs,
+    pipelines,
+    stagesByPipeline,
+  };
 
   // SSO is enforced only once a Shared Secret is configured. Before that
   // (initial setup / local dev without GHL_SSO_SECRET) the route runs "open"
@@ -36,6 +52,8 @@ async function buildResponse(blob: string | null): Promise<Response> {
         userName: null,
         role: null,
         total: records.length,
+        // Open/setup mode behaves like an admin: every selected pipeline is home.
+        homePipelineIds: pipelines.map((p) => p.id),
       },
       ...meta,
     };
@@ -70,6 +88,10 @@ async function buildResponse(blob: string | null): Promise<Response> {
       role: session.role ?? null,
       type: session.type ?? null,
       total: records.length,
+      // Admins treat every selected pipeline as home; others get their mapped set.
+      homePipelineIds: admin
+        ? pipelines.map((p) => p.id)
+        : [...getUserHomePipelines(session.userId)],
     },
     ...meta,
   };
diff --git a/app/globals.css b/app/globals.css
index c63d70c..1c4e73a 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -394,3 +394,9 @@ button.rescard{width:100%;text-align:left;font:inherit;cursor:pointer;background
 .movetoggle{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:11.5px;font-weight:600;color:var(--ink-2);cursor:pointer;}
 .movetoggle input{margin:0;accent-color:var(--plum);}
 .movetoggle-note{margin-top:6px;font-size:11px;line-height:1.5;color:var(--wait);background:var(--wait-soft);border:1px solid #f0dcae;border-radius:7px;padding:7px 10px;}
+
+/* ── Task 7: division badges, provenance, board card division ─── */
+.divbadge{display:inline-block;margin-left:8px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--plum);background:var(--plum-soft);border:1px solid var(--plum-line);border-radius:20px;padding:1px 7px;vertical-align:middle;}
+.provenance{font-size:10.5px;color:var(--ink-3);font-style:italic;margin-top:2px;}
+.phead .provenance{margin-top:5px;font-style:normal;color:var(--wait);background:var(--wait-soft);border:1px solid #f0dcae;border-radius:6px;padding:3px 8px;display:inline-block;}
+.card .cdiv{margin-top:5px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);}
diff --git a/app/page.tsx b/app/page.tsx
index 3ddafa2..0ec3508 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -27,6 +27,7 @@ import CaregiversSection from "@/components/CaregiversSection";
 import EmailComposer from "@/components/EmailComposer";
 import { groupFieldsForPipeline } from "@/lib/fieldFolders";
 import MoveDialog from "@/components/MoveDialog";
+import { divisionLabel } from "@/lib/division";
 
 const LOCATION_ID =
   process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
@@ -410,6 +411,11 @@ function CardBody({
       <div className="cm">
         {r.office || "—"} · {r.rep}
       </div>
+      {r.pipelineName ? (
+        <div className="cdiv" title={r.pipelineName}>
+          {divisionLabel(r.pipelineName)}
+        </div>
+      ) : null}
       <div className="cf">
         <BlockPill b={r.block} />
         {r.src ? <span className="pill src">{r.src}</span> : null}
@@ -473,8 +479,14 @@ export default function Dashboard() {
   const [pipelineStages, setPipelineStages] = useState<
     { id: string; name: string }[]
   >([]);
-  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
+  const [users, setUsers] = useState<
+    { id: string; name: string; divisions?: string[] }[]
+  >([]);
   const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
+  // v2 UI — viewer's home pipelines + the division / shared-with-me filter.
+  const [homePipelineIds, setHomePipelineIds] = useState<string[]>([]);
+  const [scope, setScope] = useState<string>("all"); // "all" | "shared" | <division>
+  const [adminPipeline, setAdminPipeline] = useState<string>("all");
   // Multi-pipeline metadata (v2) — drives the Move dialog.
   const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
   const [stagesByPipeline, setStagesByPipeline] = useState<
@@ -551,6 +563,8 @@ export default function Dashboard() {
       if (body.users) setUsers(body.users);
       if (body.pipelines) setPipelines(body.pipelines);
       if (body.stagesByPipeline) setStagesByPipeline(body.stagesByPipeline);
+      if (body.viewer?.homePipelineIds)
+        setHomePipelineIds(body.viewer.homePipelineIds);
     } catch (e) {
       setError({
         error: "Could not reach the dashboard API.",
@@ -753,19 +767,52 @@ export default function Dashboard() {
     return [...set].sort((a, b) => a.localeCompare(b));
   }, [data]);
 
+  // Division / "Shared with me" filter options are built from the FILTERED
+  // PAYLOAD — never from the pipeline list — so the dropdown can't name a
+  // division the viewer holds nothing in. A shared record's pipeline never
+  // becomes a division option (it appears only under "Shared with me").
+  const scopeOptions = useMemo(() => {
+    const divisions = new Set<string>();
+    let anyShared = false;
+    for (const r of data) {
+      if (r.shared) anyShared = true;
+      else if (r.pipelineName) divisions.add(divisionLabel(r.pipelineName));
+    }
+    return { divisions: [...divisions].sort(), anyShared };
+  }, [data]);
+
+  // Owner/follower picker label: "Name — DIV". No division mapped renders "—"
+  // (a new hire must not be invisible); an unknown id renders "Former user".
+  const userLabel = useCallback(
+    (uid: string): string => {
+      if (!uid) return "Unassigned";
+      const u = users.find((x) => x.id === uid);
+      if (!u) return "Former user";
+      const div = u.divisions?.length ? u.divisions.join(" · ") : "—";
+      return `${u.name} — ${div}`;
+    },
+    [users],
+  );
+
   const filtered = useMemo(() => {
     const needle = q.trim().toLowerCase();
     return data.filter(
       (r) =>
         (stage === "all" || r.stage === stage) &&
         (office === "all" || r.office === office) &&
+        (scope === "all" ||
+          (scope === "shared"
+            ? r.shared
+            : !r.shared && divisionLabel(r.pipelineName) === scope)) &&
+        // Admin-only pipeline selector (convenience; the server is the boundary).
+        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
         (needle === "" ||
           // Searchable by name, office, stage, and the key people/ids.
           `${r.first} ${r.last} ${r.office} ${r.stage} ${r.harmony} ${r.cm} ${r.cg} ${r.rep} ${r.src}`
             .toLowerCase()
             .includes(needle)),
     );
-  }, [data, stage, office, q]);
+  }, [data, stage, office, q, scope, adminPipeline]);
 
   const stageIndex = useCallback(
     (name: string) => {
@@ -897,7 +944,14 @@ export default function Dashboard() {
     >
       <td className="strong">
         <div className="clientcell">
-          <span className="clname">{clientName(r) || "—"}</span>
+          <span className="clname">
+            {clientName(r) || "—"}
+            {r.pipelineName ? (
+              <span className="divbadge" title={r.pipelineName}>
+                {divisionLabel(r.pipelineName)}
+              </span>
+            ) : null}
+          </span>
           {followsNotOwns(r) ? (
             <span
               className="follow-tag"
@@ -906,6 +960,14 @@ export default function Dashboard() {
               Following
             </span>
           ) : null}
+          {/* Provenance — only on records reached via the shared path. */}
+          {r.shared ? (
+            <span className="provenance">
+              {r.ownerId === viewerId
+                ? "Your record in another division"
+                : `Shared by ${r.rep || "—"} · you're a follower`}
+            </span>
+          ) : null}
           {r.cg && r.cg !== "—" ? (
             <span className="clcg" title="Caregiver">
               {r.cg}
@@ -951,14 +1013,21 @@ export default function Dashboard() {
     </tr>
   );
 
+  // The BOARD shows HOME pipelines only — foreign stages don't belong in your
+  // columns, and a shared record's pipeline must never enter the selector. The
+  // list still shows everything (with division badges).
   const boardVisible = useMemo(() => {
     const needle = q.trim().toLowerCase();
+    const home = new Set(homePipelineIds);
     return data.filter(
       (r) =>
-        needle === "" ||
-        `${r.first} ${r.last}`.toLowerCase().includes(needle),
+        !r.shared &&
+        (home.size === 0 || home.has(r.pipelineId)) &&
+        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
+        (needle === "" ||
+          `${r.first} ${r.last}`.toLowerCase().includes(needle)),
     );
-  }, [data, q]);
+  }, [data, q, homePipelineIds, adminPipeline]);
 
   // Stats (client-requested tiles: total, per office, by source, per rep).
   const stats = useMemo(() => {
@@ -1178,17 +1247,48 @@ export default function Dashboard() {
   // Board columns = the FULL OLTL pipeline (every stage, incl. empty ones) so you
   // can drag into an empty stage. Falls back to data-derived stages pre-load, and
   // appends any stray stage present in data but not in the pipeline list.
+  // Columns come from the board's own pipeline(s): the admin-selected pipeline
+  // if set, else the viewer's home pipelines. Stage names repeat across
+  // pipelines, so we dedupe by name in the pipelines' own order.
   const boardStages = useMemo(() => {
-    if (!pipelineStages.length) return stages;
-    const names = pipelineStages.map((s) => s.name);
-    const set = new Set(names);
-    for (const r of data)
+    const ids =
+      adminPipeline !== "all"
+        ? [adminPipeline]
+        : homePipelineIds.length
+          ? homePipelineIds
+          : pipelines.map((p) => p.id);
+    const names: string[] = [];
+    const set = new Set<string>();
+    for (const pid of ids)
+      for (const s of stagesByPipeline[pid] || [])
+        if (!set.has(s.name)) {
+          set.add(s.name);
+          names.push(s.name);
+        }
+    if (!names.length) {
+      if (!pipelineStages.length) return stages;
+      for (const s of pipelineStages)
+        if (!set.has(s.name)) {
+          set.add(s.name);
+          names.push(s.name);
+        }
+    }
+    // Keep any stray stage present in the data but not in the stage lists.
+    for (const r of boardVisible)
       if (r.stage && !set.has(r.stage)) {
         set.add(r.stage);
         names.push(r.stage);
       }
     return names;
-  }, [pipelineStages, data, stages]);
+  }, [
+    adminPipeline,
+    homePipelineIds,
+    pipelines,
+    stagesByPipeline,
+    pipelineStages,
+    stages,
+    boardVisible,
+  ]);
 
   const saveMsgFor = (id: string, fk: string): ReactNode => {
     const s = saveState[skey(id, fk)];
@@ -1410,6 +1510,47 @@ export default function Dashboard() {
               onChange={(e) => setQ(e.target.value)}
             />
           </div>
+          {/* Division / Shared-with-me — options come from the viewer's own
+              payload, so no division they hold nothing in is ever named. */}
+          {scopeOptions.divisions.length > 1 || scopeOptions.anyShared ? (
+            <div className="officefilter">
+              <label htmlFor="scopeSel">Show</label>
+              <select
+                id="scopeSel"
+                value={scope}
+                onChange={(e) => setScope(e.target.value)}
+              >
+                <option value="all">All</option>
+                {scopeOptions.divisions.map((d) => (
+                  <option key={d} value={d}>
+                    {d}
+                  </option>
+                ))}
+                {scopeOptions.anyShared ? (
+                  <option value="shared">Shared with me</option>
+                ) : null}
+              </select>
+            </div>
+          ) : null}
+          {/* Admin-only pipeline selector — convenience; the SERVER decides
+              what returns, this only narrows what is already visible. */}
+          {isAdminViewer && pipelines.length > 1 ? (
+            <div className="officefilter">
+              <label htmlFor="pipeSel">Pipeline</label>
+              <select
+                id="pipeSel"
+                value={adminPipeline}
+                onChange={(e) => setAdminPipeline(e.target.value)}
+              >
+                <option value="all">All pipelines</option>
+                {pipelines.map((p) => (
+                  <option key={p.id} value={p.id}>
+                    {p.name}
+                  </option>
+                ))}
+              </select>
+            </div>
+          ) : null}
           <div className="officefilter">
             <label htmlFor="officeSel">Office</label>
             <select
@@ -1839,7 +1980,19 @@ export default function Dashboard() {
                 <div className="sub">
                   {clientName(selected) || "—"} · {selected.office || "—"} ·{" "}
                   {selected.stage || "—"}
+                  {selected.pipelineName ? (
+                    <span className="divbadge" title={selected.pipelineName}>
+                      {divisionLabel(selected.pipelineName)}
+                    </span>
+                  ) : null}
                 </div>
+                {selected.shared ? (
+                  <div className="provenance">
+                    {selected.ownerId === viewerId
+                      ? "Your record in another division"
+                      : `Shared by ${userLabel(selected.ownerId)} · you're a follower`}
+                  </div>
+                ) : null}
               </div>
               <button
                 className="x"
@@ -1957,11 +2110,19 @@ export default function Dashboard() {
                     }
                   >
                     <option value="">Unassigned</option>
+                    {/* Owner lists EVERYONE — a rep must be able to reassign to
+                        a colleague. Division label after each name. */}
                     {users.map((u) => (
                       <option key={u.id} value={u.id}>
-                        {u.name}
+                        {u.name} —{" "}
+                        {u.divisions?.length ? u.divisions.join(" · ") : "—"}
                       </option>
                     ))}
+                    {/* An owner who no longer exists still renders, never blank. */}
+                    {selected.ownerId &&
+                    !users.some((u) => u.id === selected.ownerId) ? (
+                      <option value={selected.ownerId}>Former user</option>
+                    ) : null}
                   </select>
                   {saveMsgFor(selected.id, "owner")}
                 </div>
@@ -2018,7 +2179,10 @@ export default function Dashboard() {
                           )
                           .map((u) => (
                             <option key={u.id} value={u.id}>
-                              {u.name}
+                              {u.name} —{" "}
+                              {u.divisions?.length
+                                ? u.divisions.join(" · ")
+                                : "—"}
                             </option>
                           ))}
                       </select>
diff --git a/lib/division.ts b/lib/division.ts
new file mode 100644
index 0000000..55ffbfa
--- /dev/null
+++ b/lib/division.ts
@@ -0,0 +1,11 @@
+// Division labels, derived from pipeline NAMES — no hardcoded pipeline→division
+// map (we deliberately removed that in Task 6). "OLTL Enrollment" and "OLTL
+// Transfer" both reduce to "OLTL"; "Private Pay Clients" to "Private Pay".
+// Pure and env-free so both the server and the client bundle can import it.
+
+const WORKFLOW_SUFFIX = /\s+(enrollments?|transfers?|clients?|applicants?)$/i;
+
+export function divisionLabel(pipelineName: string): string {
+  if (!pipelineName) return "";
+  return pipelineName.replace(WORKFLOW_SUFFIX, "").trim() || pipelineName;
+}
diff --git a/lib/pipelineAccess.ts b/lib/pipelineAccess.ts
index f4ad065..c22d9b9 100644
--- a/lib/pipelineAccess.ts
+++ b/lib/pipelineAccess.ts
@@ -1,4 +1,5 @@
 import type { OpportunityRecord } from "./types";
+import { divisionLabel } from "./division";
 
 // Task 3 — pipeline access (division scoping).
 //
@@ -58,6 +59,21 @@ export function getUserHomePipelines(userId: string): Set<string> {
   return _cache.get(userId) || new Set<string>();
 }
 
+// The division label(s) a user belongs to, derived from their HOME pipelines'
+// names. Empty array = no division mapped — the picker renders "—" rather than
+// hiding the user (a new hire must not be invisible).
+export function userDivisions(
+  userId: string,
+  pipelineNameById: Map<string, string>,
+): string[] {
+  const out = new Set<string>();
+  for (const pid of getUserHomePipelines(userId)) {
+    const name = pipelineNameById.get(pid);
+    if (name) out.add(divisionLabel(name));
+  }
+  return [...out];
+}
+
 // Filter + tag records for one viewer. Returns a NEW array; each surviving
 // record gets its `shared` flag set correctly for this viewer.
 export function applyAccess(
diff --git a/lib/types.ts b/lib/types.ts
index 93dea14..f3ae0cd 100644
--- a/lib/types.ts
+++ b/lib/types.ts
@@ -56,6 +56,9 @@ export interface Viewer {
   role: string | null;
   type?: string | null; // GHL session `type` (agency/location) — diagnostic
   total: number; // total records before the visibility filter
+  // v2 — the viewer's HOME pipelines (admins: all selected). Drives the board
+  // (home pipelines only) and the division filter.
+  homePipelineIds?: string[];
 }
 
 export interface OpportunitiesResponse {
@@ -66,7 +69,9 @@ export interface OpportunitiesResponse {
   // Metadata for the Phase 2 editors (same for all records).
   fieldDefs?: EditableFieldDef[]; // OLTL opportunity custom-field definitions
   stages?: { id: string; name: string }[]; // union of stages across pipelines (deduped by id)
-  users?: { id: string; name: string }[]; // location users (owner picker)
+  // Location users for the owner/follower pickers. `divisions` labels each user
+  // (empty = none mapped -> the picker shows "—", never hides them).
+  users?: { id: string; name: string; divisions?: string[] }[];
   // Multi-pipeline (v2).
   pipelines?: { id: string; name: string }[]; // the selected pipelines, in order
   stagesByPipeline?: Record<string, { id: string; name: string }[]>; // pipelineId -> its stages
```

---

