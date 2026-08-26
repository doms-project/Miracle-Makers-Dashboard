# v2 Build Report — Task 6: the Move action (+ follower id validation)

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26  •  Build: clean.

Commits:
- 745e20c feat: Move action (simple move + transfer, incl. G1 follower clearing)
- 054fb7d fix: validate follower ids against the location's users

Contains the **complete unified diff for every changed line**.

## Ordering — I agree with you, and it's built your way

Your objection is right and my note-first reasoning was wrong: a note saying "transferred to Bill" on a record that never transferred is misleading in exactly the situation that matters. **The owner change now goes first**, atomically with the stamps:

```
0. PREFLIGHT (no writes)  destination resolves · HAS TRANSFERRED IN · new owner is a real user
1. PUT #1                 assignedTo + Transferred From/Date (+ Transfer Reason)   ← atomic
2. clear followers        all except the new owner (G1)
3. note                   written only now, when the transfer is real
4. PUT #2                 pipelineId + stage = TRANSFERRED IN   ← must follow the owner change
```
If step 1 fails, **nothing has been written** and the record is untouched. Partial failure returns 500 listing the completed steps — never a silent half-move.

## Your decisions, as built

| # | Decision | Built |
|---|---|---|
| 1 | Follower clearing = **A** | all followers removed except the new owner |
| 2 | Stage forced to TRANSFERRED IN, picker locked on Path B | yes + **preflight verifies the stage exists before any write** |
| 3 | **Drop the tag** | no tag written; no pipeline→division map needed |
| 4 | simple = `canEditRecord`, transfer = owner/admin | yes, **one check at entry** |
| 5 | `ssoConfigured()` not special-cased | confirmed; deploy checklist below |

## Preflight verification I ran against your `pipelines.json` (decision 2)

```
OK  ODP Enrollment        a14NtTi18ACxs99bHPmL  TRANSFERRED IN pos=0
OK  ODP Transfer          PIs1iWVk0HqHZFNtmoTn  TRANSFERRED IN pos=0
OK  OLTL Enrollment       KGjdCMG4F8xILk0ineB9  TRANSFERRED IN pos=0
OK  OLTL Transfer         74Pt3XX4hgBIqD10mW4G  TRANSFERRED IN pos=0
OK  Private Pay Clients   BJBWdRim6SOgjoMelVSZ  TRANSFERRED IN pos=0

NO  Private Pay Caregiver Applicants  EXVMveGzgDy9qf4wQR2H  (not in PIPELINE_IDS)
```
All five configured pipelines pass. The recruiting pipeline **does not have the stage** — so if it is ever added to `PIPELINE_IDS`, the preflight refuses the transfer **before** the owner moves, which is exactly the failure you wanted prevented.

## One thing I found that changes an assumption

`Transferred From` is **SINGLE_OPTIONS**, and its option list is:
```
['OLTL Enrollment', 'OLTL Transfer', 'ODP Enrollments', 'ODP Transfer', 'Private Pay Clients']
```
Note **"ODP Enrollments" (plural)** vs the pipeline's actual name **"ODP Enrollment" (singular)**. Sending the pipeline name raw would write an invalid option for that one pipeline. The value is therefore matched against the field's **real options** with singular/plural tolerance, still resolved **by name, never by hardcoded id**.

I also found a **`Transfer Reason`** field (LARGE_TEXT) in the same transfer folder, so the reason is written there too — opportunity-scoped and atomic with the owner change, which is stronger than the note alone. Veto it if you'd rather keep the reason only in the note.

## Deploy checklist (hard requirement)

🔴 **`GHL_SSO_SECRET` must be set in production.** Without it `ssoConfigured()` is false and **every route is open**, including import, resources upload, followers and move.

---

## fix: validate follower ids against the location's users

