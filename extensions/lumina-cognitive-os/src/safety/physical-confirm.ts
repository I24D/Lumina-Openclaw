/**
 * physical-confirm.ts — Approve a physical action with the real keyboard.
 *
 * Lumina spec §44 and §143. The Lumina tab confirms physical actions over an
 * operator session, which software driving a browser could in principle reach.
 * This channel cannot be driven by software: the `physical_confirm.py` sidecar
 * listens to Windows' low-level keyboard hook and ignores injected key presses,
 * so Ctrl+Alt+Y (approve) or Ctrl+Alt+N (refuse) counts only when a person
 * presses it. The oldest waiting physical action is armed; the answer goes
 * through the controller's normal owner approval, which still re-checks the
 * situation and never turns a deny into an allow.
 */
import type { EmbodiedController } from "../embodiment/embodied-controller.js";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import type { AuditLog } from "./audit-log.js";

export type ConfirmEvent =
  | { readonly kind: "start"; readonly atISO: string }
  | {
      readonly kind: "confirmed";
      readonly requestId: string;
      readonly approve: boolean;
      readonly atISO: string;
    }
  | { readonly kind: "injected_ignored"; readonly atISO: string }
  | { readonly kind: "error"; readonly atISO: string; readonly message: string };

export type ConfirmPort = {
  start(): { readonly ok: boolean; readonly error?: string };
  stop(): void;
  running(): boolean;
  send(command: Readonly<Record<string, unknown>>): boolean;
  on(listener: (event: ConfirmEvent | SidecarExit) => void): () => void;
};

export const PHYSICAL_CONFIRM_KEYS = { approve: "Ctrl+Alt+Y", reject: "Ctrl+Alt+N" } as const;

export function attachPhysicalConfirm(deps: {
  readonly port: ConfirmPort;
  readonly body: Pick<EmbodiedController, "pending" | "approve" | "reject">;
  readonly audit: Pick<AuditLog, "append">;
  /** Tells people what to press; transparency panel and logs. */
  readonly notify?: (message: string) => void;
  readonly checkEveryMs?: number;
  readonly onError?: (error: unknown) => void;
}): {
  readonly armed: () => string | undefined;
  readonly health: () => { readonly running: boolean; readonly lastError?: string };
  readonly detach: () => void;
} {
  let armed: string | undefined;

  const detachEvents = deps.port.on((event) => {
    if (event.kind === "injected_ignored") {
      deps.audit.append({
        actor: "physical-confirm",
        action: "body.confirm.injected",
        reason: "A software-injected key press tried to answer a physical confirmation; ignored.",
        execution: "refused",
      });
    } else if (event.kind === "confirmed" && event.requestId === armed) {
      armed = undefined;
      const by = { channel: "owner", actor: "physical-key" } as const;
      void (async () => {
        try {
          if (event.approve) {
            await deps.body.approve(event.requestId, by);
          } else {
            deps.body.reject(event.requestId, { actor: by.actor });
          }
        } catch (error) {
          deps.onError?.(error);
        }
      })();
    } else if (event.kind === "exit") {
      armed = undefined;
    }
  });

  let lastError: string | undefined;
  const check = () => {
    if (!deps.port.running()) {
      const started = deps.port.start();
      if (!started.ok) {
        lastError = started.error;
        return;
      }
      lastError = undefined;
    }
    const oldest = deps.body.pending()[0];
    if (oldest?.id === armed) {
      return;
    }
    if (!oldest) {
      armed = undefined;
      deps.port.send({ cmd: "disarm" });
      return;
    }
    if (deps.port.send({ cmd: "arm", requestId: oldest.id })) {
      armed = oldest.id;
      deps.notify?.(
        `Physical action waiting (${oldest.intent.type}): press ${PHYSICAL_CONFIRM_KEYS.approve} to approve or ${PHYSICAL_CONFIRM_KEYS.reject} to refuse, on the real keyboard.`,
      );
    }
  };
  check();
  const timer = setInterval(check, deps.checkEveryMs ?? 1_000);
  timer.unref?.();

  return {
    armed: () => armed,
    /** Whether the keyboard listener runs, and why not when it does not. */
    health: () => ({ running: deps.port.running(), ...(lastError ? { lastError } : {}) }),
    detach: () => {
      clearInterval(timer);
      detachEvents();
      deps.port.stop();
    },
  };
}
