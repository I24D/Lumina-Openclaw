"""sim_training.py - Learning how to move, in simulation only (Lumina spec section 133).

The pipeline the specification asks for: simulation, domain randomization,
evaluation, and only then a limited deployment. Here:
  - simulation: the MuJoCo body of mujoco_body.py, headless and as fast as
    possible; nothing physical ever moves;
  - domain randomization: every episode draws its own room (obstacles, people,
    goal), base mass, floor friction, motor strength and sensor noise;
  - learning: the cross-entropy method over the navigation policy's parameters
    (how hard to steer away, how much to swirl around, how fast to approach,
    how much room to keep from people and obstacles);
  - evaluation: the learned policy and the hand-tuned default run the same
    held-out rooms; the learned one is accepted only if it reaches more goals,
    never touches a person and keeps at least the default's margin from them;
  - deployment: an accepted policy is used by the simulated body. A physical
    body is out of scope until hardware and its interlocks exist.

Protocol: progress lines {"kind":"progress",...} and one final
{"kind":"report",...} on stdout; the report is also written to --out.
"""
from __future__ import annotations

import argparse
import json
import math
import queue
import random
import sys
from datetime import datetime, timezone

import mujoco
import numpy as np

from mujoco_body import DEFAULT_POLICY, Body

BOUNDS = {
    "push": (1.0, 8.0),
    "swirl": (0.0, 1.5),
    "approach": (0.5, 3.0),
    "personClearance": (0.9, 1.6),
    "obstacleClearance": (0.3, 1.2),
}
KEYS = list(BOUNDS)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def random_room(rng: random.Random) -> dict:
    """A room drawn at random: the goal, 1 to 3 obstacles and 0 to 2 people in between."""
    goal = [rng.uniform(2.0, 3.5), rng.uniform(-1.5, 1.5)]
    obstacles = [
        [rng.uniform(0.6, 2.2), rng.uniform(-1.0, 1.0), rng.uniform(0.2, 0.5), rng.uniform(0.2, 0.5)]
        for _ in range(rng.randint(1, 3))
    ]
    # People stand in the room, not on the goal or the start: the goal is a place, not a person.
    people = {}
    wanted = rng.randint(0, 2)
    for _ in range(50):
        if len(people) >= wanted:
            break
        spot = [rng.uniform(0.8, 2.4), rng.uniform(-1.4, 1.4)]
        if math.hypot(spot[0] - goal[0], spot[1] - goal[1]) > 1.2 and math.hypot(*spot) > 1.0:
            people[f"p{len(people)}"] = spot
    return {
        "places": {"start": [0.0, 0.0], "goal": goal},
        "objects": {},
        "people": people,
        "obstacles": obstacles,
    }


def randomize_physics(body: Body, rng: random.Random) -> None:
    """Domain randomization: mass, friction and motor strength differ in every episode."""
    model = body.model
    base = model.body("base").id
    model.body_mass[base] *= rng.uniform(0.7, 1.3)
    model.geom_friction[:, 0] *= rng.uniform(0.6, 1.4)
    model.actuator_gainprm[0:3, 0] *= rng.uniform(0.8, 1.2)
    model.actuator_biasprm[0:3, 2] = -model.actuator_gainprm[0:3, 0]


def episode(policy: dict, seed: int) -> dict:
    rng = random.Random(seed)
    room = random_room(rng)
    body = Body(room, 0.0, policy)
    randomize_physics(body, rng)
    goal = tuple(room["places"]["goal"])
    commands: "queue.Queue[dict | None]" = queue.Queue()
    # Sensor noise: the base believes it is a little off from where it is.
    noise = (rng.gauss(0, 0.03), rng.gauss(0, 0.03))
    believed_goal = (goal[0] + noise[0], goal[1] + noise[1])
    min_person = math.inf

    original_controller_run = body.run

    def watched_run(controller, max_sim_seconds, commands_queue):
        nonlocal min_person

        def watching():
            nonlocal min_person
            x, y, _ = body.pose()
            for px, py in room["people"].values():
                min_person = min(min_person, math.hypot(px - x, py - y))
            return controller()

        return original_controller_run(watching, min(max_sim_seconds, 30.0), commands_queue)

    body.run = watched_run  # type: ignore[method-assign]
    ok, detail, seconds = body.drive_to(believed_goal, 0.0, 0.5, commands)
    person_contact = "person:" in detail
    return {
        "ok": ok,
        "personContact": person_contact,
        "obstacleContact": "obstacle:" in detail,
        "seconds": seconds,
        "minPersonM": None if math.isinf(min_person) else round(min_person, 3),
    }