```diff
diff --git a/app/api/opportunities/[id]/followers/route.ts b/app/api/opportunities/[id]/followers/route.ts
index d6f9d84..308f483 100644
--- a/app/api/opportunities/[id]/followers/route.ts
+++ b/app/api/opportunities/[id]/followers/route.ts
@@ -3,6 +3,7 @@ import {
   getOpportunityById,
   addOpportunityFollowers,
   removeOpportunityFollowers,
+  getLocationUserIds,
   GhlError,
 } from "@/lib/ghl";
 import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
@@ -66,6 +67,24 @@ export async function PATCH(
         { status: 400 },
       );
 
+    // Validate ADD ids against the location's real users. Without this an
+    // arbitrary string would be stored and later render as "Former user",
+    // indistinguishable from a genuinely deleted account. (REMOVE is not
+    // validated — a stale/deleted id must always be removable.)
+    if (add.length) {
+      const valid = await getLocationUserIds();
+      const unknown = add.filter((u) => !valid.has(u));
+      if (unknown.length)
+        return NextResponse.json(
+          {
+            error: "Unknown user id(s).",
+            detail: `Not users of this location: ${unknown.join(", ")}`,
+            status: 400,
+          } as ApiError,
+          { status: 400 },
+        );
+    }
+
     // Remove first, then add (so a same-tick add wins if both are sent).
     if (remove.length) await removeOpportunityFollowers(id, remove);
     if (add.length) await addOpportunityFollowers(id, add);
diff --git a/lib/ghl.ts b/lib/ghl.ts
index a026eb9..d003011 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -340,6 +340,13 @@ async function getFieldMap(): Promise<Map<string, string>> {
   return map;
 }
 
+// Exported so write routes can VALIDATE user ids (e.g. followers) against the
+// location's real users before writing — an arbitrary string would otherwise be
+// stored and render as "Former user", indistinguishable from a deleted account.
+export async function getLocationUserIds(): Promise<Set<string>> {
+  return new Set((await getUserMap()).keys());
+}
+
 async function getUserMap(): Promise<Map<string, string>> {
   if (cache.userMap) return cache.userMap;
   const { locationId } = requireEnv();
```

---

## feat: Move action (simple move + transfer, incl. G1 follower clearing)

