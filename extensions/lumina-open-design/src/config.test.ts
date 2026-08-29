import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLuminaOpenDesignSettings } from "./config.js";

describe("resolveLuminaOpenDesignSettings", () => {
  it("resolves the Windows packaged defaults", () => {
    const settings = resolveLuminaOpenDesignSettings(
      {},
      {
        LOCALAPPDATA: "C:\\Users\\dal\\AppData\\Local",
        USERPROFILE: "C:\\Users\\dal",
      },
    );
    expect(settings.daemonUrl).toBe("http://127.0.0.1:7456");
    expect(settings.executablePath).toBe(
      path.join("C:\\Users\\dal\\AppData\\Local", "Programs", "Open Design", "Open Design.exe"),
    );
    expect(settings.autoStart).toBe(true);
    expect(settings.sessionKey).toBe("agent:main:main");
  });

  it("rejects a remote daemon URL", () => {
    expect(() =>
      resolveLuminaOpenDesignSettings({ daemonUrl: "https://design.example.com" }, {}),
    ).toThrow("loopback");
  });
});
