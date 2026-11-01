// Proves the WhatsApp DM policy Dal chose on 2026-11-01 actually enforces,
// rather than merely being present in the config.
//
// The history is why this exists. The gateway had been logging
// `dm_policy_disabled` against inbound messages while the config carried
// `allowFrom: ["*", <Dal's numbers>]` — so the wildcard read like an open door
// that simply was not working. It was not the wildcard failing: `dmPolicy`
// decides before the list is consulted, and it said `disabled`. Setting the
// policy to `allowlist` opens the door, and at that point the wildcard stops
// being decoration and becomes the hole, because `isSenderIdAllowed` returns
// true for any sender as soon as the list has one.
//
// So the shape Dal asked for is two decisions, not one: `allowlist` for the
// policy and concrete numbers with no `"*"` for the list. The third case below
// is the one that matters — it shows what putting `"*"` back would cost, which
// is the mistake this file exists to catch.
import { expect, it } from "vitest";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "./host-ingress.test-support.js";

const DAL = "+15550000001";
const ALSO_DAL = "+15550000002";
const STRANGER = "+15559999999";
// Stands in for the live list: concrete entries, no wildcard.
const ALLOW_FROM = [DAL, ALSO_DAL];

async function admit(senderId: string, allowFrom: string[]) {
  const { ingress } = createHostIngressFixture("whatsapp");
  const message = ingressMessage("whatsapp", "agent:main:whatsapp:dm:dm-1", senderId);
  return await ingress.resolveStable(ingressInput(message, { dmPolicy: "allowlist", allowFrom }));
}

it("admits a number on the allowlist", async () => {
  const resolved = await admit(DAL, ALLOW_FROM);
  expect(resolved.ingress).toMatchObject({ admission: "dispatch", decision: "allow" });
  // The DM verdict is read off the sender gate, not off `ingress.reasonCode`.
  // That field names whichever gate was *decisive*, and a gate that lets the
  // message through is never the decisive one — for an admitted sender it
  // reports `activation_allowed`, from a gate further down the graph. Only the
  // blocking case below puts the DM policy in the decisive seat.
  expect(resolved.senderAccess).toMatchObject({
    allowed: true,
    decision: "allow",
    reasonCode: "dm_policy_allowlisted",
  });
});

it("drops a number that is not on the allowlist", async () => {
  const resolved = await admit(STRANGER, ALLOW_FROM);
  // Here the DM policy *is* the decisive gate, so both agree on the reason.
  expect(resolved.ingress).toMatchObject({
    admission: "drop",
    decision: "block",
    reasonCode: "dm_policy_not_allowlisted",
  });
  expect(resolved.senderAccess).toMatchObject({
    allowed: false,
    reasonCode: "dm_policy_not_allowlisted",
  });
});

it("would admit that same stranger if the wildcard went back in", async () => {
  // Not a feature: the cost of restoring `"*"`. `allowlist` is only a closed
  // door while every entry is a concrete id.
  const resolved = await admit(STRANGER, ["*", ...ALLOW_FROM]);
  expect(resolved.ingress.admission).toBe("dispatch");
  expect(resolved.senderAccess.allowed).toBe(true);
});
