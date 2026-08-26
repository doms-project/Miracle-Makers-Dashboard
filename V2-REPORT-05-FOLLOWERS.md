# v2 Build Report — Fail-loud follow-ups + Task 5 (followers)

**Branch:** `v2-multi-pipeline`  •  **Account:** `anzcWt3S0tzpu2fEaS8X`  •  **Date:** 2026-08-26  •  Build: clean.

Commits in this batch:
- 8d4db7e feat: follower add/remove (owner/admin, dedicated endpoints)
- 0cca4af fix: fail loud on missing account ids + pipeline-config mismatch

Contains the **complete unified diff for every changed line**.

## Your two follow-ups

**1. `|| ""` now fails loud.** `requireEnv({ resourcesFolder?, caregiverAssociation? })` throws a 500 GhlError at the point of use when the id is unset — same behaviour as `locationId`. Wired into `listResources`, `uploadResource`, `listCaregiverRelations`, `createCaregiverRelation`. Unrelated calls omit the flag and are unaffected. No more silent upload-to-root / empty-caregiver-list. The standalone association const is gone (single source = requireEnv).

**2. Config mismatch no longer silent.** `checkPipelineConfig()` (memoized, from `getSelectedPipelines`) logs loudly when `PIPELINE_IDS` is unset (running on `DEFAULT_PIPELINE_IDS`) and when any selected pipeline lacks a `PIPELINE_FOLDERS` entry (fields would fall into "Other"). One check, no refactor.

**G1 confirmed for Task 6** using this task's follower-write mechanism — that's where "old owner loses access" is defined and followers become writable.

## Task 5 — followers (owner/admin, dedicated endpoints)