```diff
diff --git a/app/api/opportunities/[id]/move/route.ts b/app/api/opportunities/[id]/move/route.ts
new file mode 100644
index 0000000..9f970c7
--- /dev/null
+++ b/app/api/opportunities/[id]/move/route.ts
@@ -0,0 +1,129 @@
+import { NextResponse } from "next/server";
+import { getOpportunityById, moveOpportunity, GhlError } from "@/lib/ghl";
+import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
+import { canEditRecord, canManageFollowers } from "@/lib/visibility";
+import type { ApiError } from "@/lib/types";
+
+export const dynamic = "force-dynamic";
+export const runtime = "nodejs";
+export const maxDuration = 60;
+
+// POST { ssoKey?, toPipelineId, toStageId?, newOwnerId?, reason?,
+//        addSenderAsFollower? }
+//
+// ONE permission check at entry, then moveOpportunity() drives every sub-write
+// directly in lib. It deliberately does NOT go through the per-record PATCH /
+// followers routes: those re-evaluate permission against MUTATED state (after
+// the owner changes, the person performing the move would 403 on their own
+// operation), and PATCH strips the read-only Transferred From/Date fields that
+// a transfer must stamp.
+//
+// Entry gate:
+//   simple move (owner unchanged) -> canEditRecord (own/follow/admin/home-unassigned)
+//   transfer    (owner changed)   -> owner or admin only; a follower must not be
+//                                    able to hand someone else's case away.
+export async function POST(
+  request: Request,
+  ctx: { params: Promise<{ id: string }> },
+) {
+  try {
+    const { id } = await ctx.params;
+    const body = (await request.json().catch(() => ({}))) as {
+      ssoKey?: string;
+      toPipelineId?: string;
+      toStageId?: string;
+      newOwnerId?: string | null;
+      reason?: string;
+      addSenderAsFollower?: boolean;
+    };
+    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");
+
+    let session: { userId: string; role?: string; type?: string } | null = null;
+    const enforce = ssoConfigured();
+    if (enforce) {
+      if (!blob)
+        return NextResponse.json(
+          { error: "Sign-in required.", status: 401 } as ApiError,
+          { status: 401 },
+        );
+      const s = decryptSso(blob);
+      session = { userId: s.userId, role: s.role, type: s.type };
+    }
+
+    if (!body.toPipelineId)
+      return NextResponse.json(
+        { error: "Pick a destination pipeline." } as ApiError,
+        { status: 400 },
+      );
+
+    const target = await getOpportunityById(id);
+    if (!target)
+      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
+        status: 404,
+      });
+
+    const isTransfer =
+      typeof body.newOwnerId === "string" &&
+      (body.newOwnerId || "") !== (target.ownerId || "");
+
+    if (enforce && session) {
+      const allowed = isTransfer
+        ? canManageFollowers(target, session) // owner or admin
+        : canEditRecord(target, session);
+      if (!allowed)
+        return NextResponse.json(
+          {
+            error: "Not permitted.",
+            detail: isTransfer
+              ? "Only the record owner or an admin can transfer a record to a new owner."
+              : "You can only move records you own or follow.",
+            status: 403,
+          } as ApiError,
+          { status: 403 },
+        );
+    }
+
+    const result = await moveOpportunity({
+      oppId: id,
+      toPipelineId: body.toPipelineId,
+      toStageId: body.toStageId,
+      newOwnerId: body.newOwnerId ?? undefined,
+      reason: body.reason,
+      actorUserId: session?.userId || "",
+      addSenderAsFollower: !!body.addSenderAsFollower,
+    });
+
+    // A partial move is reported as 500 WITH the completed steps, so the caller
+    // can finish manually instead of believing the move succeeded.
+    if (result.failedStep)
+      return NextResponse.json(
+        {
+          error: `Move stopped at "${result.failedStep}".`,
+          detail: `Completed: ${result.steps.join(" → ") || "nothing"}. ${result.error ?? ""}`,
+          status: 500,
+        } as ApiError,
+        { status: 500 },
+      );
+
+    const record = await getOpportunityById(id);
+    return NextResponse.json(
+      { ok: true, ...result, record },
+      { headers: { "Cache-Control": "no-store" } },
+    );
+  } catch (e) {
+    if (e instanceof SsoError)
+      return NextResponse.json(
+        { error: e.message, status: e.status } as ApiError,
+        { status: e.status },
+      );
+    if (e instanceof GhlError)
+      return NextResponse.json(
+        { error: e.message, detail: e.detail } as ApiError,
+        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
+      );
+    return NextResponse.json(
+      { error: "Move failed.", detail: String(e) } as ApiError,
+      { status: 500 },
+    );
+  }
+}
diff --git a/app/globals.css b/app/globals.css
index 43e4fba..196f6fd 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -380,3 +380,16 @@ button.rescard{width:100%;text-align:left;font:inherit;cursor:pointer;background
 .folchip .folx{width:18px;height:18px;border-radius:50%;font-size:14px;line-height:1;color:var(--plum);background:transparent;}
 .folchip .folx:hover{background:#fff;}
 .folchip .folx:disabled{opacity:.5;cursor:progress;}
+
+/* ── Task 6: Move action ──────────────────────────────────────── */
+.panelactions{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px;}
+.movebtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--plum-line);background:var(--bg);color:var(--plum);border-radius:8px;padding:9px 16px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s;}
+.movebtn:hover{background:var(--plum-soft);border-color:var(--plum);}
+.movebox{background:var(--bg);border-radius:14px;width:min(520px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.4);}
+.movebody{padding:16px 18px 20px;overflow:auto;display:flex;flex-direction:column;gap:14px;}
+.movebody .irow{gap:4px;}
+.movebody .irow label{margin-top:6px;}
+.movebody .irow select,.movebody .irow input{width:100%;}
+.movewarn{font-size:12px;line-height:1.55;color:var(--blk);background:var(--blk-soft);border:1px solid #f3c9c2;border-radius:9px;padding:11px 13px;}
+.movetoggle{display:flex;align-items:center;gap:8px;margin-top:9px;font-size:11.5px;font-weight:600;color:var(--ink-2);cursor:pointer;}
+.movetoggle input{margin:0;accent-color:var(--plum);}
diff --git a/app/page.tsx b/app/page.tsx
index e48da64..3ddafa2 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -26,6 +26,7 @@ import ImportWizard from "@/components/ImportWizard";
 import CaregiversSection from "@/components/CaregiversSection";
 import EmailComposer from "@/components/EmailComposer";
 import { groupFieldsForPipeline } from "@/lib/fieldFolders";
+import MoveDialog from "@/components/MoveDialog";
 
 const LOCATION_ID =
   process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
@@ -474,6 +475,12 @@ export default function Dashboard() {
   >([]);
   const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
   const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
+  // Multi-pipeline metadata (v2) — drives the Move dialog.
+  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
+  const [stagesByPipeline, setStagesByPipeline] = useState<
+    Record<string, { id: string; name: string }[]>
+  >({});
+  const [moveOpen, setMoveOpen] = useState(false);
 
   const [stage, setStage] = useState<string>("all");
   const [office, setOffice] = useState<string>("all"); // office filter (client req)
@@ -542,6 +549,8 @@ export default function Dashboard() {
       if (body.fieldDefs) setFieldDefs(body.fieldDefs);
       if (body.stages) setPipelineStages(body.stages);
       if (body.users) setUsers(body.users);
+      if (body.pipelines) setPipelines(body.pipelines);
+      if (body.stagesByPipeline) setStagesByPipeline(body.stagesByPipeline);
     } catch (e) {
       setError({
         error: "Could not reach the dashboard API.",
@@ -569,9 +578,10 @@ export default function Dashboard() {
     return () => document.removeEventListener("keydown", onKey);
   }, []);
 
-  // Close the email composer whenever the selected record changes/closes.
+  // Close the email composer / Move dialog whenever the record changes/closes.
   useEffect(() => {
     setEmailOpen(false);
+    setMoveOpen(false);
   }, [selId]);
 
   // Fetch the folder-scoped resources fresh (signed URLs are TTL'd).
@@ -1739,6 +1749,25 @@ export default function Dashboard() {
         )}
       </div>
 
+      {/* Move dialog (Task 6) */}
+      {selected && moveOpen ? (
+        <MoveDialog
+          key={selected.id}
+          record={selected}
+          pipelines={pipelines}
+          stagesByPipeline={stagesByPipeline}
+          users={users}
+          ssoBlob={sso.status === "ready" ? sso.blob : null}
+          onClose={() => setMoveOpen(false)}
+          onMoved={(rec) => {
+            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
+            // A transfer can remove the viewer's access — reload so the list
+            // reflects what they can still see.
+            load();
+          }}
+        />
+      ) : null}
+
       {/* email composer (Task 5) */}
       {selected && emailOpen ? (
         <EmailComposer
@@ -1828,13 +1857,22 @@ export default function Dashboard() {
               </div>
 
               {canEdit(selected) ? (
-                <button
-                  type="button"
-                  className="emailbtn"
-                  onClick={() => setEmailOpen(true)}
-                >
-                  ✉ Send Email
-                </button>
+                <div className="panelactions">
+                  <button
+                    type="button"
+                    className="emailbtn"
+                    onClick={() => setEmailOpen(true)}
+                  >
+                    ✉ Send Email
+                  </button>
+                  <button
+                    type="button"
+                    className="movebtn"
+                    onClick={() => setMoveOpen(true)}
+                  >
+                    ⇄ Move this case
+                  </button>
+                </div>
               ) : null}
 
               {/* 1 — Status & Workflow (most-used, top) */}
diff --git a/components/MoveDialog.tsx b/components/MoveDialog.tsx
new file mode 100644
index 0000000..0d77908
--- /dev/null
+++ b/components/MoveDialog.tsx
@@ -0,0 +1,207 @@
+"use client";
+
+import { useMemo, useState } from "react";
+import type { OpportunityRecord } from "@/lib/types";
+
+// Task 6 — the Move action. One control; the system classifies:
+//   owner UNCHANGED -> simple move (pipeline + stage). No warning, no stamps.
+//   owner CHANGED   -> transfer: stage locks to TRANSFERRED IN, followers are
+//                      cleared, Transferred From/Date stamped, note written,
+//                      and the current owner loses access (Option B).
+export default function MoveDialog({
+  record,
+  pipelines,
+  stagesByPipeline,
+  users,
+  ssoBlob,
+  onClose,
+  onMoved,
+}: {
+  record: OpportunityRecord;
+  pipelines: { id: string; name: string }[];
+  stagesByPipeline: Record<string, { id: string; name: string }[]>;
+  users: { id: string; name: string }[];
+  ssoBlob: string | null;
+  onClose: () => void;
+  onMoved: (rec: OpportunityRecord) => void;
+}) {
+  const [toPipelineId, setToPipelineId] = useState(record.pipelineId);
+  const [toStageId, setToStageId] = useState(record.stageId);
+  // Owner is PREFILLED with the current owner — changing it is what makes this
+  // a transfer.
+  const [newOwnerId, setNewOwnerId] = useState(record.ownerId);
+  const [reason, setReason] = useState("");
+  const [addSender, setAddSender] = useState(false);
+  const [busy, setBusy] = useState(false);
+  const [err, setErr] = useState<string | null>(null);
+
+  const isTransfer = (newOwnerId || "") !== (record.ownerId || "");
+  const destStages = stagesByPipeline[toPipelineId] || [];
+  const transferredIn = useMemo(
+    () =>
+      destStages.find((s) => s.name.trim().toUpperCase() === "TRANSFERRED IN"),
+    [destStages],
+  );
+  const destName =
+    pipelines.find((p) => p.id === toPipelineId)?.name || "—";
+  const ownerName =
+    users.find((u) => u.id === newOwnerId)?.name || "Unassigned";
+  const followersCleared = record.followerIds.filter(
+    (f) => f !== newOwnerId,
+  ).length;
+
+  const submit = async () => {
+    setBusy(true);
+    setErr(null);
+    try {
+      const res = await fetch(`/api/opportunities/${record.id}/move`, {
+        method: "POST",
+        headers: {
+          "Content-Type": "application/json",
+          ...(ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
+        },
+        body: JSON.stringify({
+          ssoKey: ssoBlob ?? undefined,
+          toPipelineId,
+          // Stage is chosen only on the simple path; a transfer always lands in
+          // TRANSFERRED IN (the server resolves and enforces it).
+          toStageId: isTransfer ? undefined : toStageId,
+          newOwnerId: isTransfer ? newOwnerId : undefined,
+          reason: reason.trim() || undefined,
+          addSenderAsFollower: isTransfer ? addSender : undefined,
+        }),
+      });
+      const j = await res.json().catch(() => ({}));
+      if (!res.ok || !j.ok)
+        throw new Error(j.detail || j.error || `HTTP ${res.status}`);
+      if (j.record) onMoved(j.record as OpportunityRecord);
+      onClose();
+    } catch (e) {
+      setErr(e instanceof Error ? e.message : String(e));
+    } finally {
+      setBusy(false);
+    }
+  };
+
+  const unchanged =
+    toPipelineId === record.pipelineId &&
+    (isTransfer || toStageId === record.stageId) &&
+    !isTransfer;
+
+  return (
+    <div className="previewmodal" onClick={onClose}>
+      <div className="movebox" onClick={(e) => e.stopPropagation()}>
+        <div className="previewhead">
+          <span className="previewname">Move this case</span>
+          <button className="x" type="button" onClick={onClose} aria-label="Close">
+            ×
+          </button>
+        </div>
+
+        <div className="movebody">
+          <div className="irow" style={{ flexDirection: "column", alignItems: "stretch" }}>
+            <label>Pipeline</label>
+            <select
+              value={toPipelineId}
+              onChange={(e) => {
+                setToPipelineId(e.target.value);
+                const first = (stagesByPipeline[e.target.value] || [])[0];
+                setToStageId(first?.id || "");
+              }}
+            >
+              {pipelines.map((p) => (
+                <option key={p.id} value={p.id}>
+                  {p.name}
+                </option>
+              ))}
+            </select>
+
+            <label>Stage</label>
+            {isTransfer ? (
+              <div className="v ro">
+                {transferredIn?.name || "TRANSFERRED IN"}{" "}
+                <span className="readonly-note">set automatically on transfer</span>
+              </div>
+            ) : (
+              <select
+                value={toStageId}
+                onChange={(e) => setToStageId(e.target.value)}
+              >
+                {destStages.map((s) => (
+                  <option key={s.id} value={s.id}>
+                    {s.name}
+                  </option>
+                ))}
+              </select>
+            )}
+
+            <label>Owner</label>
+            <select
+              value={newOwnerId}
+              onChange={(e) => setNewOwnerId(e.target.value)}
+            >
+              <option value="">Unassigned</option>
+              {users.map((u) => (
+                <option key={u.id} value={u.id}>
+                  {u.name}
+                </option>
+              ))}
+            </select>
+
+            <label>Reason</label>
+            <input
+              value={reason}
+              onChange={(e) => setReason(e.target.value)}
+              placeholder={isTransfer ? "Why is this being handed over?" : "Optional"}
+            />
+          </div>
+
+          {/* Warn ONLY when access is actually lost (owner changed). */}
+          {isTransfer ? (
+            <div className="movewarn">
+              <b>This is a transfer.</b> Owner becomes <b>{ownerName}</b>, the case
+              moves to <b>{destName} · TRANSFERRED IN</b>, and{" "}
+              <b>you lose access to it</b>.
+              {followersCleared > 0 ? (
+                <>
+                  {" "}
+                  {followersCleared} follower(s) will be removed so it leaves the
+                  originating division.
+                </>
+              ) : null}
+              <label className="movetoggle">
+                <input
+                  type="checkbox"
+                  checked={addSender}
+                  onChange={(e) => setAddSender(e.target.checked)}
+                />
+                Keep the current owner as a follower (retains access)
+              </label>
+            </div>
+          ) : (
+            <div className="imeta">
+              Simple move — owner unchanged, so nothing is stamped and no access
+              changes.
+            </div>
+          )}
+
+          {err ? <div className="savemsg err">✗ {err}</div> : null}
+
+          <div className="inav">
+            <button type="button" className="ighost" onClick={onClose} disabled={busy}>
+              Cancel
+            </button>
+            <button
+              type="button"
+              className="ibtn"
+              disabled={busy || unchanged}
+              onClick={submit}
+            >
+              {busy ? "Moving…" : isTransfer ? "Transfer case" : "Move"}
+            </button>
+          </div>
+        </div>
+      </div>
+    </div>
+  );
+}
diff --git a/lib/ghl.ts b/lib/ghl.ts
index d003011..c6bb3cc 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -979,6 +979,236 @@ export async function createOpportunity(o: {
   return res.opportunity?.id || res.id || "";
 }
 
+// ---------------------------------------------------------------------------
+// The Move action (Task 6).
+//
+// One control; the system classifies. Two paths:
+//
+//   owner UNCHANGED -> simple move: change pipelineId + stage. Nothing else.
+//   owner CHANGED   -> transfer. ORDERING IS DELIBERATE:
+//     0. PREFLIGHT (no writes): destination pipeline resolves, it HAS a
+//        "TRANSFERRED IN" stage, and the new owner is a real location user.
+//     1. PUT #1 — assignedTo + Transferred From/Date (+ Transfer Reason) in ONE
+//        atomic write. The owner change is the step that can fail for permission
+//        reasons, so it goes FIRST: if it fails, NOTHING has been written and the
+//        record is untouched. (Stamping first would leave a record marked
+//        "transferred" while still owned by the old rep.)
+//     2. Clear followers — all except the new owner (G1: a transferred lead must
+//        leave the old division entirely).
+//     3. Note with the reason — written AFTER the owner actually moved, so a note
+//        can never claim a transfer that did not happen.
+//     4. PUT #2 — pipelineId + stage = TRANSFERRED IN. MUST come after the owner
+//        change: GHL blocks revoking pipeline access from a user who still owns
+//        opportunities in that pipeline.
+//
+// No tag is written: GHL tags are contact-scoped, so a transfer tag on a contact
+// with several opportunities cannot identify which record moved. The
+// opportunity-scoped Transferred From / Transferred Date / note carry the history.
+//
+// There are no transactions — on a step failure we STOP and report exactly which
+// steps completed, rather than silently half-moving.
+// ---------------------------------------------------------------------------
+
+export interface MoveResult {
+  transferred: boolean; // false = simple move
+  steps: string[]; // completed steps, in order
+  failedStep?: string; // set when we stopped early
+  error?: string;
+}
+
+const normOpt = (s: string): string =>
+  s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
+
+// Find a field definition by (normalized) name — never by hardcoded id.
+function findDefByName(
+  defs: FieldDefinition[],
+  name: string,
+): FieldDefinition | undefined {
+  const target = norm(name);
+  return defs.find((d) => norm(d.name || "") === target);
+}
+
+// Match a pipeline NAME to one of a SINGLE_OPTIONS field's option values.
+// Tolerates singular/plural drift ("ODP Enrollment" vs the option "ODP
+// Enrollments") without hardcoding either spelling.
+function matchOption(options: string[], value: string): string | null {
+  const v = normOpt(value);
+  for (const o of options) if (normOpt(o) === v) return o;
+  return null;
+}
+
+export async function moveOpportunity(args: {
+  oppId: string;
+  toPipelineId: string;
+  toStageId?: string; // honoured on the simple path only
+  newOwnerId?: string | null; // undefined/equal to current => simple move
+  reason?: string;
+  actorUserId: string; // note authorship (server-derived)
+  addSenderAsFollower?: boolean; // Option A switch; default OFF (Option B)
+}): Promise<MoveResult> {
+  const steps: string[] = [];
+  const current = await getOpportunityById(args.oppId);
+  if (!current)
+    throw new GhlError("Opportunity not found.", 404, `id ${args.oppId}`);
+
+  const isTransfer =
+    typeof args.newOwnerId === "string" &&
+    (args.newOwnerId || "") !== (current.ownerId || "");
+
+  // ---- PREFLIGHT (no writes) ----
+  const pipelines = await getSelectedPipelines();
+  const dest = pipelines.find((p) => p.id === args.toPipelineId);
+  if (!dest)
+    throw new GhlError(
+      "Destination pipeline is not available.",
+      400,
+      `${args.toPipelineId} is not in PIPELINE_IDS.`,
+    );
+
+  let destStageId = args.toStageId || "";
+  if (isTransfer) {
+    // Transfers always land in TRANSFERRED IN — verify it EXISTS before any
+    // write, otherwise we would fail at the final step with the owner already moved.
+    const ti = (dest.stages || []).find(
+      (s) => (s.name || "").trim().toUpperCase() === "TRANSFERRED IN",
+    );
+    if (!ti)
+      throw new GhlError(
+        `"${dest.name}" has no TRANSFERRED IN stage.`,
+        400,
+        "Add a TRANSFERRED IN stage to that pipeline before transferring into it.",
+      );
+    destStageId = ti.id;
+    const validUsers = await getLocationUserIds();
+    if (!args.newOwnerId || !validUsers.has(args.newOwnerId))
+      throw new GhlError(
+        "New owner is not a user of this location.",
+        400,
+        String(args.newOwnerId ?? ""),
+      );
+  } else {
+    if (!destStageId) {
+      const first = (dest.stages || [])[0];
+      if (!first)
+        throw new GhlError(`"${dest.name}" has no stages.`, 400);
+      destStageId = first.id;
+    } else if (!(dest.stages || []).some((s) => s.id === destStageId)) {
+      throw new GhlError(
+        "Chosen stage does not belong to the destination pipeline.",
+        400,
+        destStageId,
+      );
+    }
+  }
+  steps.push("preflight");
+
+  // ---- SIMPLE MOVE ----
+  if (!isTransfer) {
+    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
+      pipelineId: args.toPipelineId,
+      pipelineStageId: destStageId,
+    });
+    steps.push("moved pipeline+stage");
+    return { transferred: false, steps };
+  }
+
+  // ---- TRANSFER ----
+  const defs = await getFieldDefinitions();
+  const fromDef = findDefByName(defs, "Transferred From");
+  const dateDef = findDefByName(defs, "Transferred Date");
+  const reasonDef = findDefByName(defs, "Transfer Reason");
+  const sourceName =
+    pipelines.find((p) => p.id === current.pipelineId)?.name || "";
+
+  const customFields: { id: string; value: unknown }[] = [];
+  if (fromDef && sourceName) {
+    // SINGLE_OPTIONS — must send an EXISTING option value.
+    const opts = optionStrings(fromDef);
+    const matched = opts.length ? matchOption(opts, sourceName) : sourceName;
+    if (matched) customFields.push({ id: fromDef.id, value: matched });
+  }
+  if (dateDef)
+    customFields.push({
+      id: dateDef.id,
+      value: new Date().toISOString().slice(0, 10),
+    });
+  if (reasonDef && args.reason?.trim())
+    customFields.push({ id: reasonDef.id, value: args.reason.trim() });
+
+  // 1. Owner + stamps in ONE atomic write (fails => nothing written).
+  try {
+    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
+      assignedTo: args.newOwnerId,
+      ...(customFields.length ? { customFields } : {}),
+    });
+    steps.push("owner changed + transfer stamps");
+  } catch (e) {
+    return {
+      transferred: false,
+      steps,
+      failedStep: "owner change",
+      error: e instanceof Error ? e.message : String(e),
+    };
+  }
+
+  // 2. Clear followers — all except the new owner (G1).
+  try {
+    const toRemove = current.followerIds.filter((f) => f !== args.newOwnerId);
+    if (toRemove.length) {
+      await removeOpportunityFollowers(args.oppId, toRemove);
+      steps.push(`cleared ${toRemove.length} follower(s)`);
+    }
+    if (args.addSenderAsFollower && current.ownerId) {
+      await addOpportunityFollowers(args.oppId, [current.ownerId]);
+      steps.push("kept sender as follower");
+    }
+  } catch (e) {
+    return {
+      transferred: true,
+      steps,
+      failedStep: "clear followers",
+      error: e instanceof Error ? e.message : String(e),
+    };
+  }
+
+  // 3. Note — only now, when the transfer is real.
+  try {
+    if (current.contactId) {
+      const toName = (await getUserMap()).get(args.newOwnerId!) || args.newOwnerId!;
+      const body =
+        `Moved from ${sourceName || "—"} to ${dest.name}. New owner: ${toName}.` +
+        (args.reason?.trim() ? ` Reason: ${args.reason.trim()}` : "");
+      await addOpportunityNote(current.contactId, args.oppId, body, args.actorUserId);
+      steps.push("note written");
+    }
+  } catch (e) {
+    return {
+      transferred: true,
+      steps,
+      failedStep: "note",
+      error: e instanceof Error ? e.message : String(e),
+    };
+  }
+
+  // 4. Pipeline + TRANSFERRED IN — after the owner change (GHL constraint).
+  try {
+    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
+      pipelineId: args.toPipelineId,
+      pipelineStageId: destStageId,
+    });
+    steps.push("moved pipeline+stage (TRANSFERRED IN)");
+  } catch (e) {
+    return {
+      transferred: true,
+      steps,
+      failedStep: "move pipeline",
+      error: e instanceof Error ? e.message : String(e),
+    };
+  }
+
+  return { transferred: true, steps };
+}
+
 // ---------------------------------------------------------------------------
 // Followers (Task 5) — dedicated add/remove endpoints (no full-opportunity PUT).
 // GHL sends NO native notification to a newly added follower. Shapes follow
```

---