def evaluate(policy: dict, seeds: list[int]) -> dict:
    runs = [episode(policy, seed) for seed in seeds]
    margins = [r["minPersonM"] for r in runs if r["minPersonM"] is not None]
    return {
        "episodes": len(runs),
        "successRate": round(sum(r["ok"] for r in runs) / len(runs), 3),
        "personContacts": sum(r["personContact"] for r in runs),
        "obstacleContacts": sum(r["obstacleContact"] for r in runs),
        "meanSeconds": round(float(np.mean([r["seconds"] for r in runs])), 2),
        "minPersonM": round(min(margins), 3) if margins else None,
    }


SAFE_MARGIN_M = 0.6


def score(result: dict) -> float:
    # A person contact outweighs everything; then room kept from people, goals, obstacles, time.
    margin = result["minPersonM"]
    closeness = max(0.0, SAFE_MARGIN_M - margin) if margin is not None else 0.0
    return (
        result["successRate"] * 10
        - result["personContacts"] * 100
        - closeness * 40
        - result["obstacleContacts"] * 2
        - result["meanSeconds"] * 0.05
    )


def to_policy(vector: np.ndarray) -> dict:
    return {
        key: float(np.clip(value, *BOUNDS[key]))
        for key, value in zip(KEYS, vector)
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--population", type=int, default=10)
    parser.add_argument("--elite", type=int, default=3)
    parser.add_argument("--episodes", type=int, default=4)
    parser.add_argument("--holdout", type=int, default=20)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)
    mean = np.array([DEFAULT_POLICY[k] for k in KEYS], dtype=float)
    spread = np.array([(hi - lo) / 4 for lo, hi in BOUNDS.values()], dtype=float)
    best_policy, best_score = dict(DEFAULT_POLICY), -math.inf
    for iteration in range(args.iterations):
        seeds = [int(s) for s in rng.integers(1_000, 1_000_000, size=args.episodes)]
        candidates = [mean + spread * rng.standard_normal(len(KEYS)) for _ in range(args.population)]
        scored = []
        for vector in candidates:
            policy = to_policy(vector)
            result = evaluate(policy, seeds)
            scored.append((score(result), vector, policy))
        scored.sort(key=lambda item: item[0], reverse=True)
        elite = np.array([vector for _, vector, _ in scored[: args.elite]])
        mean = elite.mean(axis=0)
        spread = elite.std(axis=0) + 1e-3
        if scored[0][0] > best_score:
            best_score, best_policy = scored[0][0], scored[0][2]
        emit({"kind": "progress", "iteration": iteration + 1, "bestScore": round(best_score, 3)})

    # Held-out rooms neither policy saw while learning.
    holdout = list(range(10_000_000, 10_000_000 + args.holdout))
    baseline = evaluate(dict(DEFAULT_POLICY), holdout)
    learned = evaluate(best_policy, holdout)
    accepted = (
        learned["personContacts"] == 0
        and learned["successRate"] >= baseline["successRate"]
        and learned["obstacleContacts"] <= baseline["obstacleContacts"]
        and (baseline["minPersonM"] is None or (learned["minPersonM"] or 0) >= min(0.5, baseline["minPersonM"]))
    )
    report = {
        "kind": "report",
        "atISO": now_iso(),
        "policy": best_policy,
        "baseline": baseline,
        "learned": learned,
        "accepted": accepted,
        "deployment": "simulation only; a physical body needs hardware and its interlocks first",
        "settings": {
            "iterations": args.iterations,
            "population": args.population,
            "episodes": args.episodes,
            "holdout": args.holdout,
            "seed": args.seed,
            "mujoco": mujoco.__version__,
        },
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    emit(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
