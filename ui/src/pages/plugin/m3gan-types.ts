// Shapes of the lumina-cognitive-os gateway methods the M3GAN tab reads. The
// plugin owns them (dashboard/owner-channel.ts); only the fields shown here.

import type { MascotMood } from "../../components/mascot-pose.ts";

export type M3ganWorldNode = {
  id: string;
  label: string;
  kind: string;
  children: M3ganWorldNode[];
};

export type M3ganPerson = {
  id: string;
  name: string;
  role: string;
  relationship?: string;
  preferences: Record<string, string>;
  consent: { faceRecognition: boolean; voiceRecognition: boolean; recording: boolean };
};

export type M3ganSubsystem = {
  name: string;
  status: string;
  detail: string;
  recommendation?: string;
  critical: boolean;
};

export const M3GAN_MODES = ["normal", "child", "companion", "maintenance"] as const;
export type M3ganMode = (typeof M3GAN_MODES)[number];

export type M3ganStatePayload = {
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
    mode: M3ganMode;
    sinceISO: string;
    by: string;
    lastSummary?: string;
    restrictions: { paused: boolean; disabledCapabilities: string[] };
  };
  people: M3ganPerson[];
  presence: { present: Array<{ name: string; speaking?: boolean }> };
  world: M3ganWorldNode[];
  health: { overall: string; beats: number; subsystems: M3ganSubsystem[] };
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
    camera?: M3ganSensorStatus;
    microphone?: M3ganSensorStatus;
    templates: Array<{ personId: string; modality: "face" | "voice"; samples: number }>;
  };
};

export type M3ganSensorStatus = {
  running: boolean;
  allowed: boolean;
  present: Array<{ personId: string; name: string }>;
  unknown: number;
  lastReadingAtISO?: string;
  lastError?: string;
};

export type M3ganTab = "live" | "safety" | "people" | "world" | "health" | "robot" | "developer";

export type M3ganUiState = {
  tab: M3ganTab;
  state: M3ganStatePayload | null;
  loading: boolean;
  error: string | null;
  /** Command in flight; buttons stay disabled until it settles. */
  pending: string | null;
  /** The last answer a command gave, e.g. a refusal and its reason. */
  notice: string | null;
  requestUpdate: (() => void) | null;
};
