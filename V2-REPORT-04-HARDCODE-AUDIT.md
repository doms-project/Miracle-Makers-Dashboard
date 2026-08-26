# v2 — Hardcoded-ID audit + cleanup

**Branch:** `v2-multi-pipeline`  •  **Date:** 2026-08-26  •  Build: clean.

Grep across `app/ lib/ components/ scripts/` for every location, pipeline, user, folder, and association literal.

## Result by category

| Category | Status |
|---|---|
| **User IDs** | ✅ none in code (only in `.env.example`) |
| **Old account `YVPhIAECw9q1M9Jw6A8L`** | ✅ none anywhere (was in 6 probes → fixed) |
| **Old folder/association `6a75…`/`6a6e…`** | ✅ removed as fallbacks (1 doc-note reference remains in the re-derive probe help text) |
| **Location (app)** | env-first: `NEXT_PUBLIC_GHL_LOCATION_ID` with a **new-account** default |
| **Pipeline IDs** | config only: `DEFAULT_PIPELINE_IDS` (allowlist default, env-overridable) + `fieldFolders.ts` (field-set config) |
| **Folder/Association (app)** | env-only now — `RESOURCES_FOLDER_ID`/`CAREGIVER_ASSOCIATION_ID` default `""` (fail-visible) |

## What is intentionally hardcoded (and why it's correct)

- **`DEFAULT_PIPELINE_IDS` (lib/ghl.ts)** — the default value of the `PIPELINE_IDS` **allowlist**. Env overrides it. The brief wants a default so the app runs without env, and the allowlist is deliberate scope (a new pipeline shouldn't auto-surface).
- **`lib/fieldFolders.ts`** — `FOLDERS`, `PIPELINE_FOLDERS`, `LOST_REASON_OVERRIDES` are the **field-set configuration**, structurally keyed to pipeline + folder ids. This is config, not a secret/account key. Direction #3's move to name/key resolution is a future refactor, not this task.
- **Frontend location default** — a client component needs a default if `NEXT_PUBLIC_GHL_LOCATION_ID` is unset; it is the **new** account and env-overridable.

## Fix diff (full)

```diff
diff --git a/lib/ghl.ts b/lib/ghl.ts
index 98e6693..6ecb769 100644
--- a/lib/ghl.ts
+++ b/lib/ghl.ts
@@ -5,8 +5,11 @@ import type {
 } from "./types";
 import { isFieldEditable } from "./editable";
 
+// Account-specific — MUST come from env (re-derive per account with
+// scripts/rederive-ids-probe.mjs). No stale fallback: an unset value fails
+// visibly rather than silently pointing at another account's folder.
 export const RESOURCES_FOLDER_ID = (
-  process.env.RESOURCES_FOLDER_ID || "6a75ea609994d35aa0c66e9a"
+  process.env.RESOURCES_FOLDER_ID || ""
 ).trim();
 
 // ---------------------------------------------------------------------------
@@ -988,8 +991,11 @@ export async function uploadResource(file: {
 // query params + delete shape live. Every helper surfaces a clear GhlError so a
 // PIT that lacks associations access fails loudly, not silently.
 // ---------------------------------------------------------------------------
+// Account-specific — MUST come from env (re-derive/create per account). No
+// stale fallback: an unset value fails visibly rather than pointing at another
+// account's association.
 export const CAREGIVER_CLIENT_ASSOCIATION_ID = (
-  process.env.CAREGIVER_ASSOCIATION_ID || "6a6e26c9884def7a1438b965"
+  process.env.CAREGIVER_ASSOCIATION_ID || ""
 ).trim();
 
 export interface CaregiverRelation {
diff --git a/scripts/associations-probe.mjs b/scripts/associations-probe.mjs
index 2c3e9d9..b363884 100644
--- a/scripts/associations-probe.mjs
+++ b/scripts/associations-probe.mjs
@@ -13,8 +13,8 @@
  */
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
-const ASSOC = (process.env.CAREGIVER_ASSOCIATION_ID || "6a6e26c9884def7a1438b965").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
+const ASSOC = (process.env.CAREGIVER_ASSOCIATION_ID || "").trim();
 const CLIENT = (process.env.PROBE_CLIENT_CONTACT_ID || "").trim();
 if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
 
diff --git a/scripts/email-probe.mjs b/scripts/email-probe.mjs
index be918e2..c3b03fb 100644
--- a/scripts/email-probe.mjs
+++ b/scripts/email-probe.mjs
@@ -14,7 +14,7 @@
  */
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
 const CONTACT = (process.env.PROBE_CONTACT_ID || "").trim();
 if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
 
diff --git a/scripts/email-templates-probe.mjs b/scripts/email-templates-probe.mjs
index 24c1037..be8df3e 100644
--- a/scripts/email-templates-probe.mjs
+++ b/scripts/email-templates-probe.mjs
@@ -14,7 +14,7 @@
  */
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
 const CONTACT = (process.env.PROBE_CONTACT_ID || "").trim();
 const FROM = (process.env.PROBE_EMAIL_FROM || "").trim();
 if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
diff --git a/scripts/resources-probe.mjs b/scripts/resources-probe.mjs
index 11bddb3..38aaeee 100644
--- a/scripts/resources-probe.mjs
+++ b/scripts/resources-probe.mjs
@@ -10,8 +10,8 @@
  */
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
-const FOLDER = (process.env.RESOURCES_FOLDER_ID || "6a75ea609994d35aa0c66e9a").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
+const FOLDER = (process.env.RESOURCES_FOLDER_ID || "").trim();
 if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
 
 const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
diff --git a/scripts/resources-upload-probe.mjs b/scripts/resources-upload-probe.mjs
index 07433fb..c1680a5 100644
--- a/scripts/resources-upload-probe.mjs
+++ b/scripts/resources-upload-probe.mjs
@@ -12,8 +12,8 @@
  */
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
-const FOLDER = (process.env.RESOURCES_FOLDER_ID || "6a75ea609994d35aa0c66e9a").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
+const FOLDER = (process.env.RESOURCES_FOLDER_ID || "").trim();
 if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
 
 const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
diff --git a/scripts/step0-write-test.mjs b/scripts/step0-write-test.mjs
index 4e1f2db..4e3af60 100644
--- a/scripts/step0-write-test.mjs
+++ b/scripts/step0-write-test.mjs
@@ -27,7 +27,7 @@
 
 const BASE = "https://services.leadconnectorhq.com";
 const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
-const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
+const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
 const OPP_ID = (process.env.OPP_ID || "").trim();
 const STAGE_NAME = (process.env.STAGE_NAME || "").trim();
 const ROADBLOCKER_VALUE = (process.env.ROADBLOCKER_VALUE || "Awaiting docs").trim();
```
