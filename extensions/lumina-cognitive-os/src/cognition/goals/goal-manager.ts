/**
 * goal-manager.ts — Durable goals that outlive a session.
 *
 * In the live gateway, goals are event-sourced as snapshots in OpenClaw's
 * SQLite plugin state. Legacy goals.jsonl is imported once when the durable
 * store is empty, then archived. Tests and non-live discovery keep the JSONL
 * fallback so they never contend with the live gateway store.
 */
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonlSync, rewriteJsonl } from "../../memory/store.js";
import { KeyedLog, type StateStorePort } from "../../shared/state-store.js";

export type GoalStatus = "active" | "blocked" | "done" | "abandoned";
export type GoalPriority = 1 | 2 | 3 | 4 | 5;

export type Goal = {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly priority: GoalPriority;
  readonly deadlineISO?: string;
  readonly successConditions: ReadonlyArray<string>;
  readonly status: GoalStatus;
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
  readonly parentId?: string;
};

export type CreateGoalInput = {
  readonly title: string;
  readonly detail?: string;
  readonly priority?: number;
  readonly deadlineISO?: string;
  readonly successConditions?: ReadonlyArray<string>;
  readonly parentId?: string;
};

export type GoalManagerOptions = {
  readonly dir: string;
  readonly store?: StateStorePort<Goal>;
  readonly onError?: (error: unknown) => void;
};

const clampPriority = (n: number | undefined): GoalPriority => {
  const v = Math.round(Number.isFinite(n) ? (n as number) : 3);
  return Math.min(5, Math.max(1, v)) as GoalPriority;
};

export const OPEN_STATUSES: ReadonlyArray<GoalStatus> = ["active", "blocked"];

export type RankedGoal = {
  readonly goal: Goal;
  readonly score: number;
  readonly reason: string;
};

