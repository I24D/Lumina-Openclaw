/**
 * Lumina Cognitive OS — Niveles 1-12 (Codex roadmap)
 * ════════════════════════════════════════════════════════════════
 * Single extension that ties together every capability required to turn
 * Lumina from "chatbot" into "Cognitive Operating System". All tools are
 * registered with OpenClaw's tool registry so the user can invoke them
 * by voice via Start Talk.
 *
 *   Nivel 1  Environment Awareness        → lumina_awareness_snapshot/_subscribe
 *   Nivel 2  Working + Episodic memory    → lumina_working_memory_*, _episodic_*
 *   Nivel 3  Vision (UI Tree + multimon)  → lumina_vision_ui_tree, _multimonitor
 *   Nivel 4  Browser driver + planner     → lumina_browser_drive, _action_plan
 *   Nivel 5  Director (12 specialists)    → lumina_director_route
 *   Nivel 8  Transparency log             → lumina_transparency_publish/_recent
 *   Nivel 9  Intent router + templates    → lumina_intent_run
 *   Nivel 10 Risk evaluation 4-tier       → lumina_risk_evaluate / _recent
 *   Nivel 11 MCP Gmail/Calendar/Drive     → lumina_gmail, _calendar, _drive
 *   Nivel 12 Boot greeting + wake-word    → lumina_boot_greeting, _wake_word
 *
 * Niveles 6 (Start Talk states) and 7 (avatar expressions) are UI-only
 * and live in the `ui/src/ui/chat` folder.
 * ════════════════════════════════════════════════════════════════
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// Action
import { createPlanStore, createActionPlanTool } from "./src/action/action-tools.js";
import {
  createAppListTool,
  createAppLaunchTool,
  createAppCloseTool,
} from "./src/action/app-tools.js";
import { createBrowserDriverTool } from "./src/action/browser-driver.js";
import { createBrowserNaturalTool } from "./src/action/browser-natural.js";
import { createBrowserScreencastTool } from "./src/action/browser-screencast.js";
import { createBrowserSessionTool } from "./src/action/browser-session.js";
import {
  createBrowserSmartClickTool,
  createBrowserSmartTypeTool,
  createBrowserDomObserveTool,
  createBrowserDomScreenshotTool,
} from "./src/action/browser-smart-click.js";
import {
  createPcObserveTool,
  createPcScrollTool,
  createPcDragTool,
} from "./src/action/pc-tools.js";
import { createSmartClickTool, createSmartTypeTool } from "./src/action/smart-click.js";
import { createAdapterResolveTool } from "./src/adapters/adapter-resolve-tool.js";
import { createAudioTool } from "./src/adapters/audio-tool.js";
// App Adapter Registry (§5): specialized structural adapters before generic UIA.
import { createOfficeTool } from "./src/adapters/office-tool.js";
import { createRegistryTool } from "./src/adapters/registry-tool.js";
// Agents
import { createDirectorRouteTool } from "./src/agents/director-tool.js";
// Automation
import { createIntentRunTool } from "./src/automation/intent-tool.js";
import { WorkflowEngine, type WorkflowEnvironment } from "./src/automation/workflow-engine.js";
import { createWorkflowListTool, createWorkflowRunTool } from "./src/automation/workflow-tool.js";
import {
  createAwarenessSnapshotTool,
  createAwarenessSubscribeTool,
} from "./src/awareness/awareness-tool.js";
// Awareness
import { AwarenessEventBus } from "./src/awareness/event-bus.js";
import {
  createPhoneLinkReplyTool,
  createPhoneLinkStatusTool,
  createWhatsappRespondTool,
} from "./src/awareness/phone-link-tool.js";
import { AwarenessPoller } from "./src/awareness/snapshot.js";
import { createWindowsContextTool } from "./src/awareness/windows-context-tool.js";
// Code execute (Fase 2)
import { createCodeExecuteTool } from "./src/code/code-execute-tool.js";
// CodeAct loop (Fase 6 — LLM-writes-Python pattern)
import { CodeActEngine } from "./src/codeact/codeact-loop.js";
import {
  createCodeActStartTool,
  createCodeActStepTool,
  createCodeActStatusTool,
  createCodeActEndTool,
} from "./src/codeact/codeact-tool.js";
// Cognitive core: router, world model, workspace, self model, body
import {
  COGNITIVE_STORE_NAMESPACES,
  createEpisodicMemory,
  createToolRecorder,
  hostDeps,
  startCognitiveCore,
} from "./src/cognition/plugin-wiring.js";
import { loadLuminaEnv } from "./src/env.js";
// Governance
import {
  GovernanceEngine,
  createGovernanceEvaluateTool,
  createGovernancePolicyTool,
} from "./src/governance/governance-policy.js";
import { createCalendarTool } from "./src/mcp/calendar-tool.js";
import { createDriveTool } from "./src/mcp/drive-tool.js";
// MCP
import { createGmailTool } from "./src/mcp/gmail-tool.js";
import {
  createWorkingMemoryRecallTool,
  createWorkingMemoryLogTool,
} from "./src/memory/action-log-tool.js";
import { ActionLogStore } from "./src/memory/action-log.js";
import {
  createWorkingMemoryGetTool,
  createWorkingMemorySetTool,
  createEpisodicRememberTool,
  createEpisodicRecallTool,
} from "./src/memory/memory-tools.js";
// Memory
import { WorkingMemoryStore } from "./src/memory/working-memory.js";
// LUMINA-MESH/1: the durable side channel beside the gateway's own paths.
import { createMeshStatusTool } from "./src/mesh/mesh-status-tool.js";
import { startMeshRuntime } from "./src/mesh/mesh-wiring.js";
// Operative daemon (Fase 3 — proactive Lumina)
import { OperativeDaemon } from "./src/operative/operative-daemon.js";
import {
  createOperativeStatusTool,
  createOperativeEnableTool,
  createOperativeDisableTool,
  createOperativeReloadTool,
  createOperativeRecentTool,
} from "./src/operative/operative-tool.js";
import { createMultiProviderBrain } from "./src/operator/brain-multi.js";
import { CostMeter } from "./src/operator/cost-meter.js";
// Global emergency stop (§9): panic hotkey sidecar + software twin tool.
import { KillSwitchProcess } from "./src/operator/kill-switch-process.js";
import { createKillSwitchTool } from "./src/operator/kill-switch-tool.js";
import { PcOperatorEngine } from "./src/operator/loop-engine.js";
// NOTE: the Harness wire-up used to be imported here. It depended on a
// core Harness module and a plugin-side task tool, neither of which exists
// in this repo, so the block could never load and blocked typecheck.
import {
  createPcDoTool,
  createPcDoStatusTool,
  createPcDoListTool,
  createPcDoAbortTool,
  createPcDoCostSummaryTool,
  createPcDoSkillHealthTool,
  createPcDoSkillResetTool,
} from "./src/operator/loop-tools.js";
import { SkillHealthTracker } from "./src/operator/skill-health-tracker.js";
// Continuous Perception (sidecar Python que vigila la pantalla en bucle)
import { PerceptionProcess, createPerceptionBus } from "./src/perception/perception-process.js";
import {
  createPerceptionStartTool,
  createPerceptionStopTool,
  createPerceptionPauseTool,
  createPerceptionResumeTool,
  createPerceptionTuneTool,
  createPerceptionStatusTool,
  createPerceptionRecentTool,
  createPerceptionHealthTool,
} from "./src/perception/perception-tools.js";
import {
  DEFAULT_ENV_PATH,
  resolveCognitiveConfig,
  type CognitiveConfig,
} from "./src/plugin-config.js";
// Presence
import { createBootGreetingTool } from "./src/presence/boot-greeting.js";
import { WakeWordDaemon, createWakeWordTool } from "./src/presence/wake-word.js";
// Recorder (LfD Fase B)
import { RecorderProcess } from "./src/recorder/recorder-process.js";
import { createRecorderStore } from "./src/recorder/recorder-store.js";
import {
  createRecorderStartTool,
  createRecorderStopTool,
  createRecorderPauseTool,
  createRecorderResumeTool,
  createRecorderStatusTool,
  createRecorderListTool,
  createRecorderGetTool,
  createRecorderDeleteTool,
} from "./src/recorder/recorder-tool.js";
// Replay (LfD Fase C)
import {
  ReplayEngine,
  defaultLiveContextProvider,
  defaultActionDispatcher,
} from "./src/replay/replay-engine.js";
import {
  createReplayRunTool,
  createReplayStatusTool,
  createReplayListTool,
  createReplayAbortTool,
  createReplayStrategiesTool,
} from "./src/replay/replay-tool.js";
import { configureOmniParserClient } from "./src/replay/strategies/vision-grounded.js";
// Risk
import { RiskEngine } from "./src/risk/risk-engine.js";
import { createRiskEvaluateTool, createRiskRecentTool } from "./src/risk/risk-tool.js";
// PC Operator Loop (Camino A — autonomous observe→think→act→verify)
import { createBridgeClient } from "./src/shared/bridge-client.js";
import { runPythonSidecarJson } from "./src/shared/python.js";
import { createSkillEvalTool, createSkillEvalRecordTool } from "./src/skills/skill-eval-tool.js";
import { SkillEvalStore } from "./src/skills/skill-eval.js";
import { createSkillFromRecordingTool } from "./src/skills/skill-from-recording-tool.js";
// Skills (agentskills.io standard)
import { SkillLoader } from "./src/skills/skill-loader.js";
import {
  createSkillListTool,
  createSkillDescribeTool,
  createSkillReadAssetTool,
  createSkillRunTool,
} from "./src/skills/skill-tools.js";
import {
  createLuminaMemoryStatusTool,
  createLuminaMemorySearchTool,
  createLuminaMemoryRememberTool,
} from "./src/supabase/lumina-memory-tools.js";
import { createLuminaWarehouseCatalogTool } from "./src/supabase/lumina-warehouse-catalog.js";
// Transparency
import { ActivityLog } from "./src/transparency/activity-log.js";
import { setActiveActivityLog } from "./src/transparency/singleton.js";
import {
  createTransparencyPublishTool,
  createTransparencyRecentTool,
} from "./src/transparency/transparency-tool.js";
import { createMultiMonitorTool } from "./src/vision/multi-monitor.js";
// Vision (OmniParser opt-in)
import { createOmniParserTool, createOmniParserHealthTool } from "./src/vision/omniparser-tool.js";
import type { DetectedElement } from "./src/vision/set-of-marks.js";
import { createSightTool } from "./src/vision/sight.js";
// Vision
import { createUiTreeTool } from "./src/vision/ui-automation.js";
import { createUiInvokeTool } from "./src/vision/ui-invoke.js";
import { createUiResolveTool } from "./src/vision/ui-resolve.js";
import { createWindowClassifyTool } from "./src/vision/window-classify-tool.js";

/**
 * Builds a WorkflowEnvironment from the lumina-windows-bridge so the
 * workflow engine can evaluate `process_running` / `window_title_contains`
 * preconditions. Always returns SOMETHING — if the bridge is unreachable
 * (offline, WSL-only run), the engine simply won't skip any step.
 */
