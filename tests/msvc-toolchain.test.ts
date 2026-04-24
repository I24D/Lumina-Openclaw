import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWindowsMsvcBatchScript,
  quoteWindowsBatchArgument,
  resolveVcvars64Path,
} from "../scripts/msvc-toolchain.ts";

test("resolveVcvars64Path prefers the explicit environment override", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-vcvars-test-"));
  const vcvarsPath = path.join(fixtureDir, "vcvars64.bat");

  try {
    fs.writeFileSync(vcvarsPath, "@echo off\r\n", "utf8");
    const resolved = resolveVcvars64Path({ VCVARS64_BAT: vcvarsPath });
    assert.equal(resolved, vcvarsPath);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("quoteWindowsBatchArgument preserves spaces and embedded quotes", () => {
  assert.equal(
    quoteWindowsBatchArgument('C:\\Program Files\\Lumina "Desktop"\\cargo.exe'),
    '"C:\\Program Files\\Lumina ""Desktop""\\cargo.exe"',
  );
});

test("buildWindowsMsvcBatchScript injects vcvars, PATH, and environment variables", () => {
  const script = buildWindowsMsvcBatchScript({
    vcvarsPath: "C:\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat",
    commandPath: "C:\\Rust\\cargo.exe",
    args: ["test", "--manifest-path", "C:\\repo\\Cargo.toml"],
    prependPathEntries: ["C:\\Rust"],
    envVars: {
      RUSTC: "C:\\Rust\\rustc.exe",
    },
  });

  assert.match(script, /call "C:\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64\.bat"/);
  assert.match(script, /set "PATH=C:\\Rust;%PATH%"/);
  assert.match(script, /set "RUSTC=C:\\Rust\\rustc\.exe"/);
  assert.match(script, /"C:\\Rust\\cargo\.exe" "test" "--manifest-path" "C:\\repo\\Cargo\.toml"/);
});
