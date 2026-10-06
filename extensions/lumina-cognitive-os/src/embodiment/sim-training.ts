/**
 * sim-training.ts — Learning to move, only in simulation (Lumina spec §133).
 *
 * Runs `sidecars/sim_training.py`: domain-randomized MuJoCo episodes, the
 * cross-entropy method over the navigation policy, and an evaluation against
 * the hand-tuned default on held-out rooms. The report says whether the
 * learned policy was accepted (more goals or as many, no person touched, no
 * less room kept from people, no more obstacles hit); only an accepted policy
 * is handed to the simulated body. A person starts training from the Lumina
 * tab; nothing here ever reaches a physical body.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pickPython, resolveSidecarScriptPath } from "../shared/python.js";

export type SimEvaluation = {
  readonly episodes: number;
  readonly successRate: number;
  readonly personContacts: number;
  readonly obstacleContacts: number;
  readonly meanSeconds: number;
  readonly minPersonM: number | null;
};

export type SimReport = {
  readonly atISO: string;
  readonly policy: Readonly<Record<string, number>>;
  readonly baseline: SimEvaluation;
  readonly learned: SimEvaluation;
  readonly accepted: boolean;
  readonly deployment: string;
};

export type SimTrainingStatus = {
  readonly running: boolean;
  readonly startedAtISO?: string;
  readonly progress?: { readonly iteration: number; readonly bestScore: number };
  readonly report?: SimReport;
  readonly error?: string;
};

export function createSimTraining(deps: {
  /** Where the report (and so the policy) is kept. */
  readonly dir: string;
  readonly now?: () => number;
  readonly spawnImpl?: typeof spawn;
}) {
  const now = deps.now ?? Date.now;
  const reportPath = path.join(deps.dir, "sim-policy.json");
  let status: SimTrainingStatus = { running: false };
  try {
    status = {
      running: false,
      report: JSON.parse(fs.readFileSync(reportPath, "utf8")) as SimReport,
    };
  } catch {
    // No training has run yet.
  }

  return {
    status: (): SimTrainingStatus => structuredClone(status),
    /** The policy file the simulated body may load: only an accepted one. */
    policyPath: (): string | undefined => (status.report?.accepted ? reportPath : undefined),
    start(): { readonly started: boolean; readonly reason?: string } {
      if (status.running) {
        return { started: false, reason: "Training is already running." };
      }
      fs.mkdirSync(deps.dir, { recursive: true });
      const startedAtISO = new Date(now()).toISOString();
      status = { running: true, startedAtISO, ...(status.report ? { report: status.report } : {}) };
      const child = (deps.spawnImpl ?? spawn)(
        pickPython(),
        [resolveSidecarScriptPath("sim_training"), "--out", reportPath],
        {
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
        },
      );
      let buffer = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line) as { kind?: string } & Record<string, unknown>;
            if (event.kind === "progress") {
              status = {
                ...status,
                progress: {
                  iteration: Number(event.iteration),
                  bestScore: Number(event.bestScore),
                },
              };
            } else if (event.kind === "report") {
              status = { ...status, report: event as unknown as SimReport };
            }
          } catch {
            // Not a protocol line.
          }
          newline = buffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_000);
      });
      child.on("error", (error) => {
        status = { ...status, running: false, error: error.message };
      });
      child.on("exit", (code) => {
        status = {
          ...status,
          running: false,
          ...(code === 0
            ? {}
            : { error: stderr.trim().split(/\r?\n/u).at(-1) ?? `training exited with ${code}` }),
        };
      });
      return { started: true };
    },
  };
}

export type SimTraining = ReturnType<typeof createSimTraining>;
