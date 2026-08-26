# Miracle Makers Dashboard — Master Report

**Repo:** `doms-project/Miracle-Makers-Dashboard`
**Branch:** `v2-multi-pipeline`
**Account (v2):** `anzcWt3S0tzpu2fEaS8X` ⭐ *(new — not the old `YVPhIAECw9q1M9Jw6A8L`)*
**Status:** ✅ All v1 features + v2 Tasks 1–8 built · `next build` compiles clean
**Date:** 2026-08-26

> Delivery rule for this project: every change is committed locally and shipped as a
> complete zip **with full `.git` history**. Nothing is pushed to GitHub and nothing is
> merged — you push manually.

---

## 1. What this is

A Next.js 16 (App Router) + TypeScript + Tailwind dashboard, embedded in GoHighLevel,
showing live opportunities across **five client pipelines**. The GHL token never touches
the browser: every read and write goes through server-side API routes.

**Stack:** Next.js 16.3.0 · React 19.2 · TypeScript (strict) · Tailwind 3 · @dnd-kit ·
read-excel-file · papaparse · crypto-js (SSO decrypt).

---

## 2. Architecture in one page

```
Browser (app/page.tsx + components/)
   │  SSO blob from GHL via postMessage
   │  fetch → /api/*  (blob sent, never a userId)
   ▼
Next.js API routes (server)
   1. decryptSso(blob)              → who is this, really
   2. permission check              → visibility.ts / pipelineAccess.ts
   3. lib/ghl.ts                    → the ONLY place the PIT is used
   ▼
GoHighLevel v2 API  (Bearer PIT, Version 2021-07-28 / 2021-04-15 for email)
```

**Non-negotiables held throughout**
- Token is server-only; the browser never sees it.
- Identity is **derived server-side** from the encrypted SSO blob — a client-sent
  userId is never trusted.
- Every write route re-checks permission. UI hiding is never the gate.
- Custom fields resolve **by name**, never by hardcoded id, so the app survives a
  new sub-account.
- Per-field save with **revert-on-error** — never a false "saved".

---

## 3. Feature inventory

### v1 (original build)
| # | Feature | Where |
|---|---|---|
| 1 | Read-only live dashboard (list + board, search, stage chips, record panel) | `app/page.tsx` |
| 2 | Server-only GHL client, Bearer auth hardening | `lib/ghl.ts` |
| 3 | GHL SSO handshake + server-side decrypt | `lib/sso.ts`, `lib/useGhlSession.ts`, `/api/decrypt-sso` |
| 4 | Assignment-only visibility (owner OR follower; admin = `role === "admin"`) | `lib/visibility.ts` |
| 5 | Inline editing / write-back, dynamic editors by dataType | `/api/opportunities/[id]` |
| 6 | Persistent notes (contact notes scoped to the opportunity) | `/api/opportunities/[id]/notes` |
| 7 | Sort, group-by, office filter, source/rep stats | `app/page.tsx` |
| 8 | Kanban drag-to-change-stage | `@dnd-kit` + `DragOverlay` |
| 9 | Resources tab (folder-scoped GHL media) | `/api/resources` |
| 10 | Bulk lead import (Excel/CSV → any pipeline) | `/api/import`, `components/ImportWizard.tsx` |
| 11 | Resources upload + preview + search | `/api/resources/upload` |
| 12 | Multiple caregivers (associations) | `/api/opportunities/[id]/caregivers` |
| 13 | Email send + live GHL templates | `/api/opportunities/[id]/email` |

### v2 (this brief — Tasks 1–8)
| Task | Delivered | Commit |
|---|---|---|
| 1 | Removed debug instrumentation + decrypted-session logging | `093bdde` |
| 2 | Multi-pipeline fetch, stage map keyed `pipelineId::stageId` | `7a6249d` |
| 3 | Pipeline access map + division scoping (`shared` per viewer) | `f5dcad6` |
| 4 | Folder-driven field sets, Option B lost-reason mapping, blocklist correction | `9a2f88a`, `10fffac` |
| 5 | Follower add/remove (owner/admin, dedicated endpoints) | `8d4db7e` |
| 6 | The Move action (simple move + transfer, G1 follower clearing) | `745e20c` |
| 7 | Division badges, shared-with-me filter, user labels, board scoping, admin selector | `1ea14ca` |
| 8 | SSN masked with click-to-reveal | `64fed1b` |

**Hardening commits along the way:** stale old-account ID removal (`7056e8d`), fail-loud
`requireEnv` + pipeline-config assertion (`0cca4af`), follower-id validation (`054fb7d`),
Move stranded-record reporting + retry (`382d243`), account correctness (`ae8a02a`).

---

## 4. The permission model (the heart of it)

