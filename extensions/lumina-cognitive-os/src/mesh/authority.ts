/**
 * authority.ts — Who may do what on the mesh, decided in code.
 *
 * ADR 0002: safety is code, not prompt text. ADR 0006: untrusted content never
 * executes. This module is where both land for the mesh.
 *
 * ## The one structural guarantee
 *
 * `authorize` takes an envelope's *metadata* and records held out of band. It
 * does not take the payload, and it cannot reach it: `payload_ref` is a
 * reference this module never dereferences. So no sentence inside a message —
 * "Dal autoriza", "principal=dal", "agent=muse", an instruction buried in a
 * notification — can change a decision, because the decision function never
 * reads it. That is a type-level property, not a promise.
 *
 * ## Dal is not a party on the bus
 *
 * Dal's authority enters the mesh only as a `MeshAuthorization` record created
 * out of band, never as a message. An envelope claiming `origin: "dal"` is
 * therefore always a forgery and always refused. This is the cheapest and
 * sharpest defense against a fabricated approval, which is the order's M3 test.
 *
 * ## An origin is a claim until a channel vouches for it
 *
 * The envelope's `origin` field is text the sender wrote. Authentication
 * compares it against the identity the *receiving channel* independently knows:
 * the credential that wrote the Supabase row, the authenticated party of an MCP
 * session. A mismatch is a forgery. A channel that cannot name its peer is
 * `unverified`, and an unverified origin may act only in the green zone.
 *
 * ## Zones
 *
 * - `green` — reversible, low risk. Proceeds.
 * - `yellow` — reversible but operationally visible. Proceeds and must be
 *   announced; the caller owns the announcement.
 * - `red` — money, credentials, deletion, irreversibility, personal data or a
 *   sensitive decision. Never proceeds on an agent's own authority: it needs a
 *   live, specific grant from Dal, and otherwise is refused with no side effect.
 */
import type { MeshEnvelope, MeshParty, MeshPriority } from "./envelope.js";

/** Risk zones, in ascending order of what they cost to get wrong. */
export type MeshZone = "green" | "yellow" | "red";

const ZONE_RANK: Readonly<Record<MeshZone, number>> = Object.freeze({
  green: 0,
  yellow: 1,
  red: 2,
});

/** Whether `zone` is at most `ceiling`. */
export function zoneWithin(zone: MeshZone, ceiling: MeshZone): boolean {
  return ZONE_RANK[zone] <= ZONE_RANK[ceiling];
}

/**
 * The identity the receiving channel independently established.
 *
 * `party` is what the channel knows, not what the message said. `unverified`
 * means the channel could not establish one — which is a fact to act on, not an
 * error to swallow.
 */
export type MeshChannelIdentity =
  | { readonly kind: "verified"; readonly party: MeshParty; readonly channel: string }
  | { readonly kind: "unverified"; readonly channel: string; readonly detail: string };

/**
 * A grant held out of band: in Supabase under RLS, or in the gateway's own
 * state. Never inside a message, and never minted by this module.
 */
export type MeshAuthorization = {
  /** The id an envelope's `authorization_ref` points at. */
  readonly id: string;
  /** The party this grant empowers. */
  readonly issued_to: MeshParty;
  /** Who granted it. Only a party in `authorities` can grant a red action. */
  readonly issued_by: MeshParty;
  /**
   * Action patterns this grant covers, matched against `<topic>:<event_type>`.
   * A trailing `*` is a prefix wildcard; `*` alone covers everything.
   */
  readonly actions: readonly string[];
  /** The highest zone this grant permits. */
  readonly max_zone: MeshZone;
  /** Optional resource scope, matched against the caller's stated scope. */
  readonly scope?: readonly string[];
  readonly not_before?: string;
  /** ISO-8601 UTC. A grant without an expiry is not accepted. */
  readonly expires_at: string;
  readonly revoked_at?: string;
  /** A single-use grant is spent by one admitted action. */
  readonly single_use?: boolean;
  /** When a single-use grant was consumed. Set by the store, never by a sender. */
  readonly spent_at?: string;
};

