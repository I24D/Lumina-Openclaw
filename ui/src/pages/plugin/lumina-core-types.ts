// Shapes of the lumina-cognitive-os gateway methods the Lumina tab reads. The
// plugin owns them (dashboard/owner-channel.ts); only the fields shown here.

import type { MascotMood } from "../../components/mascot-pose.ts";

export type CoreWorldNode = {
  id: string;
  label: string;
  kind: string;
  children: CoreWorldNode[];
};

export type LuminaCorePerson = {
  id: string;
  name: string;
  role: string;
  relationship?: string;
  preferences: Record<string, string>;
  consent: { faceRecognition: boolean; voiceRecognition: boolean; recording: boolean };
};

export type LuminaCoreSubsystem = {
  name: string;
  status: string;
  detail: string;
  recommendation?: string;
  critical: boolean;
};

export const LUMINA_CORE_MODES = ["normal", "child", "companion", "maintenance"] as const;
export type LuminaCoreMode = (typeof LUMINA_CORE_MODES)[number];

export type CoreStatePayload = {
  version: string;
  /** The plugin's expressions are a subset of the mascot's moods; functional state, never a feeling. */
  expression?: { expression: MascotMood; reason: string };
  model: string | null;
  workspace: {
    currentGoal: { title: string } | null;
    attentionTarget: { source: string; kind: string } | null;
    activeTask: { event: string; outcome?: string } | null;
    userContext: { intent?: string | null; activeWindow?: string | null } | null;
    pendingEvents: number;
    uncertainty: { staleBeliefs: Array<{ label: string; confidence: number }> };
  };
  self: {
    autonomyLevel: number;
    body: { mode: string };
    sensors: Array<{ kind: string; available: boolean; detail?: string }>;
    limitations: string[];
  };
  safety: {
    emergencyStop: boolean;
    overrides: {
      paused: boolean;
      autonomyCeiling: number | null;
      disabledCapabilities: string[];
      updatedBy: string;
    };
    pendingConfirmations: Array<{
      id: string;
      intent: unknown;
      requestedBy: string;
      expiresAtISO: string;
    }>;
    invariants: Array<{ id: string; rule: string; spec: string[] }>;
    audit: { ok: boolean; entries: number; brokenAt?: number };
  };
  privacy: { camera: boolean; microphone: boolean; privateMode: boolean; recording: boolean };
  /** Older cores do not report an interaction mode. */
  mode?: {
    mode: LuminaCoreMode;
    sinceISO: string;
    by: string;
    lastSummary?: string;
    restrictions: { paused: boolean; disabledCapabilities: string[] };
  };
  people: LuminaCorePerson[];
  presence: { present: Array<{ name: string; speaking?: boolean }> };
  world: CoreWorldNode[];
  health: { overall: string; beats: number; subsystems: LuminaCoreSubsystem[] };
  energy: { detail: string };
  robot: unknown;
  /** What the body adapter reports (engine, pose, grip) when it is a simulator. */
  simulator?: Record<string, unknown> | null;
  audit: Array<{ atISO: string; actor: string; action: string; execution: string; reason: string }>;
  cycles: Array<{
    atISO: string;
    event: { source: string; kind: string };
    outcome?: string;
    reason: string;
  }>;
  events: Array<{
    event: { atISO: string; source: string; kind: string };
    verdict: { salience: number; admitted: boolean };
  }>;
  body: Array<{
    atISO: string;
    intent: { type: string };
    requestedBy?: string;
    review: { verdict: string };
    outcome?: { detail: string };
  }>;
  reflection?: {
    atISO: string;
    findings: Array<{ kind: string; subject: string; count: number; detail: string }>;
    proposedLessons: Array<{
      trigger: string;
      claim: string;
      confidence: number;
      evidence: string;
    }>;
  } | null;
  /** Learning to move in simulation; null without the MuJoCo body, absent in older cores. */
  simTraining?: {
    running: boolean;
    startedAtISO?: string;
    progress?: { iteration: number; bestScore: number };
    error?: string;
    report?: {
      atISO: string;
      accepted: boolean;
      baseline: LuminaCoreSimEvaluation;
      learned: LuminaCoreSimEvaluation;
    };
  } | null;
  /** What Lumina remembers, with origin and confidence; absent in older cores. */
  memory?: {
    lessons: Array<{
      id: string;
      trigger: string;
      claim: string;
      confidence: number;
      origin: string;
      archived: boolean;
      updatedAtISO: string;
    }>;
    episodes: Array<{ id: string; atISO: string; kind: string; summary: string; tags: string[] }>;
    entities: Array<{
      id: string;
      label: string;
      kind: string;
      origin: string;
      confidence: number;
      observations: number;
      lastSeenISO: string;
    }>;
    beliefs: Array<{
      id: string;
      holderId: string;
      stance: string;
      proposition: string;
      confidence: number;
      provenance: string;
      atISO: string;
    }>;
  };
  /** Models and datasets with pinned hashes; absent in older cores. */
  artifacts?: Array<{
    id: string;
    kind: "model" | "dataset";
    name: string;
    source: string;
    license: string;
    version: string;
    purpose: string;
    sha256: string;
    status: "ok" | "changed" | "missing" | "unregistered";
    checkedISO: string;
  }>;
  evaluation?: {
    atISO: string;
    results: Array<{ suite: string; name: string; passed: boolean; detail: string }>;
    scores: Record<string, { passed: number; total: number }>;
    performance: { routerEventsPerSecond: number; loopP50Ms: number; loopP95Ms: number };
  } | null;
  sensors?: {
    camera?: LuminaCoreSensorStatus;
    microphone?: LuminaCoreSensorStatus;
    templates: Array<{ personId: string; modality: "face" | "voice"; samples: number }>;
  };
};

export type LuminaCoreSensorStatus = {
  running: boolean;
  allowed: boolean;
  present: Array<{ personId: string; name: string }>;
  unknown: number;
  lastReadingAtISO?: string;
  lastError?: string;
};

export type LuminaCoreSimEvaluation = {
  episodes: number;
  successRate: number;
  personContacts: number;
  obstacleContacts: number;
  meanSeconds: number;
  minPersonM: number | null;
};

export type LuminaCoreTab =
  | "live"
  | "safety"
  | "people"
  | "world"
  | "memory"
  | "health"
  | "robot"
  | "developer";

export type LuminaCoreUiState = {
  tab: LuminaCoreTab;
  state: CoreStatePayload | null;
  loading: boolean;
  error: string | null;
  /** Command in flight; buttons stay disabled until it settles. */
  pending: string | null;
  /** The last answer a command gave, e.g. a refusal and its reason. */
  notice: string | null;
  /** What the Memory view filters by. */
  memoryQuery: string;
  requestUpdate: (() => void) | null;
};
