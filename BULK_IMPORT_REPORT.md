# Bulk Lead Import — Build Report

**Feature:** Generic bulk lead import (Excel/CSV → any pipeline)
**Status:** ✅ Built, type-checks, `next build` passes. Committed locally.
**Date:** 2026-08-07

---

## What it does

An **admin-only** "Import" tab that turns an uploaded `.xlsx` or `.csv` file into
GoHighLevel opportunities in **any pipeline** — nothing is hardcoded. At import
time the admin picks:

- the **destination pipeline** and **stage** (fetched live from GHL),
- the **source** label (free text, e.g. `Indeed`),
- the **column → GHL field mapping** (native contact fields + every opportunity
  custom field, all fetched live).

Rows are deduped by email/phone (GHL contact upsert); existing contacts are
**skipped** so re-importing the same file won't create duplicates.

---

## The flow (what the user sees)

1. **Import tab** appears in the top nav **only for admins** (role derived
   server-side from the encrypted SSO blob — never trusted from the client).
2. **Step 1 — Upload:** choose `.xlsx`/`.csv`. Parsed in the browser
   (`read-excel-file` for Excel, `papaparse` for CSV). Shows row/column counts.
3. **Step 2 — Destination:** pick Pipeline → Stage (dependent dropdowns) and a
   Source. All pipelines/stages come from `/api/import/meta`.
4. **Step 3 — Map columns:** each file column gets a target dropdown. Columns
   are **auto-mapped** by name (email/phone/first/last/name + exact custom-field
   name matches); the admin can override any of them. Mappings can be **saved as
   presets** (localStorage) and re-applied to future files.
5. **Step 4 — Preview & import:** a 5-row preview, then Import. Rows are sent to
   the server in **chunks of 25**, with a live `Importing… n/total` progress
   counter and a final summary: **created / skipped (existing) / failed**, plus a
   per-row error list.

---

## Server shapes (for your live verification)

Because the sandbox can't reach GHL, please confirm these with one small test
import. The two write calls are:

### Contact upsert (dedupe)
`POST /contacts/upsert`
```jsonc
{
  "locationId": "YVPhIAECw9q1M9Jw6A8L",
  "firstName": "…", "lastName": "…", "name": "…",
  "email": "…", "phone": "…", "source": "Indeed",
  "customFields": [{ "id": "<fieldId>", "value": <formatted> }]
}
```
Response is read as `{ contact: { id }, new }`. **`new === false` ⇒ existing
contact ⇒ we skip creating an opportunity** (dedupe).

### Opportunity create
`POST /opportunities/`
```jsonc
{
  "pipelineId": "<chosen>",
  "locationId": "YVPhIAECw9q1M9Jw6A8L",
  "pipelineStageId": "<chosen>",
  "contactId": "<from upsert>",
  "name": "<mapped opp name, or contact name/email fallback>",
  "status": "open",
  "source": "Indeed",
  "customFields": [{ "id": "<fieldId>", "value": <formatted> }]
}
```

### Value formatting (per custom-field dataType)
- `MULTIPLE_OPTIONS` / `CHECKBOX` → **array** of strings (a cell can be
  comma-separated, e.g. `A, B` → `["A","B"]`).
- `MONETORY` / `NUMERICAL` / `NUMBER` → **number**.
- everything else → **string**.

This matches the write shape your Phase-2 probe already confirmed
(`customFields:[{id,value}]`, arrays for multi-select).

> If your live test shows the create endpoint wants a different key (e.g.
> `pipelineStageId` vs `stageId`, or the response nests the id differently),
> it's a one-line change in `lib/ghl.ts` → `createOpportunity()` /
> `upsertContact()`.

---

## Files

| File | Change |
|---|---|
| `lib/ghl.ts` | `listPipelines()`, `upsertContact()` (returns `isNew`), `createOpportunity()` |
| `lib/types.ts` | `ImportPipeline`, `ImportMeta`, `ImportRowError`, `ImportSummary` |
| `app/api/import/meta/route.ts` | **NEW** — admin-gated GET → all pipelines (+stages) + opportunity custom-field defs |
| `app/api/import/route.ts` | **NEW** — admin-gated POST chunk processor (≤50 rows/req), upsert-then-create, dedupe, per-row errors |
| `components/ImportWizard.tsx` | **NEW** — the client wizard (parse, auto-map, destination, mapping, preview, chunked import, presets) |
| `app/page.tsx` | admin-only "Import" tab wired into the segmented nav |
| `app/globals.css` | import-wizard styles |
| `package.json` | added `read-excel-file`, `papaparse`, `@types/papaparse` |

---

## Security properties (unchanged from prior phases)

- **Token never touches the browser** — all GHL writes happen in the server API
  routes using `GHL_PIT`.
- **Admin-only** — both `/api/import/meta` and `/api/import` re-check
  `isAdminSession(role, type)` from the decrypted SSO blob; the client tab is
  hidden for non-admins, but the server is the real gate.
- **Identity is server-derived** — the client never sends a userId/role that the
  server trusts.

---

## What you still need to do

1. **Push this branch/commit** (GitHub write is blocked from this session —
   `doms-project` hasn't connected the Claude GitHub App, so I can't push).
   The commit is ready locally:

   ```bash
   git log --oneline -1        # "Add generic bulk lead import (Excel/CSV → any pipeline)"
   git push origin HEAD:master # your usual manual push
   ```

2. **Run one test import** (5–10 fake rows) and confirm created/skipped counts +
   that the opportunity lands in the right pipeline/stage. Report back if any
   field doesn't stick — likely a dataType formatting tweak.

3. **PIT scope** — the token needs **contacts write** + **opportunities write**
   scopes for import to work (in addition to the read scopes it already uses).

4. Still outstanding from earlier: rotate the exposed PIT, add
   `RESOURCES_FOLDER_ID` + medias scope, run the restricted-user visibility test.
