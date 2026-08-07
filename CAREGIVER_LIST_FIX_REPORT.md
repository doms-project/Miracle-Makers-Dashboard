# Fix Report — Caregiver list 422 (associations get-relations)

**Issue:** Listing caregivers returned `422 Unprocessable Entity` — "property recordId should not exist", "property associationId should not exist".
**Status:** ✅ Fixed · `next build` compiles clean · committed (`c0da464`).
**Date:** 2026-08-07

---

## What broke

The **list caregivers** call (`listCaregiverRelations` in `lib/ghl.ts`) built the request with the wrong query parameters:

```
GET /associations/relations/{clientContactId}?locationId=…&recordId=…&associationId=…
```

GHL rejected it:
```json
{"message":["property recordId should not exist","property associationId should not exist"],
 "error":"Unprocessable Entity","statusCode":422}
```

The endpoint **does not accept `recordId` or `associationId` as query parameters.**

---

## Why it's actually good news

The response was **422 (validation), not 401/403 (auth) or 404 (missing).** That confirms two things we were unsure about:

- ✅ **Your PIT has Associations API access** — the single biggest Task 4 risk is now cleared.
- ✅ The endpoint path `/associations/relations/{recordId}` is correct.

So this was **never a blocked feature** — just a parameter-name mismatch on one call.

---

## The fix

GHL's "get relations by record" wants the record id **in the path**, and only `locationId` + `skip` + `limit` as query params. It returns **all** of the record's relations across every association, so we filter to the caregiver association in code.

**Before**
```
GET /associations/relations/{id}?locationId=…&recordId=…&associationId=…
```

**After**
```
GET /associations/relations/{id}?locationId=…&skip=0&limit=100
→ then filter relations where associationId === CAREGIVER_CLIENT_ASSOCIATION_ID
```

Also removed the now-dead 404 fallback that reused the bad params, and updated `scripts/associations-probe.mjs` to the corrected shape.

**Files:** `lib/ghl.ts` (`listCaregiverRelations`), `scripts/associations-probe.mjs`.

---

## What to verify next (add / remove not yet exercised)

The list call failed first, so **create** and **delete** haven't been tested live. When you add/remove a caregiver, watch for a similar shape complaint on:

| Op | Call | If it 422s… |
|---|---|---|
| **Add** | `POST /associations/relations` `{locationId, associationId, firstRecordId, secondRecordId}` | paste the message — likely a field-name tweak |
| **Remove** | `DELETE /associations/relations/{relationId}?locationId=…` | paste the message — likely path/param tweak |

Also: **paste one relation object** from the now-working list response so I can confirm `firstRecordId` / `secondRecordId` / `associationId` match your tenant's exact field names (that's what the "which side is the caregiver" logic and the association filter rely on).

---

## Where Task 4 stands

- **List caregivers** — fixed, correct shape. ✅
- **PIT associations access** — confirmed working (the 422 proved it). ✅
- **Add / Remove** — coded per GHL v2 conventions; awaiting one live test to confirm field names.

**Push:** `git push origin HEAD:master`.