```
admin (role === "admin")                              → everything
home pipeline AND (owner OR follower OR unassigned)   → theirs   (shared = false)
ANY  pipeline AND (owner OR follower)                 → visible  (shared = true)
otherwise                                             → excluded
```

⚠️ **The asymmetry is deliberate and enforced:** `unassigned` counts **only** in home
pipelines. An unassigned record in another division must never surface, or every rep
would see every unowned lead account-wide.

- **Admin is role-only.** `type === "agency"` is *account context*, not permission —
  using it was a real v1 bug that let restricted reps see everything.
- **Fails closed:** an unmapped user browses nothing but still sees what they own/follow.
- Divergence from GHL's native "Only Assigned Data": we deliberately let reps see
  **unassigned** work in their own division so it can be claimed. Flag to Adrianne.

---

## 5. Task 6 — the Move action, in detail

**Ordering is the whole design.** The owner change goes **first**, atomically with the
stamps, because it is the step that can fail for permission reasons:

```
0. PREFLIGHT (no writes)   destination resolves · HAS TRANSFERRED IN · new owner is real
1. PUT #1                  assignedTo + Transferred From/Date (+ Transfer Reason)  ← atomic
2. clear followers         all except the new owner (G1)
3. note                    written only now, when the transfer is real
4. PUT #2 (retry ×3)       pipelineId + stage = TRANSFERRED IN   ← must follow the owner change
```

- Step 1 failing ⇒ **nothing written**, record untouched.
- Step 4 failing ⇒ record is **STRANDED** (owner moved, still in source pipeline,
  invisible to browsing). Retried 3× with backoff, then reported explicitly in the 500.
- **No tag** is written: GHL tags are contact-scoped and couldn't identify which
  opportunity moved. History lives in Transferred From/Date + the note.
- `Transferred From` is SINGLE_OPTIONS whose option list says **"ODP Enrollments"**
  while the pipeline is **"ODP Enrollment"** — the value is matched against the field's
  real options with singular/plural tolerance.
- Entry gate: simple move = `canEditRecord`; transfer = **owner or admin**.

---

## 6. Files

```
  .env.example
  .gitignore
  README.md
  app/api/decrypt-sso/route.ts
  app/api/import/meta/route.ts
  app/api/import/route.ts
  app/api/opportunities/[id]/caregivers/route.ts
  app/api/opportunities/[id]/caregivers/search/route.ts
  app/api/opportunities/[id]/email/route.ts
  app/api/opportunities/[id]/followers/route.ts
  app/api/opportunities/[id]/move/route.ts
  app/api/opportunities/[id]/notes/route.ts
  app/api/opportunities/[id]/route.ts
  app/api/opportunities/route.ts
  app/api/resources/route.ts
  app/api/resources/upload/route.ts
  app/globals.css
  app/layout.tsx
  app/page.tsx
  components/CaregiversSection.tsx
  components/EmailComposer.tsx
  components/ImportWizard.tsx
  components/MoveDialog.tsx
  lib/division.ts
  lib/editable.ts
  lib/emailTemplates.ts
  lib/fieldFolders.ts
  lib/ghl.ts
  lib/pipelineAccess.ts
  lib/sso.ts
  lib/types.ts
  lib/useGhlSession.ts
  lib/visibility.ts
  next.config.js
  package-lock.json
  package.json
  postcss.config.js
  scripts/associations-probe.mjs
  scripts/email-probe.mjs
  scripts/email-templates-probe.mjs
  scripts/followers-probe.mjs
  scripts/rederive-ids-probe.mjs
  scripts/resources-probe.mjs
  scripts/resources-upload-probe.mjs
  scripts/step0-write-test.mjs
  tailwind.config.ts
  tsconfig.json
```

**39 source files · 56 commits · 13 API routes.**

---

## 7. Environment variables

### Required — the app will not work without these
| Var | Value |
|---|---|
| `GHL_PIT` | 🔴 **ROTATE** — the old one was exposed in plaintext |
| `GHL_SSO_SECRET` | 🔴 **Must be set in production.** Without it `ssoConfigured()` is false and **every route is open**, including import, resources upload, followers and move |
| `GHL_LOCATION_ID` | `anzcWt3S0tzpu2fEaS8X` |

### Must be re-derived for the new account
| Var | How |
|---|---|
| `RESOURCES_FOLDER_ID` | `node scripts/rederive-ids-probe.mjs` — if no folder exists, create it in the GHL Media Library |
| `CAREGIVER_ASSOCIATION_ID` | same probe — if none is returned it must be **created** (`POST /associations`, key `caregiver_client`); the probe prints the payload |
| `PIPELINE_ACCESS_MAP` | the probe lists this account's users and **flags any id not present** — rebuild from that output |

