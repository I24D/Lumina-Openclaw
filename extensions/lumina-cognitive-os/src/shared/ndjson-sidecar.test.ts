import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { NdjsonSidecar, type SidecarExit } from "./ndjson-sidecar.js";
import { resolveSidecarScriptPath, sidecarRoot } from "./python.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  kill() {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null) {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

const sidecar = () => {
  const clock = { now: 0 };
  const children: FakeChild[] = [];
  const car = new NdjsonSidecar<{ kind: "start" }>({
    name: "camera_perception",
    args: () => [],
    pythonExe: "python",
    scriptPath: "camera_perception.py",
    now: () => clock.now,
    spawnImpl: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
  });
  const exits: SidecarExit[] = [];
  car.on((event) => {
    if (event.kind === "exit") {
      exits.push(event);
    }
  });
  return { car, clock, children, exits };
};

const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(() => {
  delete process.env.LUMINA_COGNITIVE_OS_SIDECAR_ROOT;
});

describe("NdjsonSidecar", () => {
  it("explains a failed start and backs off instead of respawning at once", async () => {
    const { car, clock, children, exits } = sidecar();
    expect(car.start().ok).toBe(true);
    children[0]?.stderr.write("Traceback...\npython: can't open file 'camera_perception.py'\n");
    await tick();
    children[0]?.exit(2);
    expect(exits[0]).toEqual({
      kind: "exit",
      code: 2,
      detail: "python: can't open file 'camera_perception.py'",
    });
    const refused = car.start();
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/exited with code 2.*retrying in 2 s/u);
    expect(children).toHaveLength(1);
    clock.now += 2_000;
    expect(car.start().ok).toBe(true);
    children[1]?.exit(2);
    clock.now += 2_000;
    // The second failure doubles the wait.
    expect(car.start().ok).toBe(false);
    clock.now += 2_000;
    expect(car.start().ok).toBe(true);
    expect(car.status().lastFailure).toContain("code 2");
  });

  it("does not count a stop it asked for as a failure", () => {
    const { car, children, exits } = sidecar();
    car.start();
    car.stop();
    children[0]?.exit(1);
    expect(exits[0]).toEqual({ kind: "exit", code: 1 });
    expect(car.start().ok).toBe(true);
  });
});

describe("sidecar scripts", () => {
  it("are found in source, or wherever the override points", () => {
    expect(sidecarRoot()).toBe(path.resolve(import.meta.dirname, "../../sidecars"));
    expect(resolveSidecarScriptPath("camera_perception")).toBe(
      path.resolve(import.meta.dirname, "../../sidecars/camera_perception.py"),
    );
    process.env.LUMINA_COGNITIVE_OS_SIDECAR_ROOT = "/opt/lumina/sidecars";
    expect(sidecarRoot()).toBe("/opt/lumina/sidecars");
  });
});
