/**
 * goal-manager.ts — Goals that outlive a session.
 *
 * A chat assistant forgets what it was trying to do the moment the window
 * closes. This is the store that fixes that: goals persist to disk, carry a
 * priority and optional deadline, and declare their own success conditions so
 * completion is checkable rather than a matter of opinion.
 *
 * Ranking lives here too (the spec's "priority engine"): a goal's score blends
 * its declared priority with deadline pressure and how long it has been
 * ignored, so nothing quietly starves.
 *
 * Persistence reuses `memory/store.ts` rather than inventing a second format.
 */
import path from "node:path";
import { appendJsonl, ensureDir, newId, readJsonlSync, rewriteJsonl } from "../../memory/store.js";

export type GoalStatus = "active" | "blocked" | "done" | "abandoned";

/** 1 = lowest, 5 = highest. Out-of-range values are clamped on write. */
export type GoalPriority = 1 | 2 | 3 | 4 | 5;

export type Goal = {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly priority: GoalPriority;
  readonly deadlineISO?: string;
  /** Checkable statements; all must hold for the goal to count as done. */
  readonly successConditions: ReadonlyArray<string>;
  readonly status: GoalStatus;
  readonly createdAtISO: string;
  readonly updatedAtISO: string;
  /** Set when this goal was spawned by a larger one. */
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

const clampPriority = (n: number | undefined): GoalPriority => {
  const v = Math.round(Number.isFinite(n) ? (n as number) : 3);
  return Math.min(5, Math.max(1, v)) as GoalPriority;
};

/** Goals that are still live work. */
export const OPEN_STATUSES: ReadonlyArray<GoalStatus> = ["active", "blocked"];

export type RankedGoal = {
  readonly goal: Goal;
  readonly score: number;
  readonly reason: string;
};

export class GoalManager {
  private goals: Goal[] = [];
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, "goals.jsonl");
    ensureDir(dir);
    this.goals = readJsonlSync<Goal>(this.filePath);
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
    appendJsonl(this.filePath, goal);
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

  /** Patch a goal and rewrite the file; returns undefined for an unknown id. */
  update(
    id: string,
    patch: Partial<Omit<Goal, "id" | "createdAtISO">>,
    nowISO: string = new Date().toISOString(),
  ): Goal | undefined {
    const current = this.goals.find((g) => g.id === id);
    if (!current) {
      return undefined;
    }
    // Spread only the keys the caller actually set: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as
    // "leave it alone", and blindly spreading a Partial would widen required
    // fields like `title` to `string | undefined`.
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
    rewriteJsonl(this.filePath, this.goals);
    return next;
  }

  complete(id: string, nowISO?: string): Goal | undefined {
    return this.update(id, { status: "done" }, nowISO);
  }

  abandon(id: string, nowISO?: string): Goal | undefined {
    return this.update(id, { status: "abandoned" }, nowISO);
  }

  /**
   * Score open goals so the loop knows what to work on.
   *
   * priority contributes the baseline, an approaching deadline adds pressure,
   * and staleness adds a slow drip so a low-priority goal eventually surfaces
   * instead of starving forever.
   */
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
            // Full pressure inside 1h, none beyond a week.
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
    return ranked.sort(
      (a, b) => b.score - a.score || a.goal.createdAtISO.localeCompare(b.goal.createdAtISO),
    );
  }

  /** Highest-scoring open goal, or undefined when there is nothing to do. */
  next(nowMs?: number): RankedGoal | undefined {
    return this.rank(nowMs)[0];
  }
}
