/**
 * Tests for confirming physical actions on the real keyboard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidecarExit } from "../shared/ndjson-sidecar.js";
import { attachPhysicalConfirm, type ConfirmEvent, type ConfirmPort } from "./physical-confirm.js";

class FakeKeys implements ConfirmPort {
  sent: Array<Readonly<Record<string, unknown>>> = [];
  private listener: ((event: ConfirmEvent | SidecarExit) => void) | undefined;
  private isRunning = false;
  start() {
    this.isRunning = true;
    return { ok: true };
  }
  stop() {
    this.isRunning = false;
  }
  running() {
    return this.isRunning;
  }
  send(command: Readonly<Record<string, unknown>>) {
    this.sent.push(command);
    return true;
  }
  on(listener: (event: ConfirmEvent | SidecarExit) => void) {
    this.listener = listener;
    return () => undefined;
  }
  press(event: ConfirmEvent) {
    this.listener?.(event);
  }
}

const detachers: Array<() => void> = [];
afterEach(() => {
  for (const detach of detachers.splice(0)) {
    detach();
  }
});

const setup = () => {
  const keys = new FakeKeys();
  const waiting = [{ id: "req_1", intent: { type: "grasp", objectId: "cup" } }];
  const body = {
    pending: vi.fn(() => waiting),
    approve: vi.fn(async () => ({ ok: true })),
    reject: vi.fn(() => true),
  };
  const audit = { append: vi.fn() };
  const notify = vi.fn();
  const link = attachPhysicalConfirm({
    port: keys,
    body: body as never,
    audit: audit as never,
    notify,
    checkEveryMs: 60_000,
  });
  detachers.push(link.detach);
  return { keys, body, audit, notify, link };
};

describe("physical confirmation", () => {
  it("arms the oldest waiting action and tells the person what to press", () => {
    const { keys, notify, link } = setup();
    expect(keys.sent).toEqual([{ cmd: "arm", requestId: "req_1" }]);
    expect(link.armed()).toBe("req_1");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Ctrl+Alt+Y"));
  });

  it("approves through the owner channel when a person presses the chord", async () => {
    const { keys, body } = setup();
    keys.press({ kind: "confirmed", requestId: "req_1", approve: true, atISO: "" });
    await vi.waitFor(() =>
      expect(body.approve).toHaveBeenCalledWith("req_1", {
        channel: "owner",
        actor: "physical-key",
      }),
    );
  });

  it("ignores answers for anything but the armed request, and audits injected keys", () => {
    const { keys, body, audit } = setup();
    keys.press({ kind: "confirmed", requestId: "req_other", approve: true, atISO: "" });
    keys.press({ kind: "injected_ignored", atISO: "" });
    expect(body.approve).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: "body.confirm.injected", execution: "refused" }),
    );
  });
});
