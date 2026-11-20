# Miracle Makers Dashboard

A case-management dashboard for Miracle Makers, built on top of **GoHighLevel (GHL)**. Staff open it inside GHL; it
reads and writes the GHL sub-account directly — there is no separate database.

It covers the client pipelines (OLTL Enrollment, OLTL Transfer, ODP Enrollment, ODP Transfer, Private Pay Clients),
caregiver recruiting, referrals, notes, followers and owners, stage moves, transfers between the two companies'
GHL accounts, a resources library, CSV / Excel import and email from templates.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS · hosted on Vercel.

```
GHL sub-account ──(Custom Page, iframe)──► Dashboard UI (app/page.tsx, components/)
       ▲   │                                     │
       │   └─ SSO blob (postMessage) ──────────► /api/decrypt-sso      (marketplace app Shared Secret)
       │                                         │
       │   GHL API v2 (Private Integration Token)│
       └─────────────────────────────────────── /api/*  (lib/ghl.ts — server only)
       │
       └─ Workflow "Webhook" actions ─────────► /api/webhooks/ghl, /api/webhooks/ghl/stage   (inbound)
                                                 /api/* ──► WEBHOOK_URL (Make / GHL)        (outbound events)
```

---

## 1. The GHL marketplace app (how staff open the dashboard)

The dashboard is installed in the sub-account through a **GHL marketplace app** and shown as a **Custom Page** (an
iframe inside GHL). The app is used for two things only: placing the page in GHL's menu, and **SSO** — telling the
dashboard who the logged-in GHL user is. All data access goes through the Private Integration Token (section 2),
not through the app's OAuth.

**SSO handshake** (`lib/useGhlSession.ts`, `app/api/decrypt-sso/route.ts`, `lib/sso.ts`):

1. In the browser, the dashboard sends `postMessage({ message: "REQUEST_USER_DATA" })` to the parent GHL window.
2. GHL answers with `REQUEST_USER_DATA_RESPONSE` and an **AES-encrypted blob**.
3. The browser POSTs the blob to `/api/decrypt-sso`. The server decrypts it with the app's **Shared Secret**
   (`GHL_SSO_SECRET`, from the marketplace app → Manage → Secrets) and returns the session: `userId`, `role`,
   `type`, `userName`, `email`, `companyId`, `activeLocation`.
4. The secret never reaches the browser, so a session cannot be forged. Decryption follows GHL's official
   marketplace-app-template.

The session decides who sees and edits what: admins see everything; other users see their division's pipelines
(`PIPELINE_ACCESS_MAP`, `lib/pipelineAccess.ts`) plus any record they own or follow; note edit/delete is author-only.

> ⚠️ **If `GHL_SSO_SECRET` is missing, every permission gate is open.** That is intended for local setup only. The
> server prints a warning at start-up — a deployed site must always have the secret set.

`SSO_PROBE=1` logs the decrypted session (email masked) for checking roles; leave it off normally.

## 2. The GHL API

