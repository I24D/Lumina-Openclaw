import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createSimTraining, type SimReport } from "./sim-training.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const evaluation = (successRate: number) => ({
  episodes: 20,
  successRate,
  personContacts: 0,
  obstacleContacts: 1,
  meanSeconds: 8,
  minPersonM: 0.7,
});

function fakeTraining(report: SimReport) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spawnImpl = ((_python: string, args: string[]) => {
    queueMicrotask(() => {
      const out = args[args.indexOf("--out") + 1] ?? "";
      fs.writeFileSync(out, JSON.stringify(report));
      child.stdout.write(`${JSON.stringify({ kind: "progress", iteration: 1, bestScore: 8.1 })}\n`);
      child.stdout.write(`${JSON.stringify({ kind: "report", ...report })}\n`);
      setTimeout(() => child.emit("exit", 0), 5);
    });
    return child;
  }) as never;
  return spawnImpl;
}

describe("simulation training", () => {
  it("hands the simulated body a policy only once one has been accepted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-sim-"));
    dirs.push(dir);
    const report: SimReport = {
      atISO: "2026-10-06T12:00:00.000Z",
      policy: { push: 3.2 },
      baseline: evaluation(0.8),
      learned: evaluation(0.9),
      accepted: true,
      deployment: "simulation only",
    };
    const training = createSimTraining({ dir, spawnImpl: fakeTraining(report) });
    expect(training.policyPath()).toBeUndefined();
    expect(training.start()).toEqual({ started: true });
    expect(training.start()).toMatchObject({ started: false });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(training.status()).toMatchObject({ running: false, report: { accepted: true } });
    expect(training.policyPath()).toBe(path.join(dir, "sim-policy.json"));
    // A restart reads the last report back.
    expect(createSimTraining({ dir }).policyPath()).toBe(path.join(dir, "sim-policy.json"));
  });

  it("keeps the default when the learned policy was not accepted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-sim-"));
    dirs.push(dir);
    const training = createSimTraining({
      dir,
      spawnImpl: fakeTraining({
        atISO: "2026-10-06T12:00:00.000Z",
        policy: { push: 9 },
        baseline: evaluation(0.9),
        learned: evaluation(0.7),
        accepted: false,
        deployment: "simulation only",
      }),
    });
    training.start();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(training.policyPath()).toBeUndefined();
  });
});
