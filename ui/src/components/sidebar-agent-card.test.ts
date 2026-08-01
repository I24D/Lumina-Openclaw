/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import "./sidebar-agent-card.ts";

type SidebarAgentCardElement = HTMLElement & {
  agentName: string;
  avatarUrl: string | null;
  avatarText: string;
  statusLabel: string;
  updateComplete: Promise<boolean>;
};

async function createSidebarAgentCard(
  overrides: Partial<SidebarAgentCardElement> = {},
): Promise<SidebarAgentCardElement> {
  const element = document.createElement("openclaw-sidebar-agent-card") as SidebarAgentCardElement;
  element.agentName = "Lumina";
  element.avatarText = "L";
  element.statusLabel = "Online";
  Object.assign(element, overrides);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("uses the public favicon when the sidebar agent has no avatar image", async () => {
  const element = await createSidebarAgentCard();

  try {
    expect(
      element
        .querySelector<HTMLImageElement>(".sidebar-agent-card__avatar-favicon")
        ?.getAttribute("src"),
    ).toBe("/favicon.svg");
    expect(element.querySelector(".sidebar-agent-card__avatar-text")).toBeNull();
  } finally {
    element.remove();
  }
});

it("keeps a configured sidebar agent avatar image", async () => {
  const element = await createSidebarAgentCard({ avatarUrl: "/avatar/lumina" });

  try {
    expect(
      element.querySelector<HTMLImageElement>(".sidebar-agent-card__avatar img")?.src,
    ).toContain("/avatar/lumina");
    expect(element.querySelector(".sidebar-agent-card__avatar-favicon")).toBeNull();
  } finally {
    element.remove();
  }
});