All GHL calls are made **server-side** in `lib/ghl.ts` (and `lib/peer.ts` for the other company's account). The
browser only talks to this app's own `/api/*` routes.

| | |
|---|---|
| Base URL | `https://services.leadconnectorhq.com` (override: `GHL_API_BASE`) |
| Auth | `Authorization: Bearer <GHL_PIT>` — a **Private Integration Token** of the sub-account (`GHL_AUTH_SCHEME` can change the prefix) |
| Version header | `Version: 2021-07-28` (`GHL_API_VERSION`); email endpoints use `2021-04-15` (`GHL_EMAIL_API_VERSION`) |
| Location | `GHL_LOCATION_ID` |

**Endpoints used**

| Area | Endpoints |
|---|---|
| Opportunities (cases) | `GET /opportunities/search` · `POST /opportunities/` · `GET/PUT/DELETE /opportunities/{id}` · `POST/DELETE /opportunities/{id}/followers` · `/opportunities/pipelines` (+ `/{id}`, admin tab) |
| Contacts | `POST /contacts/search` · `GET /contacts/search/duplicate` · `POST /contacts/upsert` · `POST /contacts/` · `GET/PUT /contacts/{id}` · `/contacts/{id}/notes` (+ `/{noteId}`) · `/contacts/{id}/tags` |
| Custom fields & values | `/locations/{id}/customFields` (+ `/{fieldId}`) · `/locations/{id}/customValues` (+ `/{id}`) · `/custom-fields/` (folders) · `/locations/{id}/tags` |
| Users | `GET /users/` — owner / follower names and pickers |
| Associations | `/associations/{id}` · `/associations/relations` (+ `/{id}`) — caregiver ↔ client links (`CAREGIVER_ASSOCIATION_ID`) |
| Media (resources tab) | `GET /medias/files` · `POST /medias/upload-file` · `POST /medias/folder` · `DELETE /medias/{id}` |
| Email | `GET /locations/{id}/templates` · `POST /conversations/messages/outbound` (`GHL_EMAIL_FROM`) |

**Token scopes** — the PIT needs read + write for Contacts, Opportunities, Custom Fields, Custom Values, Tags,
Associations and Media, plus read for Users and Locations, and Conversations / Templates for email. Missing
`users.readonly` is the most common problem: names and owner pickers go empty (the server log says so).

**Custom fields the dashboard expects** on the opportunity, by name: `Stage History` (large text — written by the
stage webhook), `Case Manager` / `Case Manager Followers`, `First Opened` (new-lead label), `Peer Record Id`
(transfers, optional). A missing field is reported in the response or log rather than failing silently.

### Transfers between the two companies (optional)

The ODP division was sold, so there are **two GHL sub-accounts and two deployments of this same code**. A transfer
recreates the client or caregiver in the other account and closes it here (`lib/peer.ts`,
`/api/opportunities/{id}/transfer`). It needs `PEER_PIT`, `PEER_LOCATION_ID` and `PEER_LABEL` — **the other
account's** values (they are crossed between the two deployments). Without them the Transfer button does not appear.
Both accounts need a `TRANSFERRED OUT` destination and a `TRANSFERRED IN` stage; see `.env.example`.

## 3. Webhooks

One shared secret, `WEBHOOK_SECRET`, protects both directions.

### Inbound — GHL workflows → dashboard

GHL workflow **Webhook** actions call these URLs. Every call must carry either
`X-MM-Signature: sha256=<HMAC-SHA256 of the exact body, keyed with WEBHOOK_SECRET>` or
`X-MM-Secret: <WEBHOOK_SECRET>`. Without a valid one the answer is `401`; with no `WEBHOOK_SECRET` set, every call
is refused.

| URL | What it does |
|---|---|
| `POST /api/webhooks/ghl` | **Workflow payload** (has `contact_id`): finds the case, then adds the owner's case managers as followers and fills the case-manager fields. With **`?setOwner=1`** (only on a Webhook step placed right after *Assign to user*) it first copies the contact's owner onto the case — without the flag it never changes an owner. A payload for a different location is refused, because two deployments share this code. The native `OpportunityStageUpdate` event is recognised but not acted on. |
| `POST /api/webhooks/ghl/stage` | **Stage recorder**: reads the opportunity and appends one row (stage + owner + time) to its `Stage History` field. Safe to redeliver — a repeat of the same stage writes nothing. |
| `GET` on either URL | Health check: says what the route does. No data. |

Inbound calls always answer `202` with a `reason` (also logged as `[webhook:in] …`) when there is nothing to do, so
GHL does not retry payloads that can never succeed. Logs show payload **key names only**, never client data.

### Outbound — dashboard → Make / GHL

When `WEBHOOK_URL` is set, the dashboard POSTs one JSON event after each change made in it:

`opportunity.created` · `opportunity.moved` · `opportunity.assigned` · `opportunity.deleted` ·
`opportunity.transferred` · `field.changed` · `note.added` · `follower.added` · `follower.removed`

```json
{ "event": "opportunity.moved", "at": "2026-11-20T12:00:00.000Z",
  "actor": { "userId": "…", "name": "…" },
  "opportunityId": "…", "contactId": "…", "locationId": "…",
  "data": { "...": "event-specific fields" } }
```

Headers: `X-MM-Event`, and when a secret is set `X-MM-Secret` + `X-MM-Signature: sha256=…` (HMAC of the body) so
the receiver can verify it. Sending is **fire-and-forget** with a 5-second limit: a failed webhook is logged and
never fails the user's save. Change the receiver by changing `WEBHOOK_URL` — no redeploy of code needed.

## 4. Environment variables

Copy `.env.example` to `.env.local` for local work; set the same variables in Vercel → Project → Settings →
Environment Variables. **Never commit real values.**

| Variable | Required | Purpose |
|---|---|---|
| `GHL_PIT` | ✅ | Private Integration Token of this sub-account (server only) |
| `GHL_LOCATION_ID` | ✅ | This sub-account's location ID |
| `GHL_SSO_SECRET` | ✅ deployed | Marketplace app Shared Secret for SSO |
| `WEBHOOK_SECRET` | ✅ for webhooks | Shared secret for inbound and outbound webhooks |
| `WEBHOOK_URL` | – | Receiver for outbound events (empty = off) |
| `PIPELINE_IDS` | – | Client pipelines shown, in order (default: the five listed above) |
| `CAREGIVER_PIPELINE_IDS` | – | Caregiver pipelines (kept out of the client views) |
| `PIPELINE_ACCESS_MAP` | – | `userId:pipelineId\|pipelineId,…` — each user's division (fails closed) |
| `CAREGIVER_ASSOCIATION_ID` | – | Caregiver ↔ client association |
| `RESOURCES_FOLDER_ID` / `RESOURCES_PUBLIC_FOLDER_ID` | – | Resources media folder / one folder everyone can see |
| `NEXT_PUBLIC_GHL_LOCATION_ID` | – | Location ID for GHL deep links in the browser (not secret) |
| `NEXT_PUBLIC_PRIVATE_PAY_PIPELINE_ID` | – | Private Pay pipeline, for its badge |
| `NEW_LEAD_SINCE` | – | Date from which unopened cases get the "new lead" label |
| `GHL_EMAIL_FROM`, `GHL_EMAIL_API_VERSION` | – | Email sending address / Version header |
| `GHL_API_VERSION`, `GHL_API_BASE`, `GHL_AUTH_SCHEME` | – | API overrides (defaults work) |
| `PEER_PIT`, `PEER_LOCATION_ID`, `PEER_LABEL` | – | The other company's account, for transfers |
| `SSO_PROBE` | – | `1` = log decrypted SSO sessions (debug only) |

## 5. Run, check, deploy

```bash
npm install
cp .env.example .env.local      # then fill it in
npm run dev                     # http://localhost:3000  (outside GHL there is no SSO: open mode)
npm run build
```

Deploy: push to `master` → Vercel builds and deploys. Then open the Custom Page in GHL and check that the SSO
user and role are right.

## 6. Security and handover

- Tokens and secrets live only in `.env.local` and Vercel. They are never sent to the browser.
- Do not commit exports, backups or test files with client data (CSV / JSON exports, logs, screenshots).
- When ownership changes: create **new** `GHL_PIT`, `PEER_PIT`, `GHL_SSO_SECRET` and `WEBHOOK_SECRET` (and update
  the workflows' webhook headers), then transfer the GitHub repo, the Vercel project and the GHL marketplace app.
