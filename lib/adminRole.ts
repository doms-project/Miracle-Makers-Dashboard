export const ADMIN_ROLES: readonly string[] = ["admin", "owner"];

export function isAdminRole(role: unknown): boolean {
  return typeof role === "string" && ADMIN_ROLES.includes(role);
}
