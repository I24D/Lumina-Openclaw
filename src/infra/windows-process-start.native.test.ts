import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { getWindowsPowerShellExePath } from "./windows-install-roots.js";

it("keeps the PID identity source closure loadable by native Node without a workspace resolver", () => {
  const source = new URL("../shared/pid-alive.ts", import.meta.url).href;
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(source)}); console.log(typeof module.getFileLockProcessStartTime);`,
    ],
    { env: {}, encoding: "utf8", timeout: 5000 },
  );
  expect(stdout.trim()).toBe("function");
});

it.skipIf(process.platform !== "win32")(
  "reads the same kernel creation timestamp without a shell after native source import",
  () => {
    const source = new URL("./windows-process-start.ts", import.meta.url).href;
    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import childProcess from "node:child_process";
          import { syncBuiltinESMExports } from "node:module";
          const powershell = ${JSON.stringify(getWindowsPowerShellExePath())};
          const expected = Date.parse(childProcess.execFileSync(powershell, [
            "-NoProfile", "-NonInteractive", "-Command",
            "$p = [System.Diagnostics.Process]::GetProcessById(" + process.pid + "); try { [Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o')) } finally { $p.Dispose() }"
          ], { encoding: "utf8", timeout: 5000, windowsHide: true }));
          childProcess.spawnSync = () => { throw new Error("unexpected shell fallback"); };
          syncBuiltinESMExports();
          const { readWindowsProcessStartTimeSync } = await import(${JSON.stringify(source)});
          const actual = readWindowsProcessStartTimeSync(process.pid);
          if (!Number.isFinite(expected) || actual !== expected) {
            throw new Error("native creation timestamp differs from the kernel shell query");
          }
          console.log("native identity matches");
        `,
      ],
      { env: {}, encoding: "utf8", timeout: 10000 },
    );
    expect(stdout.trim()).toBe("native identity matches");
  },
);

it.skipIf(process.platform !== "win32")(
  "reads another account's process start time, so a reused lock PID is recognized",
  async () => {
    const { readWindowsProcessStartTimeSync } = await import("./windows-process-start.js");
    // PID 4 is the System process: its StartTime is denied to a user, and WMIC
    // no longer ships with Windows, so only the CIM fallback can answer.
    expect(Number.isFinite(readWindowsProcessStartTimeSync(4, 15_000))).toBe(true);
  },
);
