import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStateStore } from "../shared/state-store.js";
import { PersonaLedger, type PersonaVersion } from "./persona.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const workspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-persona-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "IDENTITY.md"), "- Name: Lumina\n");
  fs.writeFileSync(path.join(dir, "SOUL.md"), "Kind, direct, honest.\n");
  return dir;
};

describe("persona ledger", () => {
  it("records a version only when the persona files change, and keeps it across restarts", async () => {
    const dir = workspace();
    const store = new MemoryStateStore<PersonaVersion>();
    const ledger = new PersonaLedger({ dir, store });
    const first = await ledger.check();
    expect(first).toMatchObject({ status: "ok", changed: true, current: { version: 1 } });
    expect((await ledger.check()).status === "ok" && (await ledger.check())).toMatchObject({
      changed: false,
    });
    fs.writeFileSync(path.join(dir, "SOUL.md"), "Kind, direct, honest, curious.\n");
    expect(await ledger.check()).toMatchObject({ changed: true, current: { version: 2 } });
    await ledger.flush();
    const restarted = new PersonaLedger({ dir, store });
    expect(await restarted.check()).toMatchObject({ changed: false, current: { version: 2 } });
    expect(restarted.history()).toHaveLength(2);
    expect(restarted.probe().check()).toMatchObject({ status: "ok" });
  });

  it("reports missing persona files instead of inventing a persona", async () => {
    const dir = workspace();
    fs.rmSync(path.join(dir, "SOUL.md"));
    const ledger = new PersonaLedger({ dir });
    expect(await ledger.check()).toEqual({ status: "missing", missing: ["SOUL.md"] });
    expect(ledger.probe().check()).toMatchObject({ status: "degraded" });
  });
});
