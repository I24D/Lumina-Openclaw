import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
} from "./agent-limits.js";
import {
  applyAgentDefaults,
  applyContextPruningDefaults,
  applyMessageDefaults,
  applyModelDefaults,
} from "./defaults.js";

const mocks = vi.hoisted(() => ({
  applyProviderConfigDefaultsForConfig: vi.fn(),
  normalizeProviderConfigForConfigDefaults: vi.fn(
    (params: { providerConfig: unknown }) => params.providerConfig,
  ),
  normalizeConfiguredProviderCatalogModelId: vi.fn(
    (_provider: string, modelId: string) => modelId,
  ),
}));

vi.mock("../agents/model-ref-shared.js", () => ({
  normalizeConfiguredProviderCatalogModelId: (
    ...args: Parameters<typeof mocks.normalizeConfiguredProviderCatalogModelId>
  ) => mocks.normalizeConfiguredProviderCatalogModelId(...args),
}));

vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (
    ...args: Parameters<typeof mocks.applyProviderConfigDefaultsForConfig>
  ) => mocks.applyProviderConfigDefaultsForConfig(...args),
  normalizeProviderConfigForConfigDefaults: (
    ...args: Parameters<typeof mocks.normalizeProviderConfigForConfigDefaults>
  ) => mocks.normalizeProviderConfigForConfigDefaults(...args),
}));

describe("config defaults", () => {
  beforeEach(() => {
    mocks.applyProviderConfigDefaultsForConfig.mockReset();
    mocks.normalizeProviderConfigForConfigDefaults.mockClear();
    mocks.normalizeConfiguredProviderCatalogModelId.mockClear();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips provider defaults when agent defaults are absent", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
          },
        },
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
  });

  it("skips provider defaults when agent defaults have no Anthropic auth signal", () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
  });

  it("uses anthropic provider defaults when agent defaults and auth signal exist", () => {
    const cfg = {
      auth: {
        profiles: {
          anthropic: { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {},
      },
    };
    const nextCfg = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
          },
        },
      },
    };
    mocks.applyProviderConfigDefaultsForConfig.mockReturnValue(nextCfg);

    const manifestRegistry = { plugins: [] };
    expect(applyContextPruningDefaults(cfg as never, { manifestRegistry })).toBe(nextCfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).toHaveBeenCalledTimes(1);
    const [[defaultsParams]] = mocks.applyProviderConfigDefaultsForConfig.mock
      .calls as unknown as Array<[{ manifestRegistry?: unknown }]>;
    expect(defaultsParams.manifestRegistry).toBe(manifestRegistry);
  });

  it("skips provider policy loading on the desktop fast path", () => {
    const next = applyModelDefaults(
      {
        models: {
          providers: {
            lumina: {
              baseUrl: "http://127.0.0.1:4321/v1",
              api: "openai-completions",
              models: [{ id: "I24D", name: "Lumina IA" }],
            },
          },
        },
      } as never,
      { skipProviderPolicy: true },
    );

    expect(mocks.normalizeProviderConfigForConfigDefaults).not.toHaveBeenCalled();
    expect(mocks.normalizeConfiguredProviderCatalogModelId).toHaveBeenCalledWith(
      "lumina",
      "I24D",
      { allowManifestNormalization: false },
    );
    expect(next.models?.providers?.lumina?.models?.[0]?.contextWindow).toBeDefined();
  });

  it("defaults ackReactionScope without deriving other message fields", () => {
    const next = applyMessageDefaults({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha",
              theme: "helpful sloth",
              emoji: "🦥",
            },
          },
        ],
      },
      messages: {},
    } as never);

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
    expect(next.messages?.responsePrefix).toBeUndefined();
    expect(next.messages?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("fills missing agent concurrency defaults", () => {
    const next = applyAgentDefaults({ messages: {} } as never);

    expect(next.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    expect(next.agents?.defaults?.subagents?.archiveAfterMinutes).toBe(
      DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
    );
  });

  it("preserves explicit subagent archive default", () => {
    const next = applyAgentDefaults({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    } as never);

    expect(next.agents?.defaults?.subagents?.archiveAfterMinutes).toBe(0);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});
