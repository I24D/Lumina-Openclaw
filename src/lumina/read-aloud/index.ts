import { formatErrorMessage } from "../../infra/errors.js";
// Public entry point for the Lumina read-aloud pipeline.
//
// Start Talk reads out loud what the other assistants answer (Claude Code, Codex and
// the OpenClaw chat) plus the Windows toasts the user cares about, notably Phone
// Link. One singleton per gateway process; starting twice is a no-op.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isReadAloudEnabled, startReadAloudService, type ReadAloudService } from "./service.js";

const log = createSubsystemLogger("lumina/read-aloud");

let running: ReadAloudService | undefined;

/** Starts the pipeline unless `LUMINA_READ_ALOUD` turns it off. */
export function startLuminaReadAloud(
  env: NodeJS.ProcessEnv = process.env,
): ReadAloudService | null {
  if (running) {
    return running;
  }
  if (!isReadAloudEnabled(env.LUMINA_READ_ALOUD)) {
    log.info("read-aloud disabled by LUMINA_READ_ALOUD");
    return null;
  }
  try {
    running = startReadAloudService();
    return running;
  } catch (err: unknown) {
    // A broken read-aloud pipeline must never take the gateway down with it.
    log.warn(`read-aloud failed to start: ${formatErrorMessage(err)}`);
    running = undefined;
    return null;
  }
}

/** Stops the pipeline; used by tests and by a gateway shutdown. */
export function stopLuminaReadAloud(): void {
  running?.stop();
  running = undefined;
}

export type { ReadAloudService } from "./service.js";
