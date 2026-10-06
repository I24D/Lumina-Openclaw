import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import {
  ArtifactRegistry,
  hashPath,
  perceptionModels,
  type ArtifactInput,
  type ArtifactRecord,
} from "./artifact-registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-artifacts-"));
  dirs.push(dir);
  return dir;
};

const model = (file: string): ArtifactInput => ({
  kind: "model",
  name: "Test detector",
  source: "https://example.invalid/detector.onnx",
  license: "MIT",
  version: "1",
  purpose: "testing",
  path: file,
});

describe("artifact registry", () => {
  it("pins a hash on first registration and reports a swapped file as changed", async () => {
    const dir = tempDir();
    const file = path.join(dir, "detector.onnx");
    fs.writeFileSync(file, "weights v1");
    const store = new MemoryStateStore<ArtifactRecord>();
    const registry = new ArtifactRegistry({ store });
    const first = await registry.register(model(file));
    expect(first.status).toBe("ok");
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    fs.writeFileSync(file, "weights v2");
    // Registering again never re-pins: it checks against the first hash.
    const again = await registry.register(model(file));
    expect(again.status).toBe("changed");
    expect(again.sha256).toBe(first.sha256);
    await registry.flush();
    const restarted = new ArtifactRegistry({ store });
    const [check] = await restarted.verifyAll();
    expect(check?.status).toBe("changed");
    expect(restarted.probe().check()).toMatchObject({ status: "degraded" });
  });

  it("reports a missing file without deleting its record", async () => {
    const dir = tempDir();
    const file = path.join(dir, "detector.onnx");
    fs.writeFileSync(file, "weights");
    const registry = new ArtifactRegistry();
    await registry.register(model(file));
    fs.rmSync(file);
    const [check] = await registry.verifyAll();
    expect(check?.status).toBe("missing");
    expect(registry.list()).toHaveLength(1);
  });

  it("hashes a directory from its relative paths and contents, independent of order", async () => {
    const a = tempDir();
    const b = tempDir();
    for (const dir of [a, b]) {
      fs.mkdirSync(path.join(dir, "sub"));
    }
    fs.writeFileSync(path.join(a, "x.txt"), "x");
    fs.writeFileSync(path.join(a, "sub", "y.txt"), "y");
    fs.writeFileSync(path.join(b, "sub", "y.txt"), "y");
    fs.writeFileSync(path.join(b, "x.txt"), "x");
    expect((await hashPath(a)).sha256).toBe((await hashPath(b)).sha256);
    fs.writeFileSync(path.join(b, "x.txt"), "changed");
    expect((await hashPath(a)).sha256).not.toBe((await hashPath(b)).sha256);
  });

  it("registers only the perception models already downloaded", async () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "voice"));
    fs.writeFileSync(path.join(dir, "voice", "silero_vad.onnx"), "vad");
    const registry = new ArtifactRegistry();
    const checks = await registry.registerPresent(perceptionModels(dir));
    expect(checks.map((c) => c.name)).toEqual(["Silero VAD"]);
    expect(registry.probe().check()).toMatchObject({ status: "ok" });
  });
});
