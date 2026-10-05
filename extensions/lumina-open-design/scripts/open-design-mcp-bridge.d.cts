import type { ChildProcess } from "node:child_process";

export type OpenDesignSpawnPlan = {
  command: string;
  args: string[];
  options: {
    cwd?: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: "ignore";
    windowsHide: boolean;
  };
};

export type OpenDesignDaemonDeps = {
  /** Starts a plan. Defaults to spawning it detached. */
  launch?: (plan: OpenDesignSpawnPlan) => unknown;
  /** Resolves the URL the desktop Studio publishes over its named pipe. */
  discoverDaemonUrl?: (timeoutMs?: number) => Promise<string>;
  /** Resolves the headless daemon URL when one is listening, else null. */
  probeHeadlessDaemon?: (timeoutMs?: number) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
};

export function isLoopbackUrl(value: string): boolean;
export function studioLaunchAllowed(env?: NodeJS.ProcessEnv): boolean;
export function headlessDaemonPlan(): OpenDesignSpawnPlan;
export function studioPlan(): OpenDesignSpawnPlan;
export function chooseLaunchPlan(env?: NodeJS.ProcessEnv): OpenDesignSpawnPlan;
export function launchHeadlessDaemon(): ChildProcess;
export function launchStudio(): ChildProcess;
export function discoverDaemonUrl(timeoutMs?: number): Promise<string>;
export function probeHeadlessDaemon(timeoutMs?: number): Promise<string | null>;
export function waitForDaemon(deps?: OpenDesignDaemonDeps): Promise<string>;
