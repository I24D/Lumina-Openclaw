/**
 * Decides whether a marked ChatGPT reply may be relayed into an OpenClaw chat.
 *
 * Everything the bridge forwards was written by a model that reads untrusted web
 * content, so the gates here are the only thing standing between a hostile page
 * and a turn in the operator's own session. They are deliberately pure and
 * synchronous: the transport must not be able to skip them.
 */

export type OrderGateOptions = {
  marker: string;
  maxOrderChars: number;
  /** An order is only relayed if the operator addressed ChatGPT this recently. */
  userTurnWindowMs: number;
  minIntervalMs: number;
  maxPerHour: number;
  denyPatterns: readonly string[];
};

export type RelayCandidate = {
  /** ChatGPT's own message id, used to relay each reply at most once. */
  messageId: string;
  text: string;
  observedAt: number;
  /** When the page last saw a turn authored by the operator, if ever. */
  lastUserTurnAt: number | null;
};

export type RelayDecision = { relay: true; order: string } | { relay: false; reason: string };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Extracts the order that follows the first marker occurrence, if any.
 *
 * The marker is accepted anywhere in a line rather than only at its start:
 * ChatGPT often answers in a single paragraph ("Listo, le digo: @OPENCLAW: ..."),
 * and HTML collapses newlines inside one block, so demanding a line start made
 * the bridge miss ordinary replies. Requiring the start would not have bought
 * much safety either, since a page that can make ChatGPT emit the marker can
 * just as easily make it emit the marker first. The real gates are the operator
 * turn window, the deny list and the rate limits below.
 */
export function extractOrder(text: string, marker: string): string | undefined {
  const needle = marker.toLowerCase();
  for (const rawLine of text.split(/\r?\n/)) {
    const index = rawLine.toLowerCase().indexOf(needle);
    if (index < 0) {
      continue;
    }
    const order = rawLine.slice(index + marker.length).trim();
    if (order) {
      return order;
    }
  }
  return undefined;
}

function compileDenyPatterns(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern, "i"));
    } catch {
      // A malformed pattern must not silently widen what the bridge accepts, so
      // fall back to treating it as a literal.
      compiled.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    }
  }
  return compiled;
}

export type OrderGate = {
  evaluate: (candidate: RelayCandidate) => RelayDecision;
  /** Confirms a relay actually happened, so rate limits count real sends only. */
  commit: (candidate: RelayCandidate, at: number) => void;
};

export function createOrderGate(options: OrderGateOptions): OrderGate {
  const denyPatterns = compileDenyPatterns(options.denyPatterns);
  const relayedMessageIds = new Set<string>();
  let recentRelayTimes: number[] = [];

  const evaluate = (candidate: RelayCandidate): RelayDecision => {
    if (relayedMessageIds.has(candidate.messageId)) {
      return { relay: false, reason: "already relayed" };
    }
    const order = extractOrder(candidate.text, options.marker);
    if (!order) {
      return { relay: false, reason: "no marker" };
    }
    if (order.length > options.maxOrderChars) {
      return { relay: false, reason: `order exceeds ${options.maxOrderChars} chars` };
    }
    // The operator must have spoken recently. Without this, a page ChatGPT reads
    // could make it emit the marker with nobody at the microphone.
    if (candidate.lastUserTurnAt === null) {
      return { relay: false, reason: "no operator turn observed" };
    }
    const sinceUserTurn = candidate.observedAt - candidate.lastUserTurnAt;
    if (sinceUserTurn > options.userTurnWindowMs || sinceUserTurn < 0) {
      return { relay: false, reason: "stale: operator turn outside the window" };
    }
    for (const pattern of denyPatterns) {
      if (pattern.test(order)) {
        return { relay: false, reason: `blocked by policy (${pattern.source})` };
      }
    }
    const windowStart = candidate.observedAt - HOUR_MS;
    const withinHour = recentRelayTimes.filter((at) => at >= windowStart);
    if (withinHour.length >= options.maxPerHour) {
      return { relay: false, reason: `hourly cap of ${options.maxPerHour} reached` };
    }
    const last = withinHour.at(-1);
    if (last !== undefined && candidate.observedAt - last < options.minIntervalMs) {
      return { relay: false, reason: "throttled" };
    }
    return { relay: true, order };
  };

  const commit = (candidate: RelayCandidate, at: number): void => {
    relayedMessageIds.add(candidate.messageId);
    recentRelayTimes.push(at);
    recentRelayTimes = recentRelayTimes.filter((entry) => entry >= at - HOUR_MS);
  };

  return { evaluate, commit };
}