function latestSnapshots(rows: ReadonlyArray<Goal>): Goal[] {
  const byId = new Map<string, Goal>();
  for (const row of rows) {
    const current = byId.get(row.id);
    if (!current || current.updatedAtISO <= row.updatedAtISO) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

export class GoalManager {
  private goals: Goal[] = [];
  private readonly filePath: string;
  private readonly log: KeyedLog<Goal> | undefined;
  private readonly onError: (error: unknown) => void;
  private loading = false;
  private pendingPersist: Goal[] = [];
  readonly ready: Promise<void>;

  constructor(input: string | GoalManagerOptions) {
    const options: GoalManagerOptions = typeof input === "string" ? { dir: input } : input;
    this.filePath = path.join(options.dir, "goals.jsonl");
    this.onError = options.onError ?? (() => undefined);
    ensureDir(options.dir);
    const legacy = readJsonlSync<Goal>(this.filePath);
    this.goals = latestSnapshots(legacy);

    if (!options.store) {
      this.ready = Promise.resolve();
      return;
    }

    this.loading = true;
    this.log = new KeyedLog(options.store, this.onError);
    this.ready = this.log.hydrate().then(
      async (stored) => {
        const durable = stored.length > 0 ? latestSnapshots(stored) : latestSnapshots(legacy);
        const merged = latestSnapshots([...durable, ...this.pendingPersist]);
        this.goals = merged;

        // Import legacy first so a mutation made during hydration remains the newest snapshot.
        if (stored.length === 0 && legacy.length > 0) {
          for (const row of legacy) {
            this.log?.append(row);
          }
        }
        for (const row of this.pendingPersist) {
          this.log?.append(row);
        }
        await this.log?.flush();
        this.pendingPersist = [];
        this.loading = false;
        if (stored.length === 0 && legacy.length > 0) {
          this.archiveLegacy();
        }
      },
      (error: unknown) => {
        this.loading = false;
        this.onError(error);
      },
    );
  }

  private archiveLegacy(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const archived = `${this.filePath}.migrated`;
    try {
      if (!fs.existsSync(archived)) {
        fs.renameSync(this.filePath, archived);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private persistSnapshot(goal: Goal, rewriteFallback = false): void {
    if (this.log) {
      if (this.loading) {
        this.pendingPersist.push(structuredClone(goal));
      } else {
        this.log.append(structuredClone(goal));
      }
      return;
    }
    if (rewriteFallback) {
      rewriteJsonl(this.filePath, this.goals);
    } else {
      appendJsonl(this.filePath, goal);
    }
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.log?.flush();
  }

  create(input: CreateGoalInput, nowISO: string = new Date().toISOString()): Goal {
    const title = input.title.trim();
    if (!title) {
      throw new Error("A goal needs a title.");
    }
    const goal: Goal = {
      id: newId(),
      title,
      detail: input.detail?.trim() || undefined,
      priority: clampPriority(input.priority),
      deadlineISO: input.deadlineISO,
      successConditions: input.successConditions ?? [],
      status: "active",
      createdAtISO: nowISO,
      updatedAtISO: nowISO,
      parentId: input.parentId,
    };
    this.goals.push(goal);
    this.persistSnapshot(goal);
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.goals.find((g) => g.id === id);
  }

  list(status?: GoalStatus): ReadonlyArray<Goal> {
    return status ? this.goals.filter((g) => g.status === status) : [...this.goals];
  }

  open(): ReadonlyArray<Goal> {
    return this.goals.filter((g) => OPEN_STATUSES.includes(g.status));
  }

  update(
    id: string,
    patch: Partial<Omit<Goal, "id" | "createdAtISO">>,
    nowISO: string = new Date().toISOString(),
  ): Goal | undefined {
    const current = this.goals.find((g) => g.id === id);
    if (!current) {
      return undefined;
    }
    const next: Goal = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.deadlineISO !== undefined ? { deadlineISO: patch.deadlineISO } : {}),
      ...(patch.successConditions !== undefined
        ? { successConditions: patch.successConditions }
        : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      priority: patch.priority !== undefined ? clampPriority(patch.priority) : current.priority,
      updatedAtISO: nowISO,
    };
    this.goals = this.goals.map((g) => (g.id === id ? next : g));
    this.persistSnapshot(next, true);
    return next;
  }

  complete(id: string, nowISO?: string): Goal | undefined {
    return this.update(id, { status: "done" }, nowISO);
  }

  abandon(id: string, nowISO?: string): Goal | undefined {
    return this.update(id, { status: "abandoned" }, nowISO);
  }

  rank(nowMs: number = Date.now()): ReadonlyArray<RankedGoal> {
    const ranked = this.open().map((goal) => {
      const priorityScore = (goal.priority - 1) / 4;
      let deadlineScore = 0;
      let deadlineNote = "no deadline";
      if (goal.deadlineISO) {
        const due = Date.parse(goal.deadlineISO);
        if (Number.isFinite(due)) {
          const hoursLeft = (due - nowMs) / 3_600_000;
          if (hoursLeft <= 0) {
            deadlineScore = 1;
            deadlineNote = "overdue";
          } else {
            deadlineScore = Math.min(1, Math.max(0, 1 - Math.log10(hoursLeft) / Math.log10(168)));
            deadlineNote = `${hoursLeft.toFixed(1)}h left`;
          }
        }
      }
      const ageDays = Math.max(0, (nowMs - Date.parse(goal.updatedAtISO)) / 86_400_000);
      const stalenessScore = Math.min(1, ageDays / 14);
      const score = Math.min(1, priorityScore * 0.5 + deadlineScore * 0.35 + stalenessScore * 0.15);
      return {
        goal,
        score,
        reason: `P${goal.priority}, ${deadlineNote}, idle ${ageDays.toFixed(1)}d`,
      };
    });
    return ranked.toSorted(
      (a, b) => b.score - a.score || a.goal.createdAtISO.localeCompare(b.goal.createdAtISO),
    );
  }

  next(nowMs?: number): RankedGoal | undefined {
    return this.rank(nowMs)[0];
  }
}