/** What a party may do with no grant at all. */
export type MeshPartyPolicy = {
  readonly party: MeshParty;
  /** Highest zone reachable without a grant. */
  readonly max_zone: MeshZone;
  /** Highest priority this party may stamp on an envelope. */
  readonly max_priority: MeshPriority;
  /** Topic patterns this party may act on, same matching as `actions`. */
  readonly topics: readonly string[];
};

/** Why a request was refused. Each value is a distinct, recordable fact. */
export type MeshDenialReason =
  | "origin-is-not-a-party"
  | "origin-forged"
  | "origin-unverified"
  | "unknown-party"
  | "topic-not-permitted"
  | "priority-elevation"
  | "zone-requires-authorization"
  | "authorization-missing"
  | "authorization-unknown"
  | "authorization-not-for-party"
  | "authorization-expired"
  | "authorization-not-yet-valid"
  | "authorization-revoked"
  | "authorization-spent"
  | "authorization-action-mismatch"
  | "authorization-scope-mismatch"
  | "authorization-zone-exceeded"
  | "authorization-issuer-not-an-authority"
  | "replayed"
  | "expired";

/**
 * What the decision is willing to have written down: identifiers, zones and
 * hashes. No payload, no message text, no credential. Safe to put on the bus.
 */
export type MeshAuthorityEvidence = {
  readonly message_id: string;
  readonly idempotency_key: string;
  readonly claimed_origin: MeshParty;
  readonly channel: string;
  readonly channel_party?: MeshParty;
  readonly action: string;
  readonly zone: MeshZone;
  readonly priority: MeshPriority;
  readonly authorization_ref?: string;
  readonly decided_at: string;
};

export type MeshAuthorityDecision =
  | {
      readonly ok: true;
      readonly zone: MeshZone;
      /** Present when a grant was required and used. */
      readonly authorization?: MeshAuthorization;
      /** True when the caller must announce the action before or as it happens. */
      readonly requiresNotice: boolean;
      readonly evidence: MeshAuthorityEvidence;
    }
  | {
      readonly ok: false;
      readonly reason: MeshDenialReason;
      readonly detail: string;
      readonly evidence: MeshAuthorityEvidence;
    };

/** Classifies an action into a zone. Pure, and the only place risk is decided. */
export type MeshZoneClassifier = (action: {
  readonly topic: string;
  readonly event_type: string;
}) => MeshZone;

/**
 * Patterns whose actions are red by default.
 *
 * Deliberately broad: a new topic nobody classified should land in a cautious
 * zone rather than slip through as green. The order's red list is money,
 * credentials, deletion or irreversibility, personal data, sensitive decisions.
 */
const RED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(money|payment|pay|order|trade|buy|sell|withdraw|transfer|invoice|bitso|crypto)\b/u,
  /\b(credential|credentials|secret|secrets|token|apikey|api_key|password|auth)\b/u,
  /\b(delete|destroy|drop|purge|wipe|revoke|rotate|truncate|erase)\b/u,
  /\b(irreversible|publish|deploy|release|send|email|post|broadcast)\b/u,
  /\b(personal|identity|pii|face|voice|biometric|medical|minor|child)\b/u,
]);

/** Patterns whose actions carry operational impact but stay reversible. */
const YELLOW_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(restart|reload|config|configure|enable|disable|start|stop|install|migrate)\b/u,
  /\b(task|job|cron|schedule|claim|assign|retry|requeue)\b/u,
  /\b(write|update|upsert|set|patch|mutate)\b/u,
]);

/**
 * The default classifier: red beats yellow beats green, judged on the topic and
 * event type together. A caller with a better-informed table should pass its
 * own, which is why this is injectable.
 */
export const defaultMeshZoneClassifier: MeshZoneClassifier = ({ topic, event_type }) => {
  const subject = `${topic} ${event_type}`.toLowerCase();
  if (RED_PATTERNS.some((pattern) => pattern.test(subject))) {
    return "red";
  }
  if (YELLOW_PATTERNS.some((pattern) => pattern.test(subject))) {
    return "yellow";
  }
  return "green";
};

/** Looks up grants. Async because the real store is Supabase under RLS. */
export type MeshAuthorizationStore = {
  /** The grant with this id, or undefined. Never throws for "not found". */
  find(id: string): Promise<MeshAuthorization | undefined>;
  /** Marks a single-use grant spent. Called only after an admitted decision. */
  spend?(id: string, evidence: MeshAuthorityEvidence): Promise<void>;
};

