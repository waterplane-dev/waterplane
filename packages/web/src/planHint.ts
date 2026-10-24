/** The plan's foot line. A source backend's plan has no file (`path: ""`), so nothing is named. */
export function planHint(plan: { path: string; cut?: boolean }): string | null {
  const where = plan.path ? plan.path.replace(/^\/(Users|home)\/[^/]+/, "~") : null;
  if (plan.cut) return `longer than the host sends${where ? ` — the rest is in ${where}` : ""}`;
  return where ? `from ${where}` : null;
}
