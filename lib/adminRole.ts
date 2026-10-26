// ---------------------------------------------------------------------------
// ROUND 180 · WHO IS AN ADMIN — ONE RULE, USED BY THE SERVER AND THE BROWSER.
//
// 🔴 THE AGENCY OWNER WAS TREATED AS A REP. GoHighLevel's sign-in sends the
// Agency Owner as `role: "owner"`, confirmed live on 26 Oct 2026: John Ratigan's
// own dashboard read "Signed in · John Ratigan · owner". The dashboard accepted
// only "admin", so the person with the MOST authority in GoHighLevel got the
// least in the dashboard — no pipelines, no admin screens, 0 of 1,382 records.
//
// In GoHighLevel the owner holds everything an Agency Admin holds and more
// (ownership transfer, account-level actions). There is no owner tier in this
// dashboard; admin is the whole of it. So "owner" is an admin here.
//
// ⚠️ ONE FILE ON PURPOSE. The rule used to be written out in three places —
// lib/visibility.ts (server), page.tsx (browser) and PipelineAccessTab.tsx
// (labels) — and they could drift: fixing only the server would still have
// hidden the admin screens in the browser. Those three now call this.
//
// ⚠️ NO IMPORTS. page.tsx and PipelineAccessTab.tsx run in the browser;
// lib/visibility.ts pulls in node:async_hooks and cannot be imported there.
//
// ⚠️ STILL ROLE ONLY. `type` ("agency"/"account") is NOT permission — an
// agency-type user with role "user" is a rep (see lib/visibility.ts).
// ---------------------------------------------------------------------------

/** The SSO / Users API roles that get full admin access in this dashboard. */
export const ADMIN_ROLES: readonly string[] = ["admin", "owner"];

export function isAdminRole(role: unknown): boolean {
  return typeof role === "string" && ADMIN_ROLES.includes(role);
}
