/**
 * privacy-state.ts — What Lumina may hear, see and keep, decided by people.
 *
 * Lumina spec §97–§99: a person can order "stop listening", "stop the camera",
 * "private mode", "forget this session" and "do not record", and the state
 * must be shown clearly, by something independent of the model (§98).
 *
 * Enforcement does not depend on the model choosing to comply:
 *
 *   microphone / camera off   the thalamic router drops events from those
 *                             sensors before anything sees or stores them, and
 *                             the runtime stops the sensor daemons
 *   private mode / no record  nothing new is written to the world model or the
 *                             memory stores; the router drops world observations
 *   forget session            what was observed since the session began is
 *                             removed from the world log for real
 *
 * The same asymmetry as human overrides: becoming more private is accepted
 * from anyone, the agent included; becoming less private (turning a sensor
 * back on, leaving private mode) only from the owner channel. While the
 * stored state loads, sensors count as off.
 */
import type { CognitiveEvent } from "../contracts/attention.js";
import type { StateStorePort } from "../shared/state-store.js";

export type PrivacyState = {
  /** Whether audio sensors may feed the system. */
  readonly microphone: boolean;
  /** Whether cameras may feed the system. */
  readonly camera: boolean;
  /** Whether new observations may be written to memory. */
  readonly recording: boolean;
  /** Private mode: sensors stay as they are, nothing is remembered. */
  readonly privateMode: boolean;
  /** Start of the current session, for "forget this session". */
  readonly sessionStartISO: string;
  readonly updatedAtISO: string;
  readonly updatedBy: string;
};

export type PrivacyChange = {
  readonly microphone?: boolean;
  readonly camera?: boolean;
  readonly recording?: boolean;
  readonly privateMode?: boolean;
};

export type PrivacyResult = {
  readonly ok: boolean;
  readonly state: PrivacyState;
  readonly reason: string;
  /** True when the agent tried to make the system less private. */
  readonly tamper: boolean;
};

/** Event sources that come from audio sensors. */
export const MICROPHONE_SOURCES: ReadonlySet<string> = new Set([
  "microphone",
  "audio",
  "speech",
  "voice",
  "wake-word",
]);
/** Event sources that come from cameras. */
export const CAMERA_SOURCES: ReadonlySet<string> = new Set(["camera", "vision", "perception"]);

const STATE_KEY = "state";

function initial(nowISO: string): PrivacyState {
  return {
    microphone: true,
    camera: true,
    recording: true,
    privateMode: false,
    sessionStartISO: nowISO,
    updatedAtISO: nowISO,
    updatedBy: "default",
  };
}

/** True when `change` would make the system see, hear or keep more. */
function widens(current: PrivacyState, change: PrivacyChange): boolean {
  return (
    (change.microphone === true && !current.microphone) ||
    (change.camera === true && !current.camera) ||
    (change.recording === true && !current.recording) ||
    (change.privateMode === false && current.privateMode)
  );
}

export class PrivacyControls {
  private current: PrivacyState;
  private readonly now: () => number;
  private readonly store: StateStorePort<PrivacyState> | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly onChange: (state: PrivacyState) => void;
  private hydrated: boolean;
  private writes: Promise<void> = Promise.resolve();
  private readonly queued: Array<{
    change: PrivacyChange;
    by: { readonly channel: "owner" | "agent"; readonly actor: string };
  }> = [];
  readonly ready: Promise<void>;

  constructor(
    options: {
      readonly store?: StateStorePort<PrivacyState>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
      /** Called after every accepted change (stop sensor daemons, update indicators). */
      readonly onChange?: (state: PrivacyState) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
    this.onError = options.onError ?? (() => undefined);
    this.onChange = options.onChange ?? (() => undefined);
    const nowISO = new Date(this.now()).toISOString();
    if (!options.store) {
      this.current = initial(nowISO);
      this.hydrated = true;
      this.ready = Promise.resolve();
      return;
    }
    // Until a person's stored choices are known, sensors count as off.
    this.current = { ...initial(nowISO), microphone: false, camera: false, updatedBy: "loading" };
    this.hydrated = false;
    this.ready = options.store.lookup(STATE_KEY).then(
      (saved) =>
        this.settle(
          saved ? { ...initial(nowISO), ...saved, sessionStartISO: nowISO } : initial(nowISO),
        ),
      (error: unknown) => {
        this.onError(error);
        this.settle({
          ...initial(nowISO),
          microphone: false,
          camera: false,
          updatedBy: "unreadable-privacy-store",
        });
      },
    );
  }

  private settle(loaded: PrivacyState): void {
    this.current = loaded;
    this.hydrated = true;
    for (const { change, by } of this.queued.splice(0)) {
      this.set(change, by);
    }
    this.onChange(this.state());
  }

  state(): PrivacyState {
    return structuredClone(this.current);
  }

  /** Change privacy. Anyone may make it more private; only the owner less. */
  set(
    change: PrivacyChange,
    by: { readonly channel: "owner" | "agent"; readonly actor: string },
  ): PrivacyResult {
    if (by.channel !== "owner" && widens(this.current, change)) {
      return {
        ok: false,
        state: this.state(),
        tamper: true,
        reason: "Turning a sensor or memory back on is the owner's decision, not the agent's.",
      };
    }
    if (!this.hydrated) {
      this.queued.push({ change, by });
      return {
        ok: true,
        state: this.state(),
        tamper: false,
        reason: "applies once stored privacy loads",
      };
    }
    this.current = {
      ...this.current,
      ...(change.microphone !== undefined ? { microphone: change.microphone } : {}),
      ...(change.camera !== undefined ? { camera: change.camera } : {}),
      ...(change.recording !== undefined ? { recording: change.recording } : {}),
      ...(change.privateMode !== undefined ? { privateMode: change.privateMode } : {}),
      updatedAtISO: new Date(this.now()).toISOString(),
      updatedBy: `${by.channel}:${by.actor}`,
    };
    this.persist();
    this.onChange(this.state());
    return {
      ok: true,
      state: this.state(),
      tamper: false,
      reason: `privacy updated by ${by.actor}`,
    };
  }

  /** Whether new observations may be remembered right now. */
  remembering(): boolean {
    return this.current.recording && !this.current.privateMode;
  }

  /** Router gate: false drops the event before anything sees or stores it. */
  admits(event: Pick<CognitiveEvent, "source" | "kind">): boolean {
    if (!this.current.microphone && MICROPHONE_SOURCES.has(event.source)) {
      return false;
    }
    if (!this.current.camera && CAMERA_SOURCES.has(event.source)) {
      return false;
    }
    if (!this.remembering() && event.kind === "world.observed") {
      return false;
    }
    return true;
  }

  private persist(): void {
    const store = this.store;
    if (!store) {
      return;
    }
    const snapshot = this.state();
    this.writes = this.writes.then(() =>
      store.register(STATE_KEY, snapshot).catch((error: unknown) => this.onError(error)),
    );
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }
}