### Optional (sensible defaults)
| Var | Default |
|---|---|
| `PIPELINE_IDS` | the five pipelines (logs a warning when it falls back to the baked-in default) |
| `NEXT_PUBLIC_GHL_LOCATION_ID` | `anzcWt3S0tzpu2fEaS8X` (deep links only, not secret) |
| `GHL_API_VERSION` | `2021-07-28` |
| `GHL_EMAIL_API_VERSION` | `2021-04-15` |
| `GHL_EMAIL_FROM` | blank until the sending domain is authenticated |
| `GHL_AUTH_SCHEME` | `Bearer` |

### PIT scopes needed
`opportunities` (r/w) · `contacts` (r/w) · `custom fields` (r) · `users` (r) ·
`medias` (**r/w** — upload) · `associations/relations` · `conversations/email` (send) ·
`templates` (r)

---

## 8. Fail-loud behaviour (no silent misconfiguration)

| Was silent | Now |
|---|---|
| `RESOURCES_FOLDER_ID` unset → upload lands in the media **root** | `requireEnv({resourcesFolder:true})` throws at point of use |
| `CAREGIVER_ASSOCIATION_ID` unset → caregiver list filters on `""` and looks **empty** | `requireEnv({caregiverAssociation:true})` throws |
| `PIPELINE_IDS` unset → runs on baked-in ids unnoticed | `console.warn` on first use |
| Pipeline without a `PIPELINE_FOLDERS` entry → all fields dump into "Other fields" and look fine | `console.warn` naming the pipeline |
| Arbitrary follower id stored → renders "Former user", indistinguishable from a deleted account | ADD ids validated against location users (400) |
| Transfer into a pipeline with no `TRANSFERRED IN` | preflight refuses **before** the owner moves |

---

## 9. Known gaps / honest limitations

1. **SSN masking is not a security boundary.** The value is in the API payload, so
   devtools can read it. It reduces casual + screen-share exposure only. Real
   protection = withhold it server-side for non-privileged viewers.
2. **Follower batch atomicity is unverified server-side.** We send one DELETE with the
   whole array (never a loop), so this code can't partially clear — but GHL's handling
   of a failed batch is unknown, so failures report `attemptedFollowerRemovals`.
3. **Email deliverability is domain-gated.** Sends will land in spam until SPF/DKIM/DMARC
   are set up and a verified `emailFrom` is configured. The composer says so.
4. **`fieldFolders.ts` is keyed by pipeline id.** Accepted as structural config; the
   name/key refactor is a later task. A startup assertion covers the silent-mismatch case.
5. **No transactions on Move.** Mitigated by ordering, a preflight, retries, and explicit
   partial-failure reporting.

---

## 10. What's left — verification and config, not code

```
[ ] 🔴 Rotate the PIT (old one exposed in plaintext)
[ ] 🔴 Set GHL_SSO_SECRET in production
[ ] Run scripts/rederive-ids-probe.mjs      → RESOURCES_FOLDER_ID, CAREGIVER_ASSOCIATION_ID,
                                              and this account's real user ids
[ ] Rebuild PIPELINE_ACCESS_MAP from those user ids
[ ] Enable GHL "Allow different owners for contacts and its opportunities"
    (BOTH sync sub-settings OFF), then run scripts/followers-probe.mjs
[ ] Run scripts/associations-probe.mjs      → confirm create/delete shapes
[ ] Run scripts/email-templates-probe.mjs   → templates list + send shape + Version + emailFrom
[ ] Authenticate the sending domain (Jack/DNS) → then set GHL_EMAIL_FROM
[ ] Build the ~10 email templates in GHL (config fallback covers the gap)
[ ] Restricted-user visibility test (a rep sees only their division + shared)
[ ] HIPAA/BAA before real client data
```

---

## 11. Per-task reports (full line-by-line diffs)

Each of these is in the repo root and contains the **complete unified diff for every
changed line**, including punctuation:

```
V2-REPORT-01-DEBUG-AND-MULTIPIPELINE.md   Tasks 1–2 + re-derive probe
V2-REPORT-02-ACCESS-SCOPING.md            Task 3 + known gaps G1/G2
V2-REPORT-03-FOLDER-FIELDS.md             Account fixes + Task 4 + user-field spec
V2-REPORT-04-HARDCODE-AUDIT.md            Hardcoded-ID audit
V2-REPORT-05-FOLLOWERS.md                 Fail-loud follow-ups + Task 5
V2-REPORT-06-MOVE.md                      Task 6
V2-REPORT-07-UI.md                        Move follow-ups + Task 7
V2-REPORT-08-SSN-MASK.md                  Task 8
```

