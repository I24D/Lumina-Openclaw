/**
 * powershell.ts
 * Utility for running PowerShell commands on Windows.
 * On non-Windows platforms the functions return a "not supported" error
 * so the extension degrades gracefully without crashing the gateway.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PsResult = {
  stdout: string;
  stderr: string;
  ok: boolean;
  error?: string;
};

const PS_EXEC =
  process.platform === "win32"
    ? "powershell.exe"
    : "/usr/bin/env"; // stub for non-Windows (will fail gracefully)

const PS_BASE_ARGS =
  process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
    : ["echo"]; // stub

/**
 * Run a PowerShell command and return stdout/stderr.
 * Times out after `timeoutMs` milliseconds (default 15 s).
 */
export async function runPowerShell(
  command: string,
  timeoutMs = 15_000,
): Promise<PsResult> {
  if (process.platform !== "win32") {
    return {
      stdout: "",
      stderr: "",
      ok: false,
      error: "PowerShell commands are only available on Windows.",
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(PS_EXEC, [...PS_BASE_ARGS, command], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      stdout: e.stdout?.trim() ?? "",
      stderr: e.stderr?.trim() ?? "",
      ok: false,
      error: e.message,
    };
  }
}

/**
 * Escape a string so it is safe to embed inside a PowerShell double-quoted string.
 */
export function psEscape(value: string): string {
  return value
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')
    .replace(/\n/g, "`n")
    .replace(/\r/g, "`r");
}
