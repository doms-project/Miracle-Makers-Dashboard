# Build Report — Resources + Import redesign + Caregivers

**Batch:** Resources enhancements · Bulk Import redesign · Caregiver display · Multiple Caregivers
**Status:** ✅ All 4 tasks built · `next build` compiles clean · committed locally (`59d3597`)
**Date:** 2026-08-07
**Push:** blocked from this session (org hasn't connected the Claude GitHub App) → deliver via zip, push manually with `git push origin HEAD:master`.

---

## TASK 1 — Resources: Upload + Preview + Search

### 1a. Upload (admin-only, server-side)
- **Route:** `POST /api/resources/upload` — multipart, forwards the file to GHL `POST /medias/upload-file` with `parentId = RESOURCES_FOLDER_ID` so it lands in the OLTL Resources folder.
- **Admin gate is server-side.** Reps don't see the button *and* can't call the route (the SSO role is re-checked in the handler, not just hidden in the UI).
- **Size cap = 4 MB.** Vercel serverless functions reject bodies over ~4.5 MB; we cap below it and return a clear message instead of a platform 413. Change `MAX_UPLOAD_MB` in the route if the deploy target allows larger bodies.
- New server helper `uploadResource()` builds the multipart `FormData` and **does not** set `Content-Type` (fetch derives the multipart boundary). 401 → message points at the missing media WRITE scope.

### 1b. Preview
- **PDFs + images → inline modal** (iframe for PDF, `<img>` for images) using the fresh signed URL.
- **Office docs (.docx/.xlsx) + everything else → Download** (expiring signed URLs break Office online viewers). Detected by extension/mime in `previewKind()`.

### 1c. Search
- Client-side substring filter on filename (`resQuery` → `visibleResources`).

### 1d. Permissions
- All authenticated users view/download; **only admins upload**; no per-rep filter (shared reference docs).

> ⚠️ **Verify live (Step 0):** whether `parentId` actually lands the file in the folder on your tenant. Some GHL tenants ignore it and drop the file at root — in which case `listResources()` (which filters by parentId) won't show it. Run `node scripts/resources-upload-probe.mjs` and check the "file present in folder? YES/NO" line.

---

## TASK 2 — Bulk Import redesign (UX only; logic unchanged)

Redesigned into a clean **5-step wizard** with a clickable progress stepper:

| Step | What's new |
|---|---|
| **Upload** | Drag-and-drop zone (+ click to browse); shows file name, row count, column count; clear error on unreadable/empty/unsupported file |
| **Destination** | Pipeline → Stage dependent dropdowns (live from GHL) + Source |
| **Map** | Two-column mapper; auto-matched columns pre-filled with an **`auto`** badge; unmapped columns tagged **`skip`**; "N of M mapped" counter; saveable presets kept |
| **Preview** | First 8 rows shown **as mapped** (target field headers) + summary line: "X rows into [Pipeline] / [Stage], deduped by email/phone" |
| **Import** | Live **progress bar**; final panel with created / skipped (existing) / failed, scrollable row-error list, **⬇ Download error report** (CSV of failed rows + reasons), and "Import another file" reset |

- **Back navigation** between steps; Next is disabled until the current step is valid.
- **All import logic is unchanged** — pipeline-agnostic, dedupe via contact upsert, 25-row chunks, admin-only, server-side writes. The `/api/import` and `/api/import/meta` routes are untouched.

---

## TASK 3 — Caregiver in list & board

- **List view:** the Client cell now shows **Client name (bold)** with the **Caregiver name (muted, smaller)** directly below. No empty line when there's no caregiver.
- **Board card:** caregiver line added under the client title (🧑‍⚕️ prefix), shown only when present.
- Uses the existing `cg` (Caregiver Name) field — compact, no new column.

> Note: `cg` is the **free-text Caregiver Name custom field** on the opportunity. It is **not** the same as Task 4's linked caregiver contacts (associations). They can differ; decide later whether the list should eventually reflect the associated contacts instead.

---

## TASK 4 — Multiple Caregivers per Enrollment (associations)

Surfaces the many-to-many `caregiver_client` association (`6a6e26c9884def7a1438b965`) on the enrollment panel.

### 4a. Caregivers section
- Lists currently-associated caregivers (name + deep-link to the caregiver contact in GHL). Empty state: "No caregivers assigned yet."

### 4b. Add — searchable typeahead
- Rep types a name → live search of contacts **filtered to Record Type = "Caregiver"** → pick one → creates the `caregiver_client` relation (`POST /associations/relations`). Supports **multiple** caregivers. Assigns existing caregiver contacts only (no on-the-fly creation).

### 4c. Remove
- Per-caregiver remove → `DELETE /associations/relations/{relationId}`.

### 4d. Permissions
- Reuses the visibility model: a rep can manage caregivers on records they own/follow; admin all. Routes re-check server-side (403 otherwise). Scope is **only** the caregiver↔client link — no opportunity/compliance/multi-opp logic touched.

**New routes:** `GET/POST/DELETE /api/opportunities/[id]/caregivers` + `GET /api/opportunities/[id]/caregivers/search`.
**New server helpers:** `listCaregiverRelations`, `searchCaregiverContacts`, `createCaregiverRelation`, `deleteCaregiverRelation`.

> ⚠️ **Verify live (Step 0) — this is the one real risk:** whether **this dashboard's PIT** can call the Associations API at all. The endpoints exist, but PITs sometimes lack associations access (needs an OAuth token/scope). If so, add/list/remove will 401/403 **regardless of the code** — the UI shows a clear error, not a crash. Run `node scripts/associations-probe.mjs` (set `PROBE_CLIENT_CONTACT_ID`) and report: which list-shape returned 200, the relation object's field names, and whether a contact carries a "Record Type = Caregiver" value we can filter on. I'll lock the exact shapes from that.

---

## Files

| File | Change |
|---|---|
| `lib/ghl.ts` | `uploadResource`, associations helpers (`listCaregiverRelations`, `searchCaregiverContacts`, `createCaregiverRelation`, `deleteCaregiverRelation`), `CAREGIVER_CLIENT_ASSOCIATION_ID` |
| `lib/types.ts` | `Caregiver` type |
| `app/api/resources/upload/route.ts` | **NEW** — admin upload |
| `app/api/opportunities/[id]/caregivers/route.ts` | **NEW** — GET/POST/DELETE, visibility-gated |
| `app/api/opportunities/[id]/caregivers/search/route.ts` | **NEW** — typeahead |
| `components/ImportWizard.tsx` | Rewritten as the stepped wizard |
| `components/CaregiversSection.tsx` | **NEW** — panel section (list/add/remove) |
| `app/page.tsx` | Resources toolbar/upload/preview; caregiver in list + board card; Caregivers panel section |
| `app/globals.css` | Styles for all four tasks |
| `scripts/resources-upload-probe.mjs`, `scripts/associations-probe.mjs` | **NEW** — Step-0 live probes |
| `.env.example` | `CAREGIVER_ASSOCIATION_ID` |

---

## Security properties (unchanged)
- GHL token stays **server-only** (all writes through API routes).
- Resources upload, import, and caregiver routes **re-check the SSO role/visibility server-side** — UI hiding is not the gate.
- Resources still scoped strictly to `RESOURCES_FOLDER_ID` (double-filtered in code so a mis-supported param can't leak the shared library).

---

## Your next steps
1. **Push:** `git push origin HEAD:master` (from the delivered zip).
2. **Run the two probes**, paste output — I'll confirm/lock the upload-folder and associations shapes.
3. **PIT scopes:** add **media WRITE** (Task 1 upload) and confirm **Associations API access** (Task 4). Import still needs contacts + opportunities write.
4. Still outstanding from before: rotate the exposed PIT; restricted-user visibility test.

## Queued (not built — blocked)
- **Task 5 — Email-send button:** blocked on email-domain authentication (emails land in spam until the sending domain is authenticated). Placeholder only.
