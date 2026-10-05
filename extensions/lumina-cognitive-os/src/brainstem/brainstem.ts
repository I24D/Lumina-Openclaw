/**
 * brainstem.ts — Vital functions that keep working when the model does not.
 *
 * M3GAN spec §3.1 (health checks, heartbeat, watchdog, energy, connectivity,
 * sensors, error detection, recovery, safe state; it must work with the main
 * model disconnected), §112 (health per service), §124 (self-diagnostics) and
 * §127 (detect, isolate, stop the affected subsystem, notify, recover safely).
 *
 * Each subsystem is a probe: a cheap function returning ok / degraded / down
 * / absent with a detail and a recommendation. The brainstem runs every probe
 * on a timer and reacts only to transitions:
 *
 *   critical subsystem goes down   isolate: stop the body, pause autonomy,
 *                                  notify; never resume on its own
 *   any subsystem degrades         notify and record
 *   a subsystem recovers           record it; resuming autonomy stays a
 *                                  person's decision (it widens authority)
 *
 * "absent" is not a failure: a desktop has no camera and no body by design.
 * Nothing here calls a language model.
 */

export type HealthStatus = "ok" | "degraded" | "down" | "absent";

export type ProbeResult = {
  readonly status: HealthStatus;
  readonly detail: string;
  /** What a person or the system should do about it. */
  readonly recommendation?: string;
};

export type Probe = {
  readonly name: string;
  /** A critical subsystem going down isolates the body and pauses autonomy. */
  readonly critical: boolean;
  readonly check: () => ProbeResult | Promise<ProbeResult>;
};

export type SubsystemHealth = ProbeResult & {
  readonly name: string;
  readonly critical: boolean;
  readonly checkedAtISO: string;
};

export type HealthSnapshot = {
  /** ok: all fine · degraded: something is off · down: a critical subsystem is down */
  readonly overall: "ok" | "degraded" | "down";
  readonly atISO: string;
  readonly subsystems: ReadonlyArray<SubsystemHealth>;
  readonly beats: number;
};

export type BrainstemOptions = {
  readonly probes: ReadonlyArray<Probe>;
  /** A critical subsystem just went down. */
  readonly onCriticalDown?: (subsystem: SubsystemHealth) => void | Promise<void>;
  /** A subsystem just degraded or went down (critical or not). */
  readonly onDegraded?: (subsystem: SubsystemHealth) => void;
  readonly onRecovered?: (subsystem: SubsystemHealth) => void;
  readonly now?: () => number;
  readonly intervalMs?: number;
};

const FAILING: ReadonlySet<HealthStatus> = new Set(["degraded", "down"]);

export class Brainstem {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private last = new Map<string, SubsystemHealth>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private beats = 0;
  private ticking: Promise<HealthSnapshot> | undefined;

  constructor(private readonly options: BrainstemOptions) {
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1000, options.intervalMs ?? 30_000);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run every probe once; overlapping calls share the same run. */
  tick(): Promise<HealthSnapshot> {
    this.ticking ??= this.run().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  status(): HealthSnapshot {
    return this.snapshot();
  }

  private async run(): Promise<HealthSnapshot> {
    const atISO = new Date(this.now()).toISOString();
    const next = new Map<string, SubsystemHealth>();
    for (const probe of this.options.probes) {
      let result: ProbeResult;
      try {
        result = await probe.check();
      } catch (error) {
        // A probe that throws is itself a finding, never a crash of the brainstem.
        result = {
          status: "down",
          detail: `Probe failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const health: SubsystemHealth = {
        ...result,
        name: probe.name,
        critical: probe.critical,
        checkedAtISO: atISO,
      };
      next.set(probe.name, health);
      await this.react(this.last.get(probe.name), health);
    }
    this.last = next;
    this.beats++;
    return this.snapshot();
  }

  private async react(before: SubsystemHealth | undefined, after: SubsystemHealth): Promise<void> {
    const wasFailing = before !== undefined && FAILING.has(before.status);
    const isFailing = FAILING.has(after.status);
    try {
      if (isFailing && (!before || before.status !== after.status)) {
        this.options.onDegraded?.(after);
        if (after.critical && after.status === "down") {
          await this.options.onCriticalDown?.(after);
        }
      } else if (wasFailing && !isFailing) {
        this.options.onRecovered?.(after);
      }
    } catch {
      /* a reaction that fails must not stop the heartbeat */
    }
  }

  private snapshot(): HealthSnapshot {
    const subsystems = [...this.last.values()];
    const overall = subsystems.some((s) => s.critical && s.status === "down")
      ? "down"
      : subsystems.some((s) => FAILING.has(s.status))
        ? "degraded"
        : "ok";
    return {
      overall,
      atISO: new Date(this.now()).toISOString(),
      subsystems: structuredClone(subsystems),
      beats: this.beats,
    };
  }
}
