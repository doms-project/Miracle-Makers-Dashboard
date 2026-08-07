# Build Report — Email templates live from GHL

**Change:** Replace the config-file templates with **live GHL email templates** (config kept as fallback).
**Status:** ✅ Built · `next build` compiles clean · committed (`07e36d0`).
**Date:** 2026-08-07

---

## What changed

Templates now come from **GoHighLevel's native email builder** — Jack's team manages them there, self-service, and the dashboard pulls them into the composer live. **No code change to add/edit templates ever again.** The config file (`lib/emailTemplates.ts`) stays as a **safety-net fallback** so the feature never comes up empty.

### Step 1 — pull templates
- `listEmailTemplates()` → `GET /locations/{locationId}/templates?type=email` (PIT, server-side), normalizes each template to `{ id, name, subject, body }` (body = HTML from the builder). Tolerates shape variance across tenants.

### Step 2 — composer wired to GHL
- The email composer lists **GHL templates** instead of the config file. A badge shows the source: **"live from GoHighLevel"** vs **"config fallback"**.
- Picking a template populates subject + body; **still editable** before send.
- Existing token replacement (`{{clientFirst}}`, `{{caregiverName}}`, …) is applied to the pulled body when tokens are present.
- HTML template bodies render in the **preview** (builder output shows as a real email, not raw tags).

### Step 3 — send (Option B: edited HTML)
- `sendEmail()` now POSTs to `/conversations/messages/outbound` with `emailSubject` + `emailBody` (the edited HTML), optional `emailFrom`, and optional `templateId` (Option A path kept for later). Uses the **email Version header**.
- The route sends HTML **as-is** when the body looks like HTML, else converts plain-text newlines to `<br>`.
- Send flow unchanged: decrypt SSO → **visibility re-check** (own/follow/admin, else 403) → send per recipient → **per-recipient success/failure**.

### Step 4 — fallback / migration
- If the GHL templates call fails or returns none → **config fallback** (`templatesSource: "config"`). If GHL returns templates → prefer those (`"ghl"`). The feature can't break either way.

### Step 5 — domain caveat (unchanged)
- The deliverability banner stays. Email needs the **authenticated sending domain** + a **verified `emailFrom`**.

---

## Two new env vars (overridable — no code change)

| Var | Default | Why |
|---|---|---|
| `GHL_EMAIL_API_VERSION` | `2021-04-15` | GHL documents the templates + outbound-send endpoints against this Version (different from the `2021-07-28` the rest of the API uses). Override if the tenant wants another. |
| `GHL_EMAIL_FROM` | *(blank)* | Verified sending address for outbound email. Set once the domain is authenticated; blank = GHL uses the sub-account default. |

---

## Step 0 — confirm live before trusting (probe included)

Run the probe and paste output — it covers all three unknowns from your brief:

```bash
$env:GHL_PIT="pit-..."
$env:PROBE_CONTACT_ID="<TEST contact>"        # optional — sends one real email
$env:PROBE_EMAIL_FROM="verified@domain"       # optional — verified sender
node scripts/email-templates-probe.mjs
```

Report:
1. **Templates list** — which **Version** returned 200, and each template's `id / name / subject / html` field names. (401 → PIT needs **templates read** scope.)
2. **Send** — which **Version** the `/conversations/messages/outbound` call accepts (2021-04-15 vs 2021-07-28), the response id field, and whether **`emailFrom` was required** (400 without it?).

From that I lock: the Version (`GHL_EMAIL_API_VERSION`), the template field mapping in `listEmailTemplates()`, and whether we must set `GHL_EMAIL_FROM` before any send works.

---

## Files

| File | Change |
|---|---|
| `lib/ghl.ts` | `listEmailTemplates()`; `sendEmail()` → outbound endpoint + Version + emailFrom + templateId; `headers(version?)` |
| `app/api/opportunities/[id]/email/route.ts` | GET returns live templates + `templatesSource` (config fallback); POST HTML-aware + templateId |
| `components/EmailComposer.tsx` | Source badge; HTML preview rendering |
| `.env.example` | `GHL_EMAIL_API_VERSION`, `GHL_EMAIL_FROM` |
| `scripts/email-templates-probe.mjs` | **NEW** — Step-0 probe |

---

## The email dependency chain (honest)

For email to fully work end-to-end:
1. **Domain authenticated** (Jack/DNS) → enables a verified `emailFrom` + real deliverability.
2. **Templates exist in GHL** (Jack/Lamarr build them in the builder) — or the config fallback carries the 10 texts.
3. **Step-0 probe** confirms the endpoints/scopes/Version on the tenant.

Code is ready for all three. **Push:** `git push origin HEAD:master`.
