/**
 * core-probes.ts — The brainstem's checks on the cognitive core itself.
 *
 * Lumina spec §3.1 and §124 (self-diagnostics): awareness, network, energy,
 * durable stores, the audit chain, the body, privacy and the model, each
 * checked without a language model. Sensors and safeguards bring their own
 * probes; the runtime puts them all on one brainstem.
 */
import type { EnvironmentSnapshot } from "../awareness/snapshot.js";
import type { SimulatedRobot } from "../embodiment/simulated-robot.js";
import type { PrivacyState } from "../privacy/privacy-state.js";
import type { AuditLog } from "../safety/audit-log.js";
import type { Probe, ProbeResult } from "./brainstem.js";
import type { EnergyAdvice } from "./energy.js";

const probe = (name: string, critical: boolean, check: () => ProbeResult): Probe => ({
  name,
  critical,
  check,
});

const on = (v: boolean) => (v ? "on" : "off");

function snapshotProblem(env: EnvironmentSnapshot | null, now: number): string | undefined {
  if (!env) {
    return "No environment snapshot yet.";
  }
  const ageMs = now - Date.parse(env.atISO);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "Environment snapshot has an invalid or future timestamp.";
  }
  return ageMs > 5 * 60_000
    ? `Environment snapshot is ${Math.round(ageMs / 60_000)} min old.`
    : undefined;
}

export function coreProbes(deps: {
  readonly environment: () => EnvironmentSnapshot | null;
  readonly energy: () => EnergyAdvice;
  /** With a body, running out of energy is critical. */
  readonly hasBody: boolean;
  /** Whether every cognitive store survives a restart. */
  readonly persistent: boolean;
  readonly audit: AuditLog;
  readonly robot: SimulatedRobot | undefined;
  readonly privacy: () => PrivacyState;
  readonly activeModel?: () => string | undefined;
  readonly now: () => number;
}): Probe[] {
  return [
    probe("awareness", false, () => {
      const problem = snapshotProblem(deps.environment(), deps.now());
      return problem
        ? {
            status: "degraded",
            detail: problem,
            recommendation: "Check the awareness poller.",
          }
        : { status: "ok", detail: "Environment snapshot is current." };
    }),
    probe("network", false, () => {
      const env = deps.environment();
      const problem = snapshotProblem(env, deps.now());
      if (problem || !env) {
        return {
          status: "degraded",
          detail: `Connectivity is unverified: ${problem}`,
          recommendation: "Check the awareness poller.",
        };
      }
      return env.network.online === false
        ? {
            status: "degraded",
            detail: "Offline: cloud models and messaging may fail; local functions continue.",
            recommendation: "Check the connection.",
          }
        : { status: "ok", detail: "Online in the current environment snapshot." };
    }),
    probe("energy", deps.hasBody, () => {
      const advice = deps.energy();
      const status =
        advice.level === "critical"
          ? "down"
          : advice.level === "low"
            ? "degraded"
            : advice.level === "unknown"
              ? "absent"
              : "ok";
      return {
        status,
        detail: advice.detail,
        ...(advice.action !== "none" ? { recommendation: advice.action } : {}),
      };
    }),
    probe("stores", false, () =>
      deps.persistent
        ? {
            status: "ok",
            detail:
              "Safety, world, goals, lessons and episodic memory persist in SQLite plugin state.",
          }
        : {
            status: "degraded",
            detail: "One or more cognitive stores are session-only and will not survive a restart.",
            recommendation: "Run inside the gateway with plugin state available.",
          },
    ),
    probe("audit", true, () => {
      const v = deps.audit.verify();
      return v.ok
        ? { status: "ok", detail: `Audit chain intact (${v.entries} entries).` }
        : {
            status: "down",
            detail: `Audit chain broken at entry ${v.brokenAt}: ${v.reason}.`,
            recommendation: "Treat as tampering; a person must review.",
          };
    }),
    probe("body", false, () => {
      if (deps.robot) {
        const health = deps.robot.health();
        return { status: health.status, detail: health.detail };
      }
      return deps.hasBody
        ? {
            status: "degraded",
            detail: "A body adapter is configured, but this probe has no health telemetry for it.",
          }
        : { status: "absent", detail: "No body: this is a desktop." };
    }),
    probe("privacy", false, () => {
      const p = deps.privacy();
      return {
        status: "ok",
        detail: `microphone ${on(p.microphone)}, camera ${on(p.camera)}, recording ${on(p.recording)}, private mode ${on(p.privateMode)}`,
      };
    }),
    probe("model", false, () => {
      const model = deps.activeModel?.();
      return model
        ? { status: "ok", detail: `Active model: ${model}.` }
        : {
            status: "degraded",
            detail: "No active model reported: reasoning may be unavailable.",
            recommendation: "Check the agent model configuration.",
          };
    }),
  ];
}
