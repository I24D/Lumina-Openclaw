import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  resolveConfiguredPluginAutoEnableCandidates,
  resolvePluginAutoEnableReadiness,
  resolvePluginAutoEnableManifestRegistry,
} from "./plugin-auto-enable.shared.js";
import type { PluginAutoEnableCandidate } from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function isTruthyEnvValue(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

export function shouldSkipPluginAutoEnable(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_SKIP_PLUGIN_AUTO_ENABLE);
}

export function detectPluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableCandidate[] {
  const env = params.env ?? process.env;
  if (shouldSkipPluginAutoEnable(env)) {
    return [];
  }
  const config = params.config ?? ({} as OpenClawConfig);
  const readiness = resolvePluginAutoEnableReadiness(config, env);
  if (!readiness.mayNeedAutoEnable) {
    return [];
  }
  const registry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return resolveConfiguredPluginAutoEnableCandidates({
    config,
    env,
    registry,
    configuredChannelIds: readiness.configuredChannelIds,
  });
}
