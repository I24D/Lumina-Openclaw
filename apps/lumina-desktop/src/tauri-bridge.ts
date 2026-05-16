#!/usr/bin/env node

import { bootstrapLuminaRuntime, persistPreferredModelSelection } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[tauri-bridge] ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    fail("Missing command.");
  }

  if (command === "resolve-startup-state") {
    const config = loadConfig();
    const runtimePaths = resolveRuntimePaths();
    bootstrapLuminaRuntime(config, runtimePaths);

    printJson({
      config,
      runtimePaths,
      rendererConfig: {
        authServiceUrl: config.authServiceUrl,
        gatewayUrl: `ws://127.0.0.1:${config.gatewayPort}`,
        gatewayToken: config.gatewayToken,
        proxyUrl: `http://127.0.0.1:${config.proxyPort}`,
        defaultTab: config.defaultTab,
        requireLuminaAuth: config.requireLuminaAuth,
      },
    });
    return;
  }

  if (command === "save-preferred-model") {
    const modelRef = args[0]?.trim();
    if (!modelRef) {
      fail("Missing model reference.");
    }
    const config = loadConfig();
    persistPreferredModelSelection(config, modelRef);
    return;
  }

  fail(`Unsupported command: ${command}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  fail(message);
});