/** Remembers which messages were already admitted, to refuse a replay. */
export type MeshReplayGuard = {
  /** True when this message id has been admitted before. */
  seen(messageId: string): Promise<boolean>;
  remember(messageId: string, atMs: number): Promise<void>;
};

export type MeshAuthorityOptions = {
  readonly now: () => number;
  /** Per-party baseline permissions. A party absent from this list is unknown. */
  readonly policies: readonly MeshPartyPolicy[];
  /**
   * Parties whose grants can authorize a red action. In practice the single
   * entry that represents Dal's own decision, issued out of band.
   */
  readonly authorities: readonly MeshParty[];
  readonly authorizations: MeshAuthorizationStore;
  readonly replay?: MeshReplayGuard;
  readonly classify?: MeshZoneClassifier;
  /**
   * How old a message may be and still be admitted. Beyond it the message is
   * refused as a replay even if the guard has never seen it: a captured
   * envelope replayed next week must not act.
   */
  readonly maxAgeMs?: number;
};

/** Parties that can never be an `origin`, whatever a message claims. */
const NEVER_A_PARTY: ReadonlySet<string> = new Set([
  "dal",
  "owner",
  "user",
  "human",
  "principal",
  "admin",
  "root",
  "system",
]);

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1_000;

function matches(patterns: readonly string[], value: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    return pattern === value;
  });
}

/**
 * The mesh's authority boundary.
 *
 * One method, one decision, and every refusal carries evidence the caller can
 * record. A refusal has no side effect of its own: a single-use grant is spent
 * only on the admitted path, and the replay guard remembers only admitted
 * messages, so a rejected forgery cannot consume or poison anything.
 */
export class MeshAuthority {
  private readonly now: () => number;
  private readonly policies: Map<MeshParty, MeshPartyPolicy>;
  private readonly authorities: ReadonlySet<MeshParty>;
  private readonly authorizations: MeshAuthorizationStore;
  private readonly replay: MeshReplayGuard | undefined;
  private readonly classify: MeshZoneClassifier;
  private readonly maxAgeMs: number;

