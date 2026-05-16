import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing, readCliBannerTaglineMode } from "./banner-config-lite.js";

describe("banner-config-lite", () => {
  it("reads tagline mode from JSON-like config text without loading full config runtime", () => {
    expect(__testing.readTaglineModeFromRawConfig('{ "cli": { "banner": { "taglineMode": "off" }}}')).toBe(
      "off",
    );
    expect(__testing.readTaglineModeFromRawConfig("{ cli: { banner: { taglineMode: 'default' } } }")).toBe(
      "default",
    );
  });

  it("resolves OPENCLAW_CONFIG_PATH with home expansion", () => {
    const homeDir = path.join("C:\\", "Users", "tester");
    expect(
      __testing.resolveBannerConfigPath(
        { OPENCLAW_CONFIG_PATH: "~\\custom\\openclaw.json" } as NodeJS.ProcessEnv,
        homeDir,
      ),
    ).toBe(path.resolve(homeDir, "custom", "openclaw.json"));
  });

  it("falls back to OPENCLAW_STATE_DIR/openclaw.json", () => {
    const homeDir = path.join("C:\\", "Users", "tester");
    expect(
      __testing.resolveBannerConfigPath(
        { OPENCLAW_STATE_DIR: "~\\state-root" } as NodeJS.ProcessEnv,
        homeDir,
      ),
    ).toBe(path.resolve(homeDir, "state-root", "openclaw.json"));
  });

  it("returns undefined when the config file is missing", () => {
    const missingPath = path.join(os.tmpdir(), "missing-lumina-banner-config.json");
    expect(
      readCliBannerTaglineMode({ OPENCLAW_CONFIG_PATH: missingPath } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
