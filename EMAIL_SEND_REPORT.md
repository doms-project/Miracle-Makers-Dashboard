# Build Report — Task 5: Email-send button (domain-gated)

**Feature:** Send a templated email to the client and/or caregivers from the enrollment record.
**Status:** ✅ Built · `next build` compiles clean · committed (`a3fafd4`). **Ready-and-waiting** — works the moment the sending domain is authenticated.
**Date:** 2026-08-07

---

## What Lamarr asked for → what shipped

> "a button… to send out generated responses… drop down box to email caregiver and client same message… email multiple ppl… at least 10 emails that stay in rotation."

- ✅ **Send Email button** on the enrollment panel (visible only for records the viewer can act on).
- ✅ **Recipient multi-select** — client + associated caregivers (from Task 4), each with email shown; plus a **cc** field for additional relatives.
- ✅ **Same message to multiple recipients** in one send.
- ✅ **~10 rotating templates** (config-based, editable before sending).
- ✅ **Confirm-before-send** with recipient list + preview; **per-recipient success/failure**.

---

## How it works

### Recipients
`GET /api/opportunities/[id]/email` returns the **client** (the opportunity's contact) and the **caregivers** (from the caregiver_client associations), each with name + email. The composer pre-selects the client; the user ticks whoever else should receive it and can add cc emails.

### Templates ("10 rotating emails")
Stored in **`lib/emailTemplates.ts`** as `{ id, name, subject, body }` — 10 slots with placeholder copy for **Jack/Lamarr to replace**. Templates support tokens filled at populate time:
`{{clientFirst}} {{clientLast}} {{clientName}} {{caregiverName}} {{office}} {{stage}}`.
Picking a template fills subject + body; both remain **editable** before sending (not purely canned).

> Config vs live: GHL template listing via the PIT isn't confirmed API-listable, so config is the source of truth. If the probe shows templates ARE listable, we can merge live templates later — no rework to the send path.

### Send (server-side, gated)
`POST /api/opportunities/[id]/email` → decrypt SSO → **re-check visibility** (own/follow/admin, else 403) → send to each selected recipient via `sendEmail()` (`POST /conversations/messages`, `type: "Email"`), applying cc. Returns **per-recipient** `{ name, ok, error }`. An auth/scope failure (401/403) stops and surfaces a clear message rather than partial noise.

### Permissions
Same visibility model as the rest of the app — reps on records they own/follow, admins on all. Enforced **server-side**, not just hidden in the UI.

---

## STEP 5 — the domain caveat (built in)

The composer shows a persistent banner:

> ⚠️ Deliverability depends on the Miracle Makers sending domain being authenticated (SPF/DKIM/DMARC). Until then, messages may land in spam. Avoid bulk test sends to real addresses.

The code is fully functional; only **deliverability** is gated on Jack's DNS work. **Do not** bulk-test to real addresses before the domain is authenticated (hurts sender reputation) — use one internal address or a mail-tester once it's ready.

---

## The one API unknown (Step 0 — verify live)

I couldn't reach GHL from here, so confirm with the probe:

```bash
$env:GHL_PIT="pit-..."
$env:PROBE_CONTACT_ID="<a TEST contact you control>"   # ⚠️ this sends one real email
node scripts/email-probe.mjs
```

Report back:
1. **Send endpoint** — the HTTP status + response keys from `POST /conversations/messages` (so `sendEmail()` reads the right id field). If it 401/403, the PIT needs the **conversations/email send** scope.
2. **Templates API-listable?** — whether either template-list call returned 200. Decides if we keep config-only or add live templates.

I'll lock the exact send shape from that. If the endpoint differs on your tenant, it's a small change in `lib/ghl.ts` → `sendEmail()`.

---

## Files

| File | Change |
|---|---|
| `lib/emailTemplates.ts` | **NEW** — 10 config templates + tokens |
| `lib/ghl.ts` | `sendEmail()`, `getContactBrief()` |
| `lib/types.ts` | `EmailRecipient`, `EmailSendResult` |
| `app/api/opportunities/[id]/email/route.ts` | **NEW** — GET recipients+templates, POST send |
| `components/EmailComposer.tsx` | **NEW** — the composer modal |
| `app/page.tsx` | Send Email button + composer wiring |
| `app/globals.css` | Composer styles |
| `scripts/email-probe.mjs` | **NEW** — Step-0 send/template probe |

---

## Where the build stands now

**All 5 client-requested features are built:** Resources (upload/preview/search), Bulk Import (wizard), Caregiver-in-list, Multiple Caregivers, Email.

Remaining is **not code**:
- **Jack / DNS:** authenticate the sending domain (unblocks email deliverability).
- **Jack / Lamarr:** the **10 real email texts** to drop into `lib/emailTemplates.ts`.
- **Live verification:** run the probes (upload-folder, associations, email), the restricted-user visibility test.
- **Client decisions:** field-removal list, source-tagging, roster; HIPAA/BAA for go-live.

**To push:** `git push origin HEAD:master`.