- GHL dedicated **POST/DELETE `/opportunities/{id}/followers`** (no full-opp PUT). DELETE-with-body via manual fetch.
- **Owner or admin only** (`canManageFollowers`) — a follower can't re-share onward.
- Route recomputes the **final follower id list** from the known-current set, so it never depends on GHL's response shape.
- Panel: removable chips + add dropdown for owner/admin (excludes the owner + current followers); read-only otherwise; deleted users show **"Former user"**.
- ⚠️ GHL sends **no native notification** to a new follower. Requires the GHL setting *"Allow different owners for contacts and its opportunities"* (both sync sub-settings OFF) — **your action in GHL before this works live**.
- Step-0 probe: `scripts/followers-probe.mjs` (confirms add/remove shapes + the response's follower field name).

---

## fix: fail loud on missing account ids + pipeline-config mismatch

```diff
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 6ecb769..ca6b1f1 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -4,6 +4,7 @@ import type {
   ResourceFile,
 } from "./types";
 import { isFieldEditable } from "./editable";
+import { PIPELINE_FOLDERS } from "./fieldFolders";
 
 // Account-specific — MUST come from env (re-derive per account with
 // scripts/rederive-ids-probe.mjs). No stale fallback: an unset value fails
@@ -32,12 +33,28 @@ export class GhlError extends Error {
   }
 }
 
-function requireEnv(): { token: string; locationId: string } {
+// `opts` lets a feature-specific caller additionally require an account-scoped
+// id (resources folder / caregiver association) so it throws AT THE POINT OF USE
+// — same fail-loud behaviour as locationId — instead of silently defaulting to
+// "" (which would upload to the media root / return an empty caregiver list).
+// Unrelated calls (search, pipelines, contacts) omit opts and are unaffected.
+function requireEnv(opts?: {
+  resourcesFolder?: boolean;
+  caregiverAssociation?: boolean;
+}): {
+  token: string;
+  locationId: string;
+  resourcesFolderId: string;
+  caregiverAssociationId: string;
+} {
   // Trim to defend against a trailing space / newline pasted into the env var,
   // which GHL rejects as "invalid jwt". Also strip an accidental "Bearer "
   // prefix baked into the value so the scheme is controlled in one place below.
   const token = process.env.GHL_PIT?.trim().replace(/^Bearer\s+/i, "");
   const locationId = process.env.GHL_LOCATION_ID?.trim();
+  const resourcesFolderId = process.env.RESOURCES_FOLDER_ID?.trim() || "";
+  const caregiverAssociationId =
+    process.env.CAREGIVER_ASSOCIATION_ID?.trim() || "";
   if (!token) {
     throw new GhlError(
       "Server is not configured: GHL_PIT is missing.",
@@ -52,7 +69,21 @@ function requireEnv(): { token: string; locationId: string } {
       "Set the GHL_LOCATION_ID environment variable.",
     );
   }
-  return { token, locationId };
+  if (opts?.resourcesFolder && !resourcesFolderId) {
+    throw new GhlError(
+      "Server is not configured: RESOURCES_FOLDER_ID is missing.",
+      500,
+      "Re-derive it for this account (scripts/rederive-ids-probe.mjs) and set RESOURCES_FOLDER_ID.",
+    );
+  }
+  if (opts?.caregiverAssociation && !caregiverAssociationId) {
+    throw new GhlError(
+      "Server is not configured: CAREGIVER_ASSOCIATION_ID is missing.",
+      500,
+      "Re-derive/create it for this account and set CAREGIVER_ASSOCIATION_ID.",
+    );
+  }
+  return { token, locationId, resourcesFolderId, caregiverAssociationId };
 }
 
 // The effective auth scheme for the Authorization header. GHL's v2
@@ -245,9 +276,33 @@ export function pipelineIds(): string[] {
   return ids.length ? ids : DEFAULT_PIPELINE_IDS;
 }
 
+// Loud config check (memoized) — surfaces the two silent failure modes:
+//   1. running on baked-in DEFAULT_PIPELINE_IDS because PIPELINE_IDS is unset;
+//   2. a selected pipeline with no PIPELINE_FOLDERS mapping (its fields would
+//      silently dump into "Other fields", which reads as working).
+let _configChecked = false;
+function checkPipelineConfig(): void {
+  if (_configChecked) return;
+  _configChecked = true;
+  if (!(process.env.PIPELINE_IDS || "").trim()) {
+    // eslint-disable-next-line no-console
+    console.warn(
+      "[config] PIPELINE_IDS is not set — using baked-in DEFAULT_PIPELINE_IDS. Set PIPELINE_IDS to control scope for this account.",
+    );
+  }
+  const unmapped = pipelineIds().filter((id) => !PIPELINE_FOLDERS[id]);
+  if (unmapped.length) {
+    // eslint-disable-next-line no-console
+    console.warn(
+      `[config] pipeline(s) with no PIPELINE_FOLDERS mapping (fields will fall into "Other"): ${unmapped.join(", ")}. Add them to lib/fieldFolders.ts.`,
+    );
+  }
+}
+
 // Resolve the configured pipeline IDs to full Pipeline objects, in configured
 // order. Unknown IDs are skipped (logged via the error only if NONE match).
 export async function getSelectedPipelines(): Promise<Pipeline[]> {
+  checkPipelineConfig();
   const pipelines = await getPipelines();
   const byId = new Map(pipelines.map((p) => [p.id, p]));
   const selected: Pipeline[] = [];
@@ -817,8 +872,8 @@ interface RawMedia {
 }
 
 export async function listResources(): Promise<ResourceFile[]> {
-  const { locationId } = requireEnv();
-  const folderId = RESOURCES_FOLDER_ID;
+  const { locationId, resourcesFolderId } = requireEnv({ resourcesFolder: true });
+  const folderId = resourcesFolderId;
   const limit = 100;
   const all: RawMedia[] = [];
   for (let page = 0, offset = 0; page < 50; page++, offset += limit) {
@@ -930,7 +985,7 @@ export async function uploadResource(file: {
   filename: string;
   contentType: string;
 }): Promise<{ id: string; url: string; name: string }> {
-  const { locationId } = requireEnv();
+  const { resourcesFolderId } = requireEnv({ resourcesFolder: true });
   const form = new FormData();
   const blob = new Blob([file.buffer], {
     type: file.contentType || "application/octet-stream",
@@ -939,7 +994,7 @@ export async function uploadResource(file: {
   form.append("file", blob, file.filename);
   form.append("hosted", "false");
   form.append("name", file.filename);
-  form.append("parentId", RESOURCES_FOLDER_ID);
+  form.append("parentId", resourcesFolderId);
 
   const url = `${BASE_URL}/medias/upload-file`;
   // IMPORTANT: do NOT set Content-Type here — fetch derives the multipart
@@ -991,12 +1046,9 @@ export async function uploadResource(file: {
 // query params + delete shape live. Every helper surfaces a clear GhlError so a
 // PIT that lacks associations access fails loudly, not silently.
 // ---------------------------------------------------------------------------
-// Account-specific — MUST come from env (re-derive/create per account). No
-// stale fallback: an unset value fails visibly rather than pointing at another
-// account's association.
-export const CAREGIVER_CLIENT_ASSOCIATION_ID = (
-  process.env.CAREGIVER_ASSOCIATION_ID || ""
-).trim();
+// The caregiver_client association id is account-specific and is now read +
+// guarded via requireEnv({ caregiverAssociation: true }) at each point of use,
+// so it fails loudly when unset (no module-level const / stale fallback).
 
 export interface CaregiverRelation {
   relationId: string; // used to DELETE the link
@@ -1040,7 +1092,9 @@ const contactDisplay = (c: RawContact): string =>
 export async function listCaregiverRelations(
   clientContactId: string,
 ): Promise<CaregiverRelation[]> {
-  const { locationId } = requireEnv();
+  const { locationId, caregiverAssociationId } = requireEnv({
+    caregiverAssociation: true,
+  });
   // GHL "get relations by record": the record id goes in the PATH, and the only
   // accepted query params are locationId + skip + limit (both required). Passing
   // recordId/associationId as query props returns 422 ("property should not
@@ -1055,7 +1109,7 @@ export async function listCaregiverRelations(
     `/associations/relations/${encodeURIComponent(clientContactId)}?${params.toString()}`,
   );
   const relations = (data.relations || []).filter(
-    (r) => String(r.associationId ?? "") === CAREGIVER_CLIENT_ASSOCIATION_ID,
+    (r) => String(r.associationId ?? "") === caregiverAssociationId,
   );
   // The caregiver is whichever side of the relation is NOT the client contact.
   const caregiverIds = relations.map((r) => {
@@ -1137,10 +1191,12 @@ export async function createCaregiverRelation(
   clientContactId: string,
   caregiverContactId: string,
 ): Promise<string> {
-  const { locationId } = requireEnv();
+  const { locationId, caregiverAssociationId } = requireEnv({
+    caregiverAssociation: true,
+  });
   const body = {
     locationId,
-    associationId: CAREGIVER_CLIENT_ASSOCIATION_ID,
+    associationId: caregiverAssociationId,
     firstRecordId: clientContactId,
     secondRecordId: caregiverContactId,
   };
```

---

## feat: follower add/remove (owner/admin, dedicated endpoints)

```diff
diff --git a/app/api/opportunities/[id]/followers/route.ts b/app/api/opportunities/[id]/followers/route.ts
new file mode 100644
index 0000000..d6f9d84
--- /dev/null
+++ b/app/api/opportunities/[id]/followers/route.ts
@@ -0,0 +1,100 @@
+import { NextResponse } from "next/server";
+import {
+  getOpportunityById,
+  addOpportunityFollowers,
+  removeOpportunityFollowers,
+  GhlError,
+} from "@/lib/ghl";
+import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
+import { canManageFollowers } from "@/lib/visibility";
+import type { ApiError } from "@/lib/types";
+
+export const dynamic = "force-dynamic";
+export const runtime = "nodejs";
+
+// PATCH { ssoKey?, add?: string[], remove?: string[] } — manage followers via
+// GHL's dedicated add/remove endpoints. Only the OWNER or an admin may change
+// followers. Returns the recomputed follower id list (never depends on GHL's
+// response shape). Note: GHL sends NO native notification to a new follower.
+export async function PATCH(
+  request: Request,
+  ctx: { params: Promise<{ id: string }> },
+) {
+  try {
+    const { id } = await ctx.params;
+    const body = (await request.json().catch(() => ({}))) as {
+      ssoKey?: string;
+      add?: string[];
+      remove?: string[];
+    };
+    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");
+
+    // ---- identity (server-derived) ----
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
+    // ---- load target + owner/admin gate ----
+    const target = await getOpportunityById(id);
+    if (!target)
+      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
+        status: 404,
+      });
+    if (enforce && session && !canManageFollowers(target, session))
+      return NextResponse.json(
+        {
+          error: "Not permitted.",
+          detail: "Only the record owner or an admin can change followers.",
+          status: 403,
+        } as ApiError,
+        { status: 403 },
+      );
+
+    const add = (body.add || []).filter(Boolean);
+    const remove = (body.remove || []).filter(Boolean);
+    if (!add.length && !remove.length)
+      return NextResponse.json(
+        { error: "Nothing to change — provide add and/or remove." } as ApiError,
+        { status: 400 },
+      );
+
+    // Remove first, then add (so a same-tick add wins if both are sent).
+    if (remove.length) await removeOpportunityFollowers(id, remove);
+    if (add.length) await addOpportunityFollowers(id, add);
+
+    // Recompute the final set from the known-current followers so the result
+    // never depends on the GHL response shape.
+    const removeSet = new Set(remove);
+    const finalIds = Array.from(
+      new Set([...target.followerIds.filter((f) => !removeSet.has(f)), ...add]),
+    );
+
+    return NextResponse.json(
+      { ok: true, followers: finalIds },
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
+      { error: "Failed to update followers.", detail: String(e) } as ApiError,
+      { status: 500 },
+    );
+  }
+}
diff --git a/app/globals.css b/app/globals.css
index 7d1e0d6..43e4fba 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -372,3 +372,11 @@ button.rescard{width:100%;text-align:left;font:inherit;cursor:pointer;background
 .tplsrc{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3);background:var(--line-soft);border-radius:20px;padding:2px 8px;}
 .emailpreview .ephtml{max-height:320px;overflow:auto;}
 .emailpreview .ephtml img{max-width:100%;height:auto;}
+
+/* ── Task 5: follower editor ──────────────────────────────────── */
+.followedit{display:flex;flex-direction:column;gap:8px;}
+.folchips{display:flex;flex-wrap:wrap;gap:6px;}
+.folchip{display:inline-flex;align-items:center;gap:6px;background:var(--plum-soft);border:1px solid var(--plum-line);color:var(--plum);border-radius:20px;padding:3px 6px 3px 11px;font-size:11.5px;font-weight:600;}
+.folchip .folx{width:18px;height:18px;border-radius:50%;font-size:14px;line-height:1;color:var(--plum);background:transparent;}
+.folchip .folx:hover{background:#fff;}
+.folchip .folx:disabled{opacity:.5;cursor:progress;}
diff --git a/app/page.tsx b/app/page.tsx
index d219318..e48da64 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -1089,6 +1089,55 @@ export default function Dashboard() {
       (r) => ({ ...r, cf: { ...r.cf, [def.id]: value } }),
     );
 
+  // Follower add/remove — owner or admin only (Task 5). Uses the dedicated
+  // /followers route; updates the record from the recomputed id list.
+  const canManageFollowersClient = (r: OpportunityRecord) =>
+    isAdminViewer || (!!viewerId && r.ownerId === viewerId);
+
+  const saveFollowers = useCallback(
+    async (rec: OpportunityRecord, change: { add?: string[]; remove?: string[] }) => {
+      const fk = "followers";
+      setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: { status: "saving" } }));
+      try {
+        const res = await fetch(`/api/opportunities/${rec.id}/followers`, {
+          method: "PATCH",
+          headers: { "Content-Type": "application/json" },
+          body: JSON.stringify({
+            ssoKey: sso.status === "ready" ? sso.blob : undefined,
+            ...change,
+          }),
+        });
+        const j = (await res.json().catch(() => ({}))) as {
+          ok?: boolean;
+          followers?: string[];
+          error?: string;
+          detail?: string;
+        };
+        if (!res.ok || !j.ok || !Array.isArray(j.followers))
+          throw new Error(j.detail || j.error || `HTTP ${res.status}`);
+        const ids = j.followers;
+        const names = ids.map(
+          (uid) => users.find((u) => u.id === uid)?.name || "Former user",
+        );
+        setData((prev) =>
+          prev.map((r) =>
+            r.id === rec.id ? { ...r, followerIds: ids, followerNames: names } : r,
+          ),
+        );
+        setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: undefined }));
+      } catch (e) {
+        setSaveState((p) => ({
+          ...p,
+          [skey(rec.id, fk)]: {
+            status: "error",
+            msg: e instanceof Error ? e.message : String(e),
+          },
+        }));
+      }
+    },
+    [sso, users],
+  );
+
   // Kanban drag: 6px activation so a click still opens the record; keyboard too.
   const [dragId, setDragId] = useState<string | null>(null);
   const sensors = useSensors(
@@ -1878,7 +1927,7 @@ export default function Dashboard() {
                   </select>
                   {saveMsgFor(selected.id, "owner")}
                 </div>
-                <div className="f">
+                <div className="f wide">
                   <label>
                     Followers (Co-reps)
                     {viewerId &&
@@ -1887,12 +1936,64 @@ export default function Dashboard() {
                       <span className="readonly-note">you follow this</span>
                     ) : null}
                   </label>
-                  <div className="v ro">
-                    {selected.followerNames.length
-                      ? selected.followerNames.join(", ")
-                      : "—"}{" "}
-                    <span className="readonly-note">native GHL</span>
-                  </div>
+                  {canManageFollowersClient(selected) ? (
+                    <div className="followedit">
+                      <div className="folchips">
+                        {selected.followerIds.length ? (
+                          selected.followerIds.map((fid) => (
+                            <span className="folchip" key={fid}>
+                              {users.find((u) => u.id === fid)?.name ||
+                                "Former user"}
+                              <button
+                                type="button"
+                                className="folx"
+                                disabled={savingFk(selected.id, "followers")}
+                                onClick={() =>
+                                  saveFollowers(selected, { remove: [fid] })
+                                }
+                                aria-label="Remove follower"
+                              >
+                                ×
+                              </button>
+                            </span>
+                          ))
+                        ) : (
+                          <span className="muted">No followers</span>
+                        )}
+                      </div>
+                      <select
+                        className="v edit"
+                        value=""
+                        disabled={savingFk(selected.id, "followers")}
+                        onChange={(e) => {
+                          if (e.target.value)
+                            saveFollowers(selected, { add: [e.target.value] });
+                          e.target.value = "";
+                        }}
+                      >
+                        <option value="">+ Add follower…</option>
+                        {users
+                          .filter(
+                            (u) =>
+                              u.id !== selected.ownerId &&
+                              !selected.followerIds.includes(u.id),
+                          )
+                          .map((u) => (
+                            <option key={u.id} value={u.id}>
+                              {u.name}
+                            </option>
+                          ))}
+                      </select>
+                      {saveMsgFor(selected.id, "followers")}
+                    </div>
+                  ) : (
+                    <div className="v ro">
+                      {selected.followerNames.length
+                        ? selected.followerNames.join(", ")
+                        : "—"}{" "}
+                      <span className="readonly-note">owner/admin manage</span>
+                    </div>
+                  )}
                 </div>
               </div>
 
diff --git a/lib/ghl.ts b/lib/ghl.ts
index ca6b1f1..a026eb9 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -972,6 +972,68 @@ export async function createOpportunity(o: {
   return res.opportunity?.id || res.id || "";
 }
 
+// ---------------------------------------------------------------------------
+// Followers (Task 5) — dedicated add/remove endpoints (no full-opportunity PUT).
+// GHL sends NO native notification to a newly added follower. Shapes follow
+// GHL v2; scripts/followers-probe.mjs confirms them live. Each returns the
+// response's follower array best-effort, but the route recomputes the final set
+// from the known current followers so it never depends on the response shape.
+// ---------------------------------------------------------------------------
+export async function addOpportunityFollowers(
+  oppId: string,
+  userIds: string[],
+): Promise<string[]> {
+  if (!userIds.length) return [];
+  const res = await ghlSend<{ followers?: string[]; followersAdded?: string[] }>(
+    "POST",
+    `/opportunities/${encodeURIComponent(oppId)}/followers`,
+    { followers: userIds },
+  );
+  return res.followers ?? res.followersAdded ?? [];
+}
+
+export async function removeOpportunityFollowers(
+  oppId: string,
+  userIds: string[],
+): Promise<string[]> {
+  if (!userIds.length) return [];
+  // DELETE with a JSON body — ghlSend only covers PUT/POST/PATCH.
+  const url = `${BASE_URL}/opportunities/${encodeURIComponent(oppId)}/followers`;
+  let res: Response;
+  try {
+    res = await fetch(url, {
+      method: "DELETE",
+      headers: { ...headers(), "Content-Type": "application/json" },
+      body: JSON.stringify({ followers: userIds }),
+      cache: "no-store",
+    });
+  } catch (e) {
+    throw new GhlError(
+      "Could not reach GoHighLevel.",
+      502,
+      e instanceof Error ? e.message : String(e),
+    );
+  }
+  if (!res.ok) {
+    let detail = "";
+    try {
+      detail = (await res.text()).slice(0, 400);
+    } catch {
+      /* ignore */
+    }
+    throw new GhlError(
+      `GoHighLevel returned ${res.status} for DELETE /opportunities/{id}/followers.`,
+      res.status,
+      detail,
+    );
+  }
+  const j = (await res.json().catch(() => ({}))) as {
+    followers?: string[];
+    followersRemoved?: string[];
+  };
+  return j.followers ?? j.followersRemoved ?? [];
+}
+
 // ---------------------------------------------------------------------------
 // Resources upload (Task 1) — multipart to the GHL Media Library.
 // Server-only; the token never leaves this module. `parentId` targets the
diff --git a/lib/visibility.ts b/lib/visibility.ts
index b29aa10..143f77a 100644
--- a/lib/visibility.ts
+++ b/lib/visibility.ts
@@ -43,3 +43,16 @@ export function canSeeRecord(
 // Edit permission == visibility (same rule). Kept as a named alias so intent is
 // explicit at the call site.
 export const canEditRecord = canSeeRecord;
+
+/**
+ * Who may add/remove FOLLOWERS on a record: the OWNER or an admin only.
+ * A follower cannot re-share a record onward — this keeps the originating
+ * division in control of who its cases are shared with (Task 5).
+ */
+export function canManageFollowers(
+  rec: Pick<OpportunityRecord, "ownerId">,
+  session: Pick<GhlSession, "userId" | "role" | "type">,
+): boolean {
+  if (isAdminSession(session.role, session.type)) return true;
+  return rec.ownerId === session.userId;
+}
diff --git a/scripts/followers-probe.mjs b/scripts/followers-probe.mjs
new file mode 100644
index 0000000..11b03ed
--- /dev/null
+++ b/scripts/followers-probe.mjs
@@ -0,0 +1,45 @@
+#!/usr/bin/env node
+/**
+ * STEP 0 (Task 5) — confirm the GHL follower add/remove endpoints + shapes.
+ * Requires the GHL setting "Allow different owners for contacts and its
+ * opportunities" enabled (both sync sub-settings OFF). Run where the PIT works.
+ *
+ *   $env:GHL_PIT="pit-..."
+ *   $env:PROBE_OPP_ID="<an opportunity id>"
+ *   $env:PROBE_USER_ID="<a user id to add/remove as follower>"
+ *   node scripts/followers-probe.mjs
+ *
+ * ⚠️ This ADDS then REMOVES the user as a follower on PROBE_OPP_ID (net no-op
+ * if the user wasn't already a follower). Use a test opportunity.
+ */
+const BASE = "https://services.leadconnectorhq.com";
+const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
+const OPP = (process.env.PROBE_OPP_ID || "").trim();
+const USER = (process.env.PROBE_USER_ID || "").trim();
+if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
+if (!OPP || !USER) { console.error("Set PROBE_OPP_ID and PROBE_USER_ID."); process.exit(1); }
+
+const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
+const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
+
+async function hit(label, method) {
+  const res = await fetch(`${BASE}/opportunities/${OPP}/followers`, {
+    method, headers: H, body: JSON.stringify({ followers: [USER] }),
+  });
+  const body = await j(res);
+  console.log(`\n=== ${label} (${method}) ===`);
+  console.log("HTTP", res.status);
+  if (res.status === 401 || res.status === 403)
+    console.log("→ AUTH/SETTING: PIT scope, or the 'different owners' setting may be off.");
+  console.log(typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body, null, 2).slice(0, 700));
+  return body;
+}
+
+async function main() {
+  const added = await hit("ADD follower", "POST");
+  await hit("REMOVE follower", "DELETE");
+  console.log("\n>> Report: the ADD/REMOVE HTTP statuses and the response body's follower field name");
+  console.log(">> (followers vs followersAdded/Removed) so lib/ghl.ts reads the right key.");
+  console.log(">> Response keys (ADD):", added && typeof added === "object" ? Object.keys(added).join(", ") : "(non-JSON)");
+}
+main().catch((e) => { console.error(e); process.exit(1); });
```

---