Earlier v1 reports: `BULK_IMPORT_REPORT.md`, `RESOURCES_IMPORT_CAREGIVERS_REPORT.md`,
`EMAIL_SEND_REPORT.md`, `EMAIL_TEMPLATES_LIVE_REPORT.md`, `CAREGIVER_LIST_FIX_REPORT.md`.

---

## 12. Running it

```bash
unzip miracle-makers-COMPLETE.zip -d mm
cd mm
npm install
cp .env.example .env.local      # fill in the required vars
npm run build                   # compiles clean
npm run dev

# to push (nothing was pushed for you):
git push origin HEAD:master     # or: git push -u origin v2-multi-pipeline
```

---

## 13. Full commit history

```
  af523a7 first commit
  c4a75c2 Phase 1: read-only live OLTL Enrollments dashboard
  ba10d32 Harden GHL auth against 401 "invalid jwt"
  ffaf915 Default GHL auth scheme to Bearer
  a8cd74b Phase 3 Step 0: GHL SSO handshake + server-side decrypt
  149d1bb Phase 3: server-side assignment-only visibility filter
  d487460 Add followers to record shape + UI (Owner vs Co-reps)
  784b8b8 Close client requirements gaps: sort, office filter, source/rep stats
  90adaab Phase 2 prep: Step 0 write-test tool + field definitions + read-only blocklist
  dffa861 Step 0 probe: forgiving stage match + clearer wrong-pipeline error
  aa4d9e0 Phase 2: inline editing (write-back) + read-mapper fixes
  4cc6e15 Fix Phase 2 bug: dropdown/multi-select options were empty
  aa953ae Cleanup: remove temporary /api/fields-debug route + fieldDefs console log
  c895875 Redesign record panel into ordered, grouped sections
  829046d Phase 2: persistent notes (contact notes scoped to the opportunity)
  bbdc15f Add visibility diagnostics (no logic change) to trace the filter bug
  e509971 Fix visibility bug: admin is role-only, not type === "agency"
  c7aba53 Add dynamic, permission-aware Sort + Group-by (any field)
  39e8a09 Add Kanban drag-to-change-stage (board view)
  dcdcc23 Fix Kanban drag bugs: card clipping + missing/empty stage columns
  e45b04a Add Resources tab (folder-scoped GHL Media Library)
  37f8ccb Add generic bulk lead import (Excel/CSV → any pipeline)
  2cb944b Add bulk import build report
  59d3597 Resources upload/preview/search + import wizard redesign + caregivers
  fb0c55f Add build report for Resources/Import/Caregivers batch
  a3fafd4 Task 5: Email-send button (built, domain-gated for live sending)
  f3e63b7 Add build report for Task 5 (email-send)
  07e36d0 Email templates: pull live from GHL (config as fallback)
  cd15708 Add report for live GHL email templates
  c0da464 Fix caregiver list: correct GHL get-relations-by-record shape
  5aeb771 Add report for caregiver-list 422 fix
  52a1070 Import: require a contact-identity column before import
  093bdde chore: remove debug instrumentation and session logging
  7a6249d feat: multi-pipeline fetch with per-pipeline stage map
  d9201ad chore: add re-derive-IDs probe for the new account
  11b9a18 docs: v2 report — debug strip + multi-pipeline (full line-by-line diffs)
  60893f4 chore: probe flags create-when-empty for the new-account IDs
  f5dcad6 feat: pipeline access map and division scoping
  fa5e18c docs: v2 report — access scoping (full line-by-line diffs)
  ae8a02a fix: v2 account correctness — location, deep-links, probe user check
  9a2f88a feat: folder-driven field sets per pipeline
  10fffac fix: Harmony ID and County ID editable; add derived fields to blocklist
  aa36b33 docs: v2 report — account fixes + folder-driven field sets (full diffs)
  7056e8d chore: remove stale old-account ID fallbacks
  c6a8f41 docs: hardcoded-ID audit report
  0cca4af fix: fail loud on missing account ids + pipeline-config mismatch
  8d4db7e feat: follower add/remove (owner/admin, dedicated endpoints)
  6f08454 docs: v2 report — fail-loud + followers (full diffs)
  054fb7d fix: validate follower ids against the location's users
  745e20c feat: Move action (simple move + transfer, incl. G1 follower clearing)
  1f48795 docs: v2 report — Move action (full diffs)
  382d243 fix: Move — stranded-record reporting, PUT #2 retry, honest toggle label
  1ea14ca feat: division badges, shared-with-me filter, user labels, board scoping
  d9623bd docs: v2 report — Move follow-ups + UI (full diffs)
  64fed1b feat: mask SSN with click-to-reveal
  166976d docs: v2 report — SSN masking (full diff)
```

*Master report · 26 August 2026*
