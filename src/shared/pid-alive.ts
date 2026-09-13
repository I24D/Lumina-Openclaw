// PID liveness helpers check whether process ids still refer to active processes.
import childProcess from "node:child_process";
import fsSync from "node:fs";

const PROCESS_START_TIMEOUT_MS = 1000;
// Proving this process's own identity must not fail, and it happens once per
// process (the answer is cached), so it can afford PowerShell's slow cold start.
const SELF_PROCESS_START_TIMEOUT_MS = 10_000;

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Check if a process is a zombie on Linux by reading /proc/<pid>/status.
 * Returns false on non-Linux platforms or if the proc file can't be read.
 */
function isZombieProcess(pid: number): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const stateMatch = status.match(/^State:\s+(\S)/m);
    return stateMatch?.[1] === "Z";
  } catch {
    return false;
  }
}

/** Returns true only when a positive PID exists and is not a Linux zombie process. */
export function isPidAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the PID exists but we cannot signal it. Treat that as a
    // successful existence probe, then still apply the Linux zombie check.
    // Keep parity with isPidDefinitelyDead (EPERM is not "definitely dead").
    if ((err as NodeJS.ErrnoException).code !== "EPERM") {
      return false;
    }
  }
  return !isZombieProcess(pid);
}

/** Returns true only when the PID is invalid, missing, or known to be a Linux zombie. */
export function isPidDefinitelyDead(pid: number): boolean {
  if (!isValidPid(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
  return isZombieProcess(pid);
}

function getPlatformProcessStartTime(
  pid: number,
  timeoutMs = PROCESS_START_TIMEOUT_MS,
): number | null {
  try {
    const windows = process.platform === "win32";
    const command = windows ? `(Get-Process -Id ${pid}).StartTime.ToString('o')` : String(pid);
    const args = windows
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-o", "lstart=", "-p", command];
    const startedAt = childProcess
      .execFileSync(windows ? "powershell.exe" : "/bin/ps", args, {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: windows,
      })
      .trim();
    // Darwin's lstart output has no timezone. Force UTC for both ps and parsing so
    // a system timezone change cannot make a live lock owner look like PID reuse.
    const startedAtMs = Date.parse(windows ? startedAt : `${startedAt} UTC`);
    return Number.isFinite(startedAtMs) ? Math.floor(startedAtMs / (windows ? 1 : 1000)) : null;
  } catch {
    return null;
  }
}

/** Read the Linux procfs start identity used by Linux-owned runtime state. */
export function getProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid) || process.platform !== "linux") {
    return null;
  }
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEndIndex = stat.lastIndexOf(")");
    if (commEndIndex < 0) {
      return null;
    }
    // The comm field (field 2) is wrapped in parens and can contain spaces,
    // so split after the last ")" to get fields 3..N reliably.
    const afterComm = stat.slice(commEndIndex + 1).trimStart();
    const fields = afterComm.split(/\s+/);
    // field 22 (starttime) = index 19 after the comm-split (field 3 is index 0).
    const starttime = Number(fields[19]);
    return Number.isInteger(starttime) && starttime >= 0 ? starttime : null;
  } catch {
    return null;
  }
}

// Windows has no procfs or ps(1), so start times come from PowerShell, which takes
// most of a second to answer on a warm machine and longer while the Gateway boots.
// For other owners a timeout is harmless: null is the conservative "cannot prove
// it is stale" answer. For this process it is fatal: cron cannot claim a durable
// fence without its own identity, so every tick fails. Resolve self once, with
// room to wait, and cache it. PowerShell stays the first choice so the value
// matches what other processes read for this pid; process.uptime() lands a Node
// bootstrap delay later and would make a live owner look like PID reuse. It is
// only the fallback for a PowerShell that never answers at all.
let selfWindowsProcessStartTime: number | null = null;

function getSelfWindowsProcessStartTime(): number {
  selfWindowsProcessStartTime ??=
    getPlatformProcessStartTime(process.pid, SELF_PROCESS_START_TIMEOUT_MS) ??
    Math.floor(Date.now() - process.uptime() * 1000);
  return selfWindowsProcessStartTime;
}

/** Read a cross-platform process identity for filesystem lock ownership. */
export function getFileLockProcessStartTime(pid: number): number | null {
  if (!isValidPid(pid)) {
    return null;
  }
  if (process.platform === "win32" && pid === process.pid) {
    return getSelfWindowsProcessStartTime();
  }
  return process.platform === "darwin" || process.platform === "win32"
    ? getPlatformProcessStartTime(pid)
    : getProcessStartTime(pid);
}
