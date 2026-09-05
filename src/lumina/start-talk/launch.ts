// Launcher for the Lumina Start Talk desktop voice UI.
// Start Talk is the voice surface of the Lumina family, so the composer
// microphone hands voice off to that app instead of opening the browser Talk
// window. A browser cannot start a local process, so the Gateway owns the
// launch and this module owns everything about the install itself.
//
// Launching is unconditional: Start Talk claims a single instance of itself and
// raises its existing window, so a second launch is already the right answer to
// "show me the voice UI".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logInfo } from "../../logger.js";

const DEFAULT_START_TALK_DIR = "C:\\Lumina Start Talk\\Lumina Start talk";

type StartTalkInstall = {
  dir: string;
  entry: string;
  interpreter: string;
};

function startTalkDir(): string {
  return process.env.LUMINA_START_TALK_DIR?.trim() || DEFAULT_START_TALK_DIR;
}

/**
 * Prefers the app's own virtualenv — Start Talk pulls in sounddevice, comtypes
 * and the Gemini SDK, none of which a bare system Python is expected to have.
 * The windowless interpreter keeps a console from flashing behind the HUD.
 */
function resolveInterpreter(dir: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(dir, ".venv", "Scripts", "pythonw.exe"), join(dir, ".venv", "Scripts", "python.exe")]
      : [join(dir, ".venv", "bin", "python3"), join(dir, ".venv", "bin", "python")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveInstall(): StartTalkInstall | { error: string } {
  const dir = startTalkDir();
  if (!existsSync(dir)) {
    return { error: `Lumina Start Talk is not installed at ${dir}` };
  }
  const entry = join(dir, "main.py");
  if (!existsSync(entry)) {
    return { error: `Lumina Start Talk has no main.py in ${dir}` };
  }
  const interpreter = resolveInterpreter(dir);
  if (!interpreter) {
    return { error: `Lumina Start Talk has no virtualenv in ${dir}` };
  }
  return { dir, entry, interpreter };
}

export type LuminaStartTalkLaunch =
  | { status: "launched" }
  | { status: "unavailable"; reason: string };

/** Starts Start Talk detached, so the voice UI outlives the Gateway process. */
export function launchLuminaStartTalk(): LuminaStartTalkLaunch {
  const install = resolveInstall();
  if ("error" in install) {
    return { status: "unavailable", reason: install.error };
  }
  try {
    const child = spawn(install.interpreter, [install.entry], {
      cwd: install.dir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logInfo(`lumina start talk: launched from ${install.dir} (pid ${child.pid ?? "unknown"})`);
    return { status: "launched" };
  } catch (err) {
    return { status: "unavailable", reason: `Lumina Start Talk failed to start: ${String(err)}` };
  }
}

/**
 * Answers whether this host can run Start Talk at all, without starting it.
 * The composer primes this so a microphone click stays synchronous: deciding
 * between Start Talk and the browser Talk window inside an await would lose the
 * user activation the fallback window needs.
 */
export function luminaStartTalkAvailability(): { available: boolean; reason?: string } {
  const install = resolveInstall();
  return "error" in install ? { available: false, reason: install.error } : { available: true };
}