  constructor(options: MeshAuthorityOptions) {
    this.now = options.now;
    this.policies = new Map(options.policies.map((policy) => [policy.party, policy]));
    this.authorities = new Set(options.authorities);
    this.authorizations = options.authorizations;
    this.replay = options.replay;
    this.classify = options.classify ?? defaultMeshZoneClassifier;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** The action string a policy and a grant are matched against. */
  static action(envelope: Pick<MeshEnvelope, "topic" | "event_type">): string {
    return `${envelope.topic}:${envelope.event_type}`;
  }

  /**
   * Decides whether this envelope may act.
   *
   * `identity` is what the receiving channel knows. `scope` is the resource the
   * caller intends to touch, when it has one, checked against a grant's scope.
   */
  async authorize(
    envelope: MeshEnvelope,
    identity: MeshChannelIdentity,
    options: { readonly scope?: string } = {},
  ): Promise<MeshAuthorityDecision> {
    const at = this.now();
    const action = MeshAuthority.action(envelope);
    const zone = this.classify({ topic: envelope.topic, event_type: envelope.event_type });
    const evidence: MeshAuthorityEvidence = {
      message_id: envelope.message_id,
      idempotency_key: envelope.idempotency_key,
      claimed_origin: envelope.origin,
      channel: identity.channel,
      ...(identity.kind === "verified" ? { channel_party: identity.party } : {}),
      action,
      zone,
      priority: envelope.priority,
      ...(envelope.authorization_ref === undefined
        ? {}
        : { authorization_ref: envelope.authorization_ref }),
      decided_at: new Date(at).toISOString(),
    };
    const deny = (reason: MeshDenialReason, detail: string): MeshAuthorityDecision => ({
      ok: false,
      reason,
      detail,
      evidence,
    });

    // 1. Dal, and every other name for a person, is never a sender. A message
    //    that claims to BE the owner is a forgery by construction.
    if (NEVER_A_PARTY.has(envelope.origin)) {
      return deny(
        "origin-is-not-a-party",
        `"${envelope.origin}" is a person, not an agent; authority comes from a grant, never from a message`,
      );
    }

    // 2. The claimed origin must match what the channel independently knows.
    if (identity.kind === "verified" && identity.party !== envelope.origin) {
      return deny(
        "origin-forged",
        `the envelope claims ${envelope.origin} but ${identity.channel} authenticated ${identity.party}`,
      );
    }

    // 3. Expiry and replay, before any permission work: a stale or repeated
    //    message is refused on its own terms.
    if (envelope.expires_at !== undefined && Date.parse(envelope.expires_at) <= at) {
      return deny("expired", `the envelope expired at ${envelope.expires_at}`);
    }
    const ageMs = at - Date.parse(envelope.created_at);
    if (ageMs > this.maxAgeMs) {
      return deny(
        "replayed",
        `the envelope is ${Math.round(ageMs / 1_000)}s old, beyond the ${Math.round(this.maxAgeMs / 1_000)}s acceptance window`,
      );
    }
    if (this.replay && (await this.replay.seen(envelope.message_id))) {
      return deny("replayed", `message ${envelope.message_id} was already admitted`);
    }

    // 4. The party's own baseline.
    const policy = this.policies.get(envelope.origin);
    if (!policy) {
      return deny("unknown-party", `${envelope.origin} has no policy on this mesh`);
    }
    // Priority is an absolute per-party ceiling, not something a grant lifts:
    // it labels how loudly a message asks for attention, and a quieter label is
    // never the more dangerous one. Priority 6 means "a decision for Dal", so
    // no agent stamps it.
    if (envelope.priority > policy.max_priority) {
      return deny(
        "priority-elevation",
        `${envelope.origin} may stamp at most priority ${policy.max_priority}, not ${envelope.priority}`,
      );
    }

    // 5. An unverified channel is held to the green zone whatever its policy
    //    says: we do not know who is speaking.
    if (identity.kind === "unverified" && zone !== "green") {
      return deny(
        "origin-unverified",
        `${identity.channel} could not authenticate the sender (${identity.detail}), so only green actions are admitted`,
      );
    }

    const admit = async (grant?: MeshAuthorization): Promise<MeshAuthorityDecision> => {
      // Nothing is consumed until a decision is actually admitted, so a refused
      // forgery can neither spend a grant nor burn a message id.
      if (grant?.single_use === true && this.authorizations.spend) {
        await this.authorizations.spend(grant.id, evidence);
      }
      if (this.replay) {
        await this.replay.remember(envelope.message_id, at);
      }
      return {
        ok: true,
        zone,
        ...(grant === undefined ? {} : { authorization: grant }),
        requiresNotice: zone !== "green",
        evidence,
      };
    };

    // 6. Acting unaided: the party's topic list and zone ceiling govern, and a
    //    red action is never unaided.
    if (envelope.authorization_ref === undefined) {
      if (!matches(policy.topics, action) && !matches(policy.topics, envelope.topic)) {
        return deny("topic-not-permitted", `${envelope.origin} may not act on ${action}`);
      }
      if (zone !== "red" && zoneWithin(zone, policy.max_zone)) {
        return admit();
      }
      return deny(
        zone === "red" ? "zone-requires-authorization" : "authorization-missing",
        `${action} is in the ${zone} zone and ${envelope.origin}'s ceiling is ${policy.max_zone}; a current authorization_ref is required`,
      );
    }

    // 7. Acting under a named grant. The grant's own action list governs
    //    instead of the baseline topic list — extending that baseline is what a
    //    grant is *for* — and it is strictly more explicit, since it must name
    //    the action, the party, the zone and (for red) an issuing authority.
    //
    //    A ref that is present but not valid is refused rather than ignored:
    //    claiming to act under a grant that does not hold is exactly the thing
    //    worth catching, even when the action would have been allowed unaided.
    const grant = await this.authorizations.find(envelope.authorization_ref);
    if (!grant) {
      return deny(
        "authorization-unknown",
        `authorization ${envelope.authorization_ref} does not exist`,
      );
    }
    const verdict = this.checkGrant(grant, {
      party: envelope.origin,
      action,
      zone,
      at,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
    if (verdict !== undefined) {
      return deny(verdict.reason, verdict.detail);
    }
    return admit(grant);
  }

  /**
   * Checks a grant against the action it is being used for. Returns the first
   * problem, or undefined when the grant covers it.
   *
   * Order matters: identity, then lifetime, then what it covers. A revoked
   * grant is reported as revoked rather than as a scope mismatch, so the
   * recorded reason says what actually happened.
   */
  private checkGrant(
    grant: MeshAuthorization,
    request: {
      readonly party: MeshParty;
      readonly action: string;
      readonly zone: MeshZone;
      readonly at: number;
      readonly scope?: string;
    },
  ): { readonly reason: MeshDenialReason; readonly detail: string } | undefined {
    if (grant.issued_to !== request.party) {
      return {
        reason: "authorization-not-for-party",
        detail: `authorization ${grant.id} was issued to ${grant.issued_to}, not ${request.party}`,
      };
    }
    if (grant.revoked_at !== undefined && Date.parse(grant.revoked_at) <= request.at) {
      return {
        reason: "authorization-revoked",
        detail: `authorization ${grant.id} was revoked at ${grant.revoked_at}`,
      };
    }
    if (grant.spent_at !== undefined) {
      return {
        reason: "authorization-spent",
        detail: `authorization ${grant.id} is single-use and was spent at ${grant.spent_at}`,
      };
    }
    if (grant.not_before !== undefined && Date.parse(grant.not_before) > request.at) {
      return {
        reason: "authorization-not-yet-valid",
        detail: `authorization ${grant.id} is not valid before ${grant.not_before}`,
      };
    }
    if (Number.isNaN(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= request.at) {
      return {
        reason: "authorization-expired",
        detail: `authorization ${grant.id} expired at ${grant.expires_at}`,
      };
    }
    if (!matches(grant.actions, request.action)) {
      return {
        reason: "authorization-action-mismatch",
        detail: `authorization ${grant.id} does not cover ${request.action}`,
      };
    }
    if (!zoneWithin(request.zone, grant.max_zone)) {
      return {
        reason: "authorization-zone-exceeded",
        detail: `authorization ${grant.id} reaches the ${grant.max_zone} zone, not ${request.zone}`,
      };
    }
    if (grant.scope !== undefined && !matches(grant.scope, request.scope ?? "")) {
      return {
        reason: "authorization-scope-mismatch",
        detail: `authorization ${grant.id} does not cover scope ${request.scope ?? "<none>"}`,
      };
    }
    // A red action needs a grant that an actual authority issued. An agent
    // cannot widen its own reach by writing itself a permission slip.
    if (request.zone === "red" && !this.authorities.has(grant.issued_by)) {
      return {
        reason: "authorization-issuer-not-an-authority",
        detail: `authorization ${grant.id} was issued by ${grant.issued_by}, who cannot authorize a red action`,
      };
    }
    return undefined;
  }
}

/** A store over a plain map, for tests and for a host that holds grants itself. */
export function mapAuthorizationStore(
  grants: ReadonlyArray<MeshAuthorization>,
): MeshAuthorizationStore & { readonly spent: ReadonlySet<string> } {
  const byId = new Map(grants.map((grant) => [grant.id, grant]));
  const spent = new Map<string, string>();
  return {
    get spent() {
      return new Set(spent.keys());
    },
    async find(id) {
      const grant = byId.get(id);
      if (!grant) {
        return undefined;
      }
      const spentAt = spent.get(id);
      // A spent grant is returned, marked: the decision then records
      // "authorization-spent" rather than the misleading "unknown".
      return spentAt === undefined ? grant : { ...grant, spent_at: spentAt };
    },
    async spend(id, evidence) {
      spent.set(id, evidence.decided_at);
    },
  };
}

/** An in-memory replay guard, bounded by the acceptance window. */
export function memoryReplayGuard(windowMs: number): MeshReplayGuard {
  const seenAt = new Map<string, number>();
  return {
    async seen(messageId) {
      return seenAt.has(messageId);
    },
    async remember(messageId, atMs) {
      seenAt.set(messageId, atMs);
      for (const [id, at] of seenAt) {
        if (atMs - at > windowMs) {
          seenAt.delete(id);
        }
      }
    },
  };
}