async function fetchWorkflowEnvironment(bridgeUrl: string): Promise<WorkflowEnvironment> {
  const empty: WorkflowEnvironment = {
    runningProcessNames: new Set<string>(),
    visibleWindowTitles: [],
  };
  if (!bridgeUrl || typeof fetch !== "function") {
    return empty;
  }
  const base = bridgeUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const [procsRes, winRes] = await Promise.all([
      fetch(`${base}/processes`, { signal: controller.signal }).catch(() => null),
      fetch(`${base}/window_control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: controller.signal,
      }).catch(() => null),
    ]);
    const runningProcessNames = new Set<string>();
    if (procsRes && procsRes.ok) {
      try {
        const body = (await procsRes.json()) as { processes?: Array<{ ProcessName?: string }> };
        for (const p of body.processes ?? []) {
          if (typeof p.ProcessName === "string" && p.ProcessName.trim()) {
            runningProcessNames.add(p.ProcessName.trim());
          }
        }
      } catch {
        /* ignore */
      }
    }
    const visibleWindowTitles: string[] = [];
    if (winRes && winRes.ok) {
      try {
        const body = (await winRes.json()) as { windows?: Array<{ title?: string }> };
        for (const w of body.windows ?? []) {
          if (typeof w.title === "string" && w.title.trim()) {
            visibleWindowTitles.push(w.title.trim());
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { runningProcessNames, visibleWindowTitles };
  } finally {
    clearTimeout(timer);
  }
}

export default definePluginEntry({
  id: "lumina-cognitive-os",
  name: "Lumina Cognitive OS",
  description:
    "Niveles 1-12 of the Lumina Cognitive Operating System: awareness, memory, vision, action, multi-agent, " +
    "intent router, MCP Gmail/Calendar/Drive, boot greeting, wake-word. Every capability is exposed as an " +
    "agent tool so the user can invoke it by voice via Start Talk.",

  register(api) {
    const raw = (api.pluginConfig ?? {}) as CognitiveConfig;
    const envPath = raw.envPath ?? DEFAULT_ENV_PATH;
    const luminaEnv = loadLuminaEnv({ envPath });
    const cfg = resolveCognitiveConfig(raw, envPath, luminaEnv);

    if (!cfg.enabled) {
      api.logger.info("[lumina-cognitive-os] disabled by config");
      return;
    }
    // Pollers, sidecars, the hotkey and timers start only in the gateway's live registration;
    // discovery and CLI loads only describe the tools.
    const host = hostDeps(api);
    const { live } = host;

    // Records what was actually registered (several tools are conditional) for the self model.
    const { register: registerTool, names: registeredToolNames } = createToolRecorder(api);

    // Env cache is warmed above so tool calls don't pay the read cost.

    // ── N10 Risk Engine ──────────────────────────────────────────
    const risk = new RiskEngine();
    registerTool(createRiskEvaluateTool(risk));
    registerTool(createRiskRecentTool(risk));

    // ── N1 Environment Awareness ─────────────────────────────────
    const awarenessBus = new AwarenessEventBus();
    const poller = new AwarenessPoller(cfg.awarenessIntervalMs, awarenessBus);
    const systemBridgeClient = createBridgeClient({ bridgeUrl: cfg.bridgeUrl });
    if (live) {
      poller.start();
    }
    registerTool(createAwarenessSnapshotTool(poller));
    registerTool(createAwarenessSubscribeTool(awarenessBus));
    registerTool(createWindowsContextTool(systemBridgeClient));
    // WhatsApp respond first: it is the fast one-call path (contact + message)
    // and the preferred tool for answering a notification quickly. The exact
    // metadata reply and status checks follow.
    registerTool(createWhatsappRespondTool(systemBridgeClient));
    registerTool(createPhoneLinkStatusTool(systemBridgeClient));
    registerTool(createPhoneLinkReplyTool(systemBridgeClient));

    // ── N2 Memory ────────────────────────────────────────────────
    const working = new WorkingMemoryStore(cfg.memoryDir);
    const episodic = createEpisodicMemory(host, cfg.memoryDir);
    const actionLog = new ActionLogStore(cfg.memoryDir);
    registerTool(createWorkingMemoryGetTool(working));
    registerTool(createWorkingMemorySetTool(working));
    registerTool(createEpisodicRememberTool(episodic));
    registerTool(createEpisodicRecallTool(episodic));
    // Spec 3 — semantic action log (auto-fed by workflow engine)
    registerTool(createWorkingMemoryRecallTool(actionLog));
    registerTool(createWorkingMemoryLogTool(actionLog));

    // ── N3 Vision ────────────────────────────────────────────────
    registerTool(createUiTreeTool());
    // Spec 2 — natural-language → automationId/bbox resolver
    registerTool(createUiResolveTool());
    // Native UIA pattern action (Invoke/SetValue/Toggle) by identity — more
    // reliable than coordinate clicks for off-screen / non-foreground elements.
    registerTool(createUiInvokeTool());
    // Live sight: current foreground + actionable elements from continuous
    // perception (served by the windows-bridge). Act-on-current-state in one step.
    registerTool(createSightTool(cfg.bridgeUrl));
    registerTool(createMultiMonitorTool());
    // §3 router: classify the foreground window → recommended engine order.
    registerTool(createWindowClassifyTool(cfg.bridgeUrl));

    // ── N4 Action ────────────────────────────────────────────────
    const planStore = createPlanStore();
    registerTool(createActionPlanTool(planStore));
    registerTool(createBrowserDriverTool({ enabled: cfg.browserDriverEnabled }));
    registerTool(createBrowserScreencastTool());
    registerTool(createBrowserSessionTool());
    // Smart Click / Type — closed-loop UIA-resolve → dispatch → verify.
    // Reuses Bridge + replayAllowedApps so the same per-process guard applies.
    const smartClickDeps = { bridgeUrl: cfg.bridgeUrl, allowedApps: cfg.replayAllowedApps };
    const smartClickTool = createSmartClickTool(smartClickDeps);
    const smartTypeTool = createSmartTypeTool(smartClickDeps);
    registerTool(smartClickTool);
    registerTool(smartTypeTool);
    // PC Operator suite: unified observe + scroll + drag.
    const pcObserveTool = createPcObserveTool(smartClickDeps);
    const pcScrollTool = createPcScrollTool(smartClickDeps);
    const pcDragTool = createPcDragTool(smartClickDeps);
    registerTool(pcObserveTool);
    registerTool(pcScrollTool);
    registerTool(pcDragTool);
    // Browser DOM-aware smart tools (reuse browserDriverEnabled flag).
    const browserSmartClickTool = createBrowserSmartClickTool({
      enabled: cfg.browserDriverEnabled,
    });
    const browserSmartTypeTool = createBrowserSmartTypeTool({ enabled: cfg.browserDriverEnabled });
    const browserDomObserveTool = createBrowserDomObserveTool({
      enabled: cfg.browserDriverEnabled,
    });
    const browserDomScreenshotTool = createBrowserDomScreenshotTool({
      enabled: cfg.browserDriverEnabled,
    });
    const browserNaturalTool = createBrowserNaturalTool({ enabled: cfg.browserDriverEnabled });
    registerTool(browserSmartClickTool);
    registerTool(browserSmartTypeTool);
    registerTool(browserDomObserveTool);
    registerTool(browserDomScreenshotTool);
    registerTool(browserNaturalTool);

    // App launcher/closer/discovery — Get-StartApps fuzzy fallback + close (WM_CLOSE).
    const appDeps = { bridgeUrl: cfg.bridgeUrl };
    registerTool(createAppListTool(appDeps));
    registerTool(createAppLaunchTool(appDeps));
    registerTool(createAppCloseTool(appDeps));

    // App Adapter Registry (§5): structural adapters preferred before generic
    // UIA — Office COM, Registry, Audio + a resolver that says which to use.
    registerTool(createAdapterResolveTool());
    registerTool(createOfficeTool());
    registerTool(createRegistryTool());
    registerTool(createAudioTool());

    // ── Camino A: PC Operator Loop (autonomous observe→think→act→verify) ─
    const pcOperatorCostMeter = new CostMeter({ log: actionLog });
    const pcOperatorBridgeClient = systemBridgeClient;
    const pcOperatorSkillHealth = new SkillHealthTracker({
      log: actionLog,
      notifyToast: (msg) => {
        // Best-effort Bridge toast so Dal actually sees the self-healing warning.
        pcOperatorBridgeClient
          .post("/notify_toast", { title: "Lumina — Skill Health", message: msg }, 3_000)
          .catch(() => undefined);
      },
    });
    const pcOperatorEngine = new PcOperatorEngine({
      brain: createMultiProviderBrain({
        envPath: cfg.envPath,
        defaultProvider: cfg.pcOperatorProvider,
        defaultModel: cfg.pcOperatorModel || undefined,
      }),
      tools: {
        smart_click: smartClickTool,
        smart_type: smartTypeTool,
        pc_scroll: pcScrollTool,
        pc_drag: pcDragTool,
        pc_observe: pcObserveTool,
        browser_smart_click: browserSmartClickTool,
        browser_smart_type: browserSmartTypeTool,
        browser_dom_observe: browserDomObserveTool,
        browser_dom_screenshot: browserDomScreenshotTool,
      },
      bridge: pcOperatorBridgeClient,
      allowedApps: cfg.replayAllowedApps,
      log: actionLog,
      costMeter: pcOperatorCostMeter,
      onLearnedSkillResult: (result) => pcOperatorSkillHealth.record(result),
    });
    registerTool(createPcDoTool(pcOperatorEngine));
    registerTool(createPcDoStatusTool(pcOperatorEngine));
    registerTool(createPcDoListTool(pcOperatorEngine));
    registerTool(createPcDoAbortTool(pcOperatorEngine));
    registerTool(createPcDoCostSummaryTool(pcOperatorCostMeter));
    registerTool(createPcDoSkillHealthTool(pcOperatorSkillHealth));
    registerTool(createPcDoSkillResetTool(pcOperatorSkillHealth));
    api.logger.info(
      `[lumina-cognitive-os] PC Operator Loop ready (provider=${cfg.pcOperatorProvider}, model=${cfg.pcOperatorModel || "auto"}). Call lumina_pc_do to start.`,
    );

    // ── Continuous Perception (opt-in via lumina_perception_start) ────
    const perceptionBus = createPerceptionBus(200);
    const perceptionProcess = new PerceptionProcess(perceptionBus, {
      outDir: process.env.LUMINA_PERCEPTION_OUTDIR ?? "",
      fps: cfg.perceptionFps,
    });
    const perceptionDeps = { process: perceptionProcess, bus: perceptionBus };
    registerTool(createPerceptionStartTool(perceptionDeps));
    registerTool(createPerceptionStopTool(perceptionDeps));
    registerTool(createPerceptionPauseTool(perceptionDeps));
    registerTool(createPerceptionResumeTool(perceptionDeps));
    registerTool(createPerceptionTuneTool(perceptionDeps));
    registerTool(createPerceptionStatusTool(perceptionDeps));
    registerTool(createPerceptionRecentTool(perceptionDeps));
    registerTool(createPerceptionHealthTool());
    // Always-on vision: start the continuous semantic perception loop so Lumina
    // "sees" — foreground app + its actionable UIA elements kept fresh — instead
    // of being blind between on-demand screenshots. Gated by config for privacy.
    if (cfg.perceptionAutoStart && live) {
      try {
        const started = perceptionProcess.start();
        api.logger.info(
          `[lumina-cognitive-os] perception auto-start: ${started.ok ? `on @ ${cfg.perceptionFps}fps` : `failed: ${started.error}`}`,
        );
      } catch (err) {
        api.logger.warn(
          `[lumina-cognitive-os] perception auto-start error: ${(err as Error).message}`,
        );
      }
    }
    // (Bridging perception events into the strictly-typed awareness bus
    // would require extending AwarenessEvent + operative rules; skipped for
    // now — events are consumable via lumina_perception_recent.)

    // ── Kill switch (§9): global panic hotkey + software twin ─────────
    // Always-on so Dal can freeze all autonomous PC control instantly (default
    // Ctrl+Alt+K), even mid-action. The switch itself is a pure in-process
    // singleton the loop engine + dispatcher already consult; this just wires
    // the physical hotkey into it.
    const killSwitchProcess = new KillSwitchProcess({
      onEngage: (chord) =>
        api.logger.warn(`[lumina-cognitive-os] KILL SWITCH engaged via ${chord} — operator frozen`),
    });
    registerTool(createKillSwitchTool({ process: killSwitchProcess }));
    if (live) {
      try {
        const ks = killSwitchProcess.start();
        api.logger.info(
          `[lumina-cognitive-os] kill-switch hotkey: ${ks.ok ? "armed (Ctrl+Alt+K)" : `unavailable: ${ks.error}`}`,
        );
      } catch (err) {
        api.logger.warn(`[lumina-cognitive-os] kill-switch start error: ${(err as Error).message}`);
      }
    }

    // ── N5 Director ──────────────────────────────────────────────
    registerTool(createDirectorRouteTool());

    // ── N9 Intent router ─────────────────────────────────────────
    registerTool(createIntentRunTool());

    // Spec 1 — Workflow recipes (auto-logged into action log)
    const workflowEngine = new WorkflowEngine({
      recipesDir: cfg.recipesDir || undefined,
      log: actionLog,
    });
    registerTool(createWorkflowListTool(workflowEngine));
    registerTool(
      createWorkflowRunTool(workflowEngine, () => fetchWorkflowEnvironment(cfg.bridgeUrl)),
    );

    // ── Agent Skills (agentskills.io standard, Fase 1 plan integración) ──
    const skillLoader = new SkillLoader({ skillsDir: cfg.skillsDir });
    registerTool(createSkillListTool(skillLoader));
    registerTool(createSkillDescribeTool(skillLoader));
    registerTool(createSkillReadAssetTool(skillLoader));
    registerTool(createSkillRunTool(skillLoader, actionLog));
    const loadedSkills = skillLoader.list().length;
    const loadErrors = skillLoader.errors().length;
    api.logger.info(
      `[lumina-cognitive-os] Agent Skills: ${loadedSkills} loaded, ${loadErrors} errors (dir=${cfg.skillsDir})`,
    );

    // ── Fase 2: Code execute (sandboxed subprocess) ─────────────
    registerTool(createCodeExecuteTool({ risk, log: actionLog }));

    // ── Fase 3: Operative daemon (proactive Lumina) ─────────────
    const operative = new OperativeDaemon({
      bus: awarenessBus,
      log: actionLog,
      rulesPath: cfg.operativeRulesPath || undefined,
      autoStart: cfg.operativeEnabled,
    });
    registerTool(createOperativeStatusTool(operative));
    registerTool(createOperativeEnableTool(operative));
    registerTool(createOperativeDisableTool(operative));
    registerTool(createOperativeReloadTool(operative));
    registerTool(createOperativeRecentTool(operative));

    // ── Fase 6: CodeAct loop (LLM-writes-Python pattern) ─────────
    const codeact = new CodeActEngine({
      risk,
      log: actionLog,
      workspaceRoot: cfg.codeActWorkspaceRoot,
      bridgeUrl: cfg.bridgeUrl,
    });
    registerTool(createCodeActStartTool(codeact));
    registerTool(createCodeActStepTool(codeact));
    registerTool(createCodeActStatusTool(codeact));
    registerTool(createCodeActEndTool(codeact));

    // ── LfD Fase A: Visual Engine (OmniParser, opt-in) ───────────
    registerTool(createOmniParserTool());
    registerTool(createOmniParserHealthTool());
    // Wire the OmniParser sidecar into the vision_grounded replay strategy.
    configureOmniParserClient(async (params) => {
      const args: string[] = ["--image", params.imagePath];
      const r = await runPythonSidecarJson<{
        ok: boolean;
        elements?: DetectedElement[];
        error?: string;
      }>("omniparser", args, { timeoutMs: 90_000 });
      if (!r.ok) {
        return { ok: false, error: r.error };
      }
      const data = r.data ?? { ok: false };
      return { ok: data.ok, elements: data.elements, error: data.error };
    });

    // ── LfD Fase B: Recorder ─────────────────────────────────────
    const recorderStore = createRecorderStore(cfg.recordingsDir, host.openStore, (error) =>
      api.logger.warn(`[lumina-cognitive-os] recorder metadata: ${String(error)}`),
    );
    const recorder = new RecorderProcess(recorderStore);
    registerTool(createRecorderStartTool({ recorder, log: actionLog }));
    registerTool(createRecorderStopTool({ recorder, log: actionLog }));
    registerTool(createRecorderPauseTool({ recorder, log: actionLog }));
    registerTool(createRecorderResumeTool({ recorder, log: actionLog }));
    registerTool(createRecorderStatusTool({ recorder, log: actionLog }));
    registerTool(createRecorderListTool({ recorder, log: actionLog }));
    registerTool(createRecorderGetTool({ recorder, log: actionLog }));
    registerTool(createRecorderDeleteTool({ recorder, log: actionLog }));

    // ── LfD Fase C: Replay Engine ────────────────────────────────
    const replayEngine = new ReplayEngine({
      store: recorderStore,
      log: actionLog,
      liveContextProvider: defaultLiveContextProvider(cfg.bridgeUrl),
      actionDispatcher: defaultActionDispatcher({
        bridgeUrl: cfg.bridgeUrl,
        allowedApps: cfg.replayAllowedApps,
      }),
    });
    registerTool(createReplayRunTool(replayEngine));
    registerTool(createReplayStatusTool(replayEngine));
    registerTool(createReplayListTool(replayEngine));
    registerTool(createReplayAbortTool(replayEngine));
    registerTool(createReplayStrategiesTool());

    // ── LfD Fase D: Demo → Skill generator ───────────────────────
    registerTool(
      createSkillFromRecordingTool({
        recorderStore,
        skillsDir: cfg.skillsDir,
        log: actionLog,
      }),
    );

    // ── LfD Fase E: Skill eval tracker ───────────────────────────
    const skillEval = new SkillEvalStore(cfg.skillsDir);
    registerTool(createSkillEvalTool(skillEval));
    registerTool(createSkillEvalRecordTool(skillEval));

    // ── N11 MCP ──────────────────────────────────────────────────
    registerTool(createGmailTool());
    registerTool(createCalendarTool());
    registerTool(createDriveTool());
    // Raw table access (status/schema/query/mutate) belongs to the lumina-supabase plugin;
    // this one keeps only Lumina's memory view of the same database.
    const memoryDeps = {
      envPath: cfg.envPath,
      schema: cfg.supabaseSchema,
      maxRows: cfg.supabaseMaxRows,
      allowWrites: cfg.supabaseAllowWrites,
      warehousesPath: cfg.warehousesPath,
    };
    registerTool(createLuminaMemoryStatusTool(memoryDeps));
    registerTool(createLuminaMemorySearchTool(memoryDeps));
    registerTool(createLuminaMemoryRememberTool(memoryDeps));
    registerTool(createLuminaWarehouseCatalogTool(memoryDeps));
    api.logger.info(
      `[lumina-cognitive-os] Supabase memory tools ready (schema=${cfg.supabaseSchema}, writes=${cfg.supabaseAllowWrites ? "enabled" : "disabled"}).`,
    );

    // ── N12 Presence ─────────────────────────────────────────────
    registerTool(createBootGreetingTool());
    const wake = new WakeWordDaemon({
      model: cfg.wakeWordModel,
      threshold: 0.55,
    });
    registerTool(createWakeWordTool(wake));
    if (cfg.wakeWordEnabled && live) {
      const r = wake.start();
      if (!r.ok) {
        api.logger.warn(`[lumina-cognitive-os] wake-word daemon failed to start: ${r.error}`);
      } else {
        api.logger.info("[lumina-cognitive-os] wake-word daemon running");
      }
    }

    // ── N8 Transparency ──────────────────────────────────────────
    const activity = new ActivityLog();
    setActiveActivityLog(activity);
    registerTool(createTransparencyPublishTool(activity));
    registerTool(createTransparencyRecentTool(activity));

    // ── Governance (Microsoft Agent Governance Toolkit pattern) ──
    const governance = new GovernanceEngine(
      cfg.governancePolicyPath || "c:/I24D_WhatsApp/governance-policy.json",
    );
    registerTool(createGovernanceEvaluateTool(governance));
    registerTool(createGovernancePolicyTool(governance));

    // ── Cognitive core ───────────────────────────────────────────
    // Router -> world model + attention queue -> observe-only loop, with the
    // global workspace, self model and safety-gated body on top.
    const cognition = startCognitiveCore({
      ...host,
      memoryDir: cfg.memoryDir,
      awarenessBus,
      environment: () => poller.current(),
      working: () => working.get(),
      episodicMemory: episodic,
      plans: planStore,
      activity,
      toolNames: registeredToolNames,
      registerTool,
      sensorDaemons: { microphone: wake, camera: perceptionProcess },
      perceptionBus,
    });

    // Risk + awareness piped into the transparency log so the UI sees them.
    risk.on((d) => {
      if (d.tier === "SAFE") {
        return;
      } // SAFE → no noise.
      activity.push({
        category: "risk",
        summary: `${d.input.action} → ${d.tier}`,
        detail: d.reason,
        risk: d.tier,
        ref: { input: d.input, ruleId: d.ruleId },
      });
    });
    awarenessBus.on((e) => {
      activity.push({
        category: "intent",
        summary: `Cambio del entorno: ${e.kind}`,
        ref: e,
      });
    });

    // ── LUMINA-MESH/1 ────────────────────────────────────────────
    // The durable side channel: outbox, dispatcher and inbox on the host's
    // plugin-state worker, polled with backoff. Registered after the core so a
    // handler can reach the activity log the core already publishes.
    const mesh = startMeshRuntime({
      live,
      ...(host.openStore ? { openStore: host.openStore } : {}),
      logger: {
        info: (message) => api.logger.info(message),
        warn: (message) => api.logger.warn(message),
        error: (message) => api.logger.error(message),
      },
      activity,
      namespaces: COGNITIVE_STORE_NAMESPACES,
      enabled: cfg.meshEnabled,
      registerHttpRoute: (route) => api.registerHttpRoute(route),
    });
    registerTool(createMeshStatusTool(() => mesh?.runtime));

    // ── Cleanup on plugin teardown ───────────────────────────────
    api.lifecycle.registerRuntimeLifecycle({
      id: "lumina-cognitive-os-cleanup",
      description:
        "Stop the cognitive core, mesh loop, awareness poller, wake-word daemon, operative daemon, recorder, and perception sidecar.",
      cleanup: () => {
        // Awaited inside the runtime: a pass holds a lease, and abandoning it
        // makes the next process wait out a reclaim timeout for nothing.
        void mesh?.stop();
        cognition?.dispose();
        poller.stop();
        wake.stop();
        operative.stop();
        recorder.shutdown();
        if (perceptionProcess.isRunning()) {
          perceptionProcess.shutdown();
        }
        killSwitchProcess.shutdown();
      },
    });
  },
});
