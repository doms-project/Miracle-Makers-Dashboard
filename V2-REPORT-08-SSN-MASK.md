# v2 Build Report — Task 8: SSN masking

**Branch:** `v2-multi-pipeline`  •  **Date:** 2026-08-26  •  Build: clean.

You were right — SSN masking was never implemented. I raised it as decision #4, you answered "mask with reveal", and I dropped it. Built now as its own commit.

## The field
```
name='Social Security Number'  id=qkaqdaV3iZrJpYxenfn1  dataType=TEXT  parentId=KKiWnjidBN65xGhJESgc (Client Details)
```

## Behaviour

- Renders **`•••-••-2550`** — last 4 kept, which is what reps read back.
- **Show** reveals the normal editable control; **Hide** re-masks. Editing still works.
- Applies on the **read-only path** too (reveal still works there).
- Matched **by NAME** (`/social security/` or `/ssn/`), never a hardcoded field id — consistent with the project's name-based resolution, so a future "SSN" field is covered automatically.
- Short/odd values fall back to full-length dots rather than leaking a partial.

## The honest limitation (documented in the code)

🔴 **This is not a security boundary.** The value is in the API payload either way, so anyone with devtools can read it. Masking reduces **casual and screen-share** exposure only — which is exactly the concern the client raised. Actually withholding the value would have to happen **server-side** (omit or truncate the field for non-privileged viewers). Say the word if you want that as a follow-up.

---

```diff
diff --git a/app/globals.css b/app/globals.css
index 1c4e73a..2775714 100644
--- a/app/globals.css
+++ b/app/globals.css
@@ -400,3 +400,12 @@ button.rescard{width:100%;text-align:left;font:inherit;cursor:pointer;background
 .provenance{font-size:10.5px;color:var(--ink-3);font-style:italic;margin-top:2px;}
 .phead .provenance{margin-top:5px;font-style:normal;color:var(--wait);background:var(--wait-soft);border:1px solid #f0dcae;border-radius:6px;padding:3px 8px;display:inline-block;}
 .card .cdiv{margin-top:5px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);}
+
+/* ── Task 8: masked sensitive fields (SSN) ────────────────────── */
+.v.ro.masked{justify-content:space-between;gap:10px;}
+.maskval{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;}
+.maskbtn{flex:none;border:1px solid var(--line);border-radius:6px;padding:3px 10px;font-size:10.5px;font-weight:700;color:var(--ink-2);background:var(--bg);cursor:pointer;}
+.maskbtn:hover{border-color:var(--plum);color:var(--plum);}
+.maskedwrap{display:flex;align-items:flex-start;gap:8px;}
+.maskedwrap>:first-child{flex:1;}
+.maskedwrap .maskbtn{margin-top:9px;}
diff --git a/app/page.tsx b/app/page.tsx
index 0ec3508..9787855 100644
--- a/app/page.tsx
+++ b/app/page.tsx
@@ -244,6 +244,66 @@ function TextControl({
   );
 }
 
+// ---- Sensitive fields (Task 8) ----
+// SSN renders masked by default with click-to-reveal, so it isn't exposed in
+// screen-shares. Matched by NAME (never a hardcoded field id), consistent with
+// the rest of the field resolution.
+//
+// ⚠️ This is NOT a security boundary: the value is already in the API payload
+// either way, so anyone with devtools can read it. It reduces casual/shoulder
+// exposure only. Restricting who receives the value would have to happen
+// server-side.
+const isSensitiveField = (name: string): boolean =>
+  /social\s*security|(^|\W)ssn(\W|$)/i.test(name || "");
+
+// "123-45-2550" -> "•••-••-2550" (keeps the last 4, which is what reps read back).
+function maskSsn(raw: string): string {
+  const s = (raw || "").trim();
+  if (!s) return "";
+  const digits = s.replace(/\D/g, "");
+  if (digits.length < 4) return "•".repeat(s.length);
+  return `•••-••-${digits.slice(-4)}`;
+}
+
+function MaskedControl({
+  value,
+  disabled,
+  onSave,
+}: {
+  value: unknown;
+  disabled?: boolean;
+  onSave: (v: unknown) => void;
+}) {
+  const [revealed, setRevealed] = useState(false);
+  const raw = asStr(value);
+  if (!revealed) {
+    return (
+      <div className="v ro masked">
+        <span className="maskval">{raw ? maskSsn(raw) : "—"}</span>
+        <button
+          type="button"
+          className="maskbtn"
+          onClick={() => setRevealed(true)}
+        >
+          Show
+        </button>
+      </div>
+    );
+  }
+  return (
+    <div className="maskedwrap">
+      <TextControl value={value} disabled={disabled} onSave={onSave} />
+      <button
+        type="button"
+        className="maskbtn"
+        onClick={() => setRevealed(false)}
+      >
+        Hide
+      </button>
+    </div>
+  );
+}
+
 // One editable/read-only control chosen by the field's GHL dataType.
 function FieldControl({
   def,
@@ -258,8 +318,14 @@ function FieldControl({
 }) {
   const t = (def.dataType || "").toUpperCase();
   const disabled = save?.status === "saving";
+  const sensitive = isSensitiveField(def.name);
 
   if (!def.editable) {
+    // A read-only sensitive field is still masked (reveal shows the value).
+    if (sensitive)
+      return (
+        <MaskedControl value={value} disabled onSave={() => {}} />
+      );
     return (
       <div className="v ro">
         {asStr(value) || "—"}{" "}
@@ -272,7 +338,12 @@ function FieldControl({
     t === "SINGLE_OPTIONS" || t === "MULTIPLE_OPTIONS" || t === "CHECKBOX";
 
   let control: ReactNode;
-  if (isOptionType && def.options.length === 0) {
+  if (sensitive) {
+    // Masked with click-to-reveal, ahead of the dataType branches.
+    control = (
+      <MaskedControl value={value} disabled={disabled} onSave={onSave} />
+    );
+  } else if (isOptionType && def.options.length === 0) {
     control = (
       <div className="v ro">
         {asStr(value) || "—"}{" "}
```
