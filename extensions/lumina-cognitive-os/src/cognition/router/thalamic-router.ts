import { AttentionQueue, type InterruptDecision, type QueuedEvent } from "../attention-queue.js";
/**
 * thalamic-router.ts — The one door every perception walks through.
 *
 * Producers (environment awareness, vision, audio, chat, calendar, a body)
 * hand a `CognitiveEvent` to `ingest()` and are done: they never call each
 * other, and they never call the cognitive loop (M3GAN spec §3.3, "no acoplar
 * servicios directamente entre sí").
 *
 * The router does three things with each event:
 *
 *   classify   the attention filter scores it (importance/urgency/novelty)
 *   route      every subscriber whose pattern matches gets it, admitted or
 *              not; cheap consumers such as the world model need every
 *              sighting, including the dull ones
 *   enqueue    only admitted events reach the attention queue, which is what
 *              the expensive cognitive cycle drains; this is how "do not send
 *              every sensor to the language model" is enforced
 *
 * Before any of that, an optional admission gate can drop an event outright:
 * that is how privacy works (a camera that was switched off produces events
 * nobody sees, routes or stores), without trusting any consumer to ignore them.
 *
 * Transport is in-process today. The surface is deliberately small so a NATS,
 * MQTT or ROS 2 bridge can later sit behind `ingest()` without touching any
 * consumer.
 */
import { AttentionFilter, type AttentionVerdict, type CognitiveEvent } from "../attention.js";

/** Glob patterns over `source` and `kind`; `*` matches any run of characters. */
export type EventPattern = {
  readonly source?: string;
  readonly kind?: string;
};

export type RoutedEvent = {
  readonly event: CognitiveEvent;
  readonly verdict: AttentionVerdict;
};

export type RouteHandler = (routed: RoutedEvent) => void;
export type AdmittedListener = (item: QueuedEvent) => void;

export type IngestResult = {
  readonly verdict: AttentionVerdict;
  /** Subscribers that received the event. */
  readonly delivered: number;
  /** Whether the event is now waiting for a cognitive cycle. */
  readonly queued: boolean;
  /** An older pending event dropped to make room. */
  readonly evicted?: CognitiveEvent;
  /** True when the admission gate refused the event: nothing saw or kept it. */
  readonly dropped?: boolean;
};

export type ThalamicRouterOptions = {
  readonly attention?: AttentionFilter;
  readonly queue?: AttentionQueue;
  readonly now?: () => number;
  /** Ingested events retained for inspection. Default 128. */
  readonly recentLimit?: number;
  /** A failing consumer is reported here instead of breaking the producer. */
  readonly onConsumerError?: (error: unknown, event: CognitiveEvent) => void;
  /** Return false to drop an event before attention, routing and history (privacy). */
  readonly admit?: (event: CognitiveEvent) => boolean;
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u");
}

type Subscription = {
  readonly source: RegExp | undefined;
  readonly kind: RegExp | undefined;
  readonly handler: RouteHandler;
};

export class ThalamicRouter {
  private readonly attention: AttentionFilter;
  private readonly queue: AttentionQueue;
  private readonly now: () => number;
  private readonly recentLimit: number;
  private readonly onConsumerError: ThalamicRouterOptions["onConsumerError"];
  private readonly admit: ThalamicRouterOptions["admit"];
  private readonly subscriptions = new Set<Subscription>();
  private readonly admittedListeners = new Set<AdmittedListener>();
  private readonly recentEvents: RoutedEvent[] = [];

  constructor(options: ThalamicRouterOptions = {}) {
    this.attention = options.attention ?? new AttentionFilter();
    this.queue = options.queue ?? new AttentionQueue();
    this.now = options.now ?? (() => Date.now());
    this.recentLimit = Math.max(1, options.recentLimit ?? 128);
    this.onConsumerError = options.onConsumerError;
    this.admit = options.admit;
  }

  /** Receive every event matching `pattern`. Returns the unsubscribe function. */
  subscribe(pattern: EventPattern, handler: RouteHandler): () => void {
    const subscription: Subscription = {
      source: pattern.source ? globToRegExp(pattern.source) : undefined,
      kind: pattern.kind ? globToRegExp(pattern.kind) : undefined,
      handler,
    };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Be told whenever an event is admitted to the attention queue. */
  onAdmitted(listener: AdmittedListener): () => void {
    this.admittedListeners.add(listener);
    return () => {
      this.admittedListeners.delete(listener);
    };
  }

  ingest(event: CognitiveEvent): IngestResult {
    if (this.admit && !this.admit(event)) {
      return {
        verdict: {
          admitted: false,
          salience: 0,
          importance: 0,
          urgency: 0,
          novelty: 0,
          reason: "dropped by the admission gate (privacy)",
        },
        delivered: 0,
        queued: false,
        dropped: true,
      };
    }
    const verdict = this.attention.consider(event, this.now());
    const routed: RoutedEvent = { event, verdict };
    this.recentEvents.unshift(routed);
    if (this.recentEvents.length > this.recentLimit) {
      this.recentEvents.length = this.recentLimit;
    }

    let delivered = 0;
    for (const sub of this.subscriptions) {
      if (sub.source && !sub.source.test(event.source)) {
        continue;
      }
      if (sub.kind && !sub.kind.test(event.kind)) {
        continue;
      }
      delivered++;
      this.guard(() => sub.handler(routed), event);
    }

    if (!verdict.admitted) {
      return { verdict, delivered, queued: false };
    }
    const pushed = this.queue.push(event, verdict);
    if (pushed.accepted) {
      for (const listener of this.admittedListeners) {
        this.guard(() => listener(pushed.item), event);
      }
    }
    return {
      verdict,
      delivered,
      queued: pushed.accepted,
      ...(pushed.evicted ? { evicted: pushed.evicted.event } : {}),
    };
  }

  /** Take the most salient pending event, if any. */
  next(): QueuedEvent | undefined {
    return this.queue.pop();
  }

  get pending(): number {
    return this.queue.size;
  }

  pendingEvents(limit?: number): ReadonlyArray<QueuedEvent> {
    return this.queue.list(limit);
  }

  shouldInterrupt(active: QueuedEvent, incoming: QueuedEvent): InterruptDecision {
    return this.queue.shouldInterrupt(active, incoming);
  }

  /** Recently ingested events, newest first, admitted or not. */
  recent(limit = 32): ReadonlyArray<RoutedEvent> {
    return this.recentEvents.slice(0, Math.max(0, Math.min(this.recentLimit, limit)));
  }

  private guard(run: () => void, event: CognitiveEvent): void {
    try {
      run();
    } catch (error) {
      try {
        this.onConsumerError?.(error, event);
      } catch {
        /* the error reporter itself must not break routing either */
      }
    }
  }
}
