# Miracle Makers · OLTL Enrollments Dashboard

A read-only dashboard that displays **live OLTL Enrollment opportunities** from
GoHighLevel (GHL), built with **Next.js (App Router) + TypeScript + Tailwind**
and deployed on **Vercel**.

> **Phase 1 — read-only.** The dashboard reads and displays records only. No
> editing / write-back yet (Phase 2), and no SSO / per-user filtering yet
> (Phase 3). See [Roadmap](#roadmap).

## How it works (and why the token is safe)

The GHL Private Integration Token **never touches the browser**. The React
frontend calls a same-origin API route — `GET /api/opportunities` — which runs
**server-side only**. That route reads the token from an environment variable,
calls GHL, normalizes the data, and returns clean JSON. The token is never sent
to the client and never committed to the repo.

```
Browser --> /api/opportunities (server) --> GoHighLevel API
             reads GHL_PIT env var,
             returns normalized JSON
```

## Environment variables

Set these in the Vercel dashboard (**Project -> Settings -> Environment
Variables**) and, for local dev, in a `.env.local` file. See `.env.example`.

| Variable           | Required | Description                                                                                                  |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `GHL_PIT`          | yes      | GHL Private Integration Token (`pit-...`). Sent as `Authorization: Bearer <token>` (verified against the v2 API). |
| `GHL_LOCATION_ID`  | yes      | GHL sub-account (location) ID. Defaults to `YVPhIAECw9q1M9Jw6A8L` in `.env.example`.                          |
| `OLTL_PIPELINE_ID` | no       | The OLTL Enrollments pipeline ID. **If blank, the route finds the pipeline by name** (matches `/oltl/i`).     |
| `GHL_API_VERSION`  | no       | GHL API version header. Defaults to `2021-07-28`.                                                             |
| `GHL_AUTH_SCHEME`  | no       | Auth scheme for the token. Defaults to `Bearer`. Set to `none`/`raw` for a bare token, or another scheme.     |

### About the OLTL pipeline ID and custom fields

You **do not have to hardcode any GHL IDs**. The API route resolves everything at
runtime against the live GHL account:

- **Pipeline + stages** — looked up from `/opportunities/pipelines`. If
  `OLTL_PIPELINE_ID` isn't set, the pipeline whose name matches `OLTL` is used.
  (Set the env var once you have the exact ID to remove any ambiguity.)
- **Custom fields** — the route pulls the location's opportunity custom fields
  and maps them to the dashboard columns **by name** (Harmony ID, County ID,
  Office, County, Road Blocker, Referral Source, Source, Sales Rep Assistant,
  Case Manager, Onboarding Rep, Caregiver, Checked). Aliases are tolerated, so
  minor naming differences still resolve. If a GHL field is renamed and stops
  matching, add the alias in `lib/ghl.ts` -> `FIELD_ALIASES`.
- **Owner (Sales Rep)** — resolved from `/users/` (user id -> name).

## Normalized record shape

Each opportunity is returned to the frontend as:

```ts
{ id, first, last, stage, harmony, countyId, office, county,
  block, ref, src, rep, asst, cm, onb, cg, checked }
```

`stage` = pipeline stage name, `rep` = owner name, the rest come from OLTL
opportunity custom fields. `block` defaults to `"None"` when empty.

## Local development

```bash
npm install
cp .env.example .env.local   # then paste your GHL_PIT into .env.local
npm run dev                  # http://localhost:3000
```

Verify the data path before relying on the UI:

```bash
curl -s http://localhost:3000/api/opportunities | head
```

You should get `{"records":[...],"pipeline":{...},"count":N}`. A misconfigured
token or pipeline returns a clean JSON error with a `detail` explaining what to
fix (it does not crash the page).

## Deploy to Vercel

1. Import this repo into Vercel (framework auto-detects as **Next.js**).
2. Add the environment variables above (at minimum `GHL_PIT` and
   `GHL_LOCATION_ID`).
3. Deploy. Redeploy after changing env vars so they take effect.

## Security / access notes

- **No per-user filtering yet (Phase 3).** The deployed dashboard shows **all**
  OLTL records to anyone who opens the URL. This is fine for admin/testing, but
  **do not share the URL with sales reps** until Phase 3 (SSO +
  per-user/office filtering) ships.
- **HIPAA.** Use a test sub-account with fake data for now. Before real client
  data flows through, Vercel must be on a HIPAA-appropriate plan with a signed
  BAA.

## Roadmap

- **Phase 1 (this) — read-only live grid.** List + board views, stage
  filtering, search, record slide-out. Notes and the "Viewing as" dropdown are
  visual stubs.
- **Phase 2 — write-back.** Inline edits / PATCH to GHL (stage, road blocker),
  persisted notes.
- **Phase 3 — SSO + scoped visibility.** Per-user and per-office filtering so
  reps see only their assigned data.

## Project structure

```
app/
  api/opportunities/route.ts   server-only GHL fetch -> normalized JSON
  globals.css                  ported design (brand colors, layout)
  layout.tsx                   root layout + Inter font
  page.tsx                     dashboard UI (list/board/panel/search)
lib/
  ghl.ts                       GHL client, lookups, normalization
  types.ts                     shared types
```
