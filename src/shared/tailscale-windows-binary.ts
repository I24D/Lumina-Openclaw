/**
 * Lumina fork: Windows install roots for tailscale.exe, derived from the
 * environment rather than hardcoded so localized or relocated Program Files
 * still resolve.
 *
 * Windows does not put tailscale.exe on PATH by default, and a PATH edit never
 * reaches already-running processes: a gateway started by Task Scheduler keeps
 * the environment captured at service boot, so it never sees a later install.
 * A leaf module, so src/infra/tailscale.ts and src/shared/tailscale-status.ts
 * can both use it without importing each other.
 */
export function windowsTailscaleBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"];
  const candidates = new Set<string>();
  for (const root of roots) {
    if (!root?.trim()) {
      continue;
    }
    candidates.add(`${root.replace(/[\\/]+$/, "")}\\Tailscale\\tailscale.exe`);
  }
  return [...candidates];
}
