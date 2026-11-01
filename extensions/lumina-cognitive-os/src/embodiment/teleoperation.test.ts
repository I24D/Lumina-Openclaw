import { describe, expect, it } from "vitest";
import { AuditLog } from "../safety/audit-log.js";
import { PeopleRegistry } from "../social/people.js";
import { SimulatedBody } from "./body.js";
import { EmbodiedController, type EmergencyStop } from "./embodied-controller.js";
import { roleCanTeleoperate, TeleoperationGateway } from "./teleoperation.js";

function emergencyStop(): EmergencyStop {
  return {
    isEngaged: () => false,
    onEngage: () => () => undefined,
  };
}

function setup() {
  const people = new PeopleRegistry();
  const audit = new AuditLog();
  const adapter = new SimulatedBody(() => undefined, "lab");
  const body = new EmbodiedController({
    body: adapter,
    emergencyStop: emergencyStop(),
    audit,
    context: () => ({
      autonomyLevel: 3,
      granted: new Set(["robot.gesture", "robot.navigate"]),
      preAuthorized: new Set(["robot.gesture", "robot.navigate"]),
      canObserve: true,
      canAsk: true,
      world: undefined,
    }),
  });
  return { people, audit, body, gateway: new TeleoperationGateway(people, body, audit) };
}

describe("TeleoperationGateway", () => {
  it("only permits roles with explicit teleoperation authority", () => {
    expect(roleCanTeleoperate("owner", { type: "gesture", name: "wave" })).toBe(true);
    expect(roleCanTeleoperate("guardian", { type: "navigate_to", targetId: "room" })).toBe(true);
    expect(roleCanTeleoperate("technician", { type: "gesture", name: "wave" })).toBe(true);
    expect(roleCanTeleoperate("technician", { type: "navigate_to", targetId: "room" })).toBe(false);
    expect(roleCanTeleoperate("user", { type: "stop" })).toBe(false);
    expect(roleCanTeleoperate("guest", { type: "gesture", name: "wave" })).toBe(false);
  });

  it("attributes and audits an authorized request as teleop:<personId>", async () => {
    const { people, audit, gateway } = setup();
    const remembered = people.remember({ name: "Dal" }, { channel: "owner", actor: "config" });
    if (!remembered.ok) {
      throw new Error(remembered.reason);
    }
    people.setRole(remembered.person.id, "owner", { channel: "owner", actor: "config" });

    const result = await gateway.request(remembered.person.id, { type: "gesture", name: "wave" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.requestedBy).toBe(`teleop:${remembered.person.id}`);
    }
    expect(audit.recent(20).some((r) => r.action === "teleop.gesture")).toBe(true);
  });

  it("refuses a guest before the body receives the intent and audits the refusal", async () => {
    const { people, audit, body, gateway } = setup();
    const remembered = people.remember({ name: "Visitor" }, { channel: "owner", actor: "config" });
    if (!remembered.ok) {
      throw new Error(remembered.reason);
    }
    people.setRole(remembered.person.id, "guest", { channel: "owner", actor: "config" });

    const result = await gateway.request(remembered.person.id, { type: "gesture", name: "wave" });
    expect(result.ok).toBe(false);
    expect(body.recent()).toHaveLength(0);
    expect(audit.recent(20).find((r) => r.action === "teleop.gesture")?.execution).toBe("refused");
  });
});
