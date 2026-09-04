/**
 * Tests for the autonomy gate (L0..L5).
 */
import { describe, expect, it } from "vitest";
import type { RiskTier } from "../risk/policies.js";
import {
  AUTONOMY_LEVELS,
  decideAutonomy,
  type AutonomyLevel,
  type AutonomyRequest,
} from "./autonomy-levels.js";
import type { ConfidenceStance } from "./uncertainty.js";

const base: AutonomyRequest = {
  level: 4,
  stance: "act",
  riskTier: "SAFE",
  reversible: true,
};

const LEVELS: AutonomyLevel[] = [0, 1, 2, 3, 4, 5];
const TIERS: RiskTier[] = ["SAFE", "WARNING", "HIGH_RISK", "CRITICAL"];
const STANCES: ConfidenceStance[] = ["act", "verify", "ask"];

describe("AUTONOMY_LEVELS", () => {
  it("describes six ascending levels", () => {
    expect(AUTONOMY_LEVELS).toHaveLength(6);
    expect(AUTONOMY_LEVELS.map((l) => l.level)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("decideAutonomy", () => {
  it("executes a safe, confident, reversible action at L4", () => {
    expect(decideAutonomy(base).outcome).toBe("execute");
  });

  it("blocks everything at L0", () => {
    for (const tier of TIERS) {
      for (const stance of STANCES) {
        const d = decideAutonomy({ ...base, level: 0, riskTier: tier, stance });
        expect(d.outcome).toBe("block");
      }
    }
  });

  it("never executes a CRITICAL action, at any level or confidence", () => {
    for (const level of LEVELS) {
      for (const stance of STANCES) {
        for (const preAuthorized of [false, true]) {
          const d = decideAutonomy({
            ...base,
            level,
            stance,
            preAuthorized,
            riskTier: "CRITICAL",
          });
          expect(d.outcome).not.toBe("execute");
        }
      }
    }
  });

  it("caps L3 at proposing, which is the proactive contract", () => {
    const d = decideAutonomy({ ...base, level: 3 });
    expect(d.outcome).toBe("propose");
  });

  it("never runs irreversible work unattended", () => {
    for (const level of LEVELS) {
      const d = decideAutonomy({ ...base, level, reversible: false, preAuthorized: true });
      expect(d.outcome).not.toBe("execute");
    }
  });

  it("downgrades to confirm when confidence is low", () => {
    expect(decideAutonomy({ ...base, stance: "ask" }).outcome).toBe("confirm");
  });

  it("lets standing authorization restore execution for reversible safe work", () => {
    const gated = decideAutonomy({ ...base, level: 4, stance: "verify" });
    expect(gated.outcome).toBe("propose");
    const authorized = decideAutonomy({ ...base, level: 4, stance: "verify", preAuthorized: true });
    expect(authorized.outcome).toBe("execute");
    expect(authorized.reason).toContain("pre-authorized");
  });

  it("does not let authorization override HIGH_RISK", () => {
    const d = decideAutonomy({ ...base, riskTier: "HIGH_RISK", preAuthorized: true });
    expect(d.outcome).toBe("confirm");
  });

  it("is monotonic: raising risk never widens the outcome", () => {
    const order = { block: 0, confirm: 1, propose: 2, execute: 3 } as const;
    for (const level of LEVELS) {
      for (const stance of STANCES) {
        let previous = 4;
        for (const tier of TIERS) {
          const d = decideAutonomy({ ...base, level, stance, riskTier: tier });
          expect(order[d.outcome]).toBeLessThanOrEqual(previous);
          previous = order[d.outcome];
        }
      }
    }
  });

  it("explains which constraint narrowed the decision", () => {
    const d = decideAutonomy({ ...base, level: 3, action: "send WhatsApp reply" });
    expect(d.reason).toContain("send WhatsApp reply");
    expect(d.reason).toContain("autonomy L3");
  });
});
