"""mujoco_body.py - Lumina's body in a physics simulator (MuJoCo).

M3GAN spec sections 16 (internal simulation), 59 (simulation-first
development), 60 (digital twin) and 23 to 27 (embodiment). A small mobile robot
(planar base, pan/tilt head, a gripper in front) lives in a room with named
places, objects and people. It carries out body intents the gateway's safety
supervisor already allowed, with real physics: velocity-limited motion,
collisions that stop it, objects that are only grasped within reach. Nothing
here decides whether to act; it only acts, and a stop command halts it at once.

Protocol (one JSON object per line):
  stdout  {"kind":"start","atISO":...,"places":[...],"objects":{"name":"place"},"people":[...]}
          {"kind":"result","id":r,"ok":bool,"detail":...,"simSeconds":s,"state":{...}}
          {"kind":"state","id":r,"state":{"x":..,"y":..,"yaw":..,"place":..,"holding":..}}
          {"kind":"error","atISO":...,"message":...}
  stdin   {"cmd":"execute","id":r,"intent":{...},"limits":{"maxSpeedMps":v}}
          {"cmd":"stop"}         halt now; a running intent ends with ok=false
          {"cmd":"state","id":r}
          {"cmd":"quit"}
Exits when stdin closes, so it never outlives the gateway.
"""
from __future__ import annotations

import argparse
import json
import math
import queue
import sys
import threading
import time
from datetime import datetime, timezone

import mujoco

DEFAULT_WORLD = {
    "places": {"desk": [0.0, 0.0], "kitchen": [3.0, 1.0], "living_room": [1.5, -2.0], "charger": [-1.5, 1.5]},
    "objects": {"cup": "kitchen", "book": "desk"},
    "people": {"Dal": [0.6, 0.5]},
    "obstacles": [[1.6, 0.4, 0.3, 0.3]],
}
REACH_M = 0.35
ARRIVED_M = 0.12
PERSON_GAP_M = 0.8


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def build_xml(world: dict) -> str:
    places = "".join(
        f'<site name="place:{name}" pos="{x} {y} 0.005" size="0.15 0.005" type="cylinder" rgba="0.3 0.6 1 0.3"/>'
        for name, (x, y) in world["places"].items()
    )
    obstacles = "".join(
        f'<geom name="obstacle:{i}" type="box" pos="{x} {y} 0.25" size="{w / 2} {h / 2} 0.25" rgba="0.5 0.4 0.3 1"/>'
        for i, (x, y, w, h) in enumerate(world.get("obstacles", []))
    )
    people = "".join(
        f'<body name="person:{name}" pos="{x} {y} 0.85"><geom name="person:{name}" type="capsule" size="0.2 0.65" rgba="0.9 0.7 0.6 1"/></body>'
        for name, (x, y) in world.get("people", {}).items()
    )
    objects = ""
    for name, place in world.get("objects", {}).items():
        x, y = world["places"][place]
        objects += (
            f'<body name="object:{name}" pos="{x + 0.2} {y} 0.05"><freejoint/>'
            f'<geom name="object:{name}" type="cylinder" size="0.04 0.05" mass="0.2" rgba="0.9 0.9 0.2 1"/></body>'
        )
    welds = "".join(
        f'<weld name="hold:{name}" body1="gripper" body2="object:{name}" active="false"/>'
        for name in world.get("objects", {})
    )
    return f"""<mujoco model="lumina">
  <compiler angle="radian"/>
  <option timestep="0.002"/>
  <worldbody>
    <light pos="0 0 4"/>
    <geom name="floor" type="plane" size="6 6 0.1" rgba="0.8 0.8 0.8 1"/>
    {places}{obstacles}{people}{objects}
    <body name="base" pos="0 0 0.12">
      <joint name="x" type="slide" axis="1 0 0" damping="5"/>
      <joint name="y" type="slide" axis="0 1 0" damping="5"/>
      <joint name="yaw" type="hinge" axis="0 0 1" damping="2"/>
      <geom name="base" type="cylinder" size="0.22 0.1" mass="12" rgba="0.2 0.2 0.25 1"/>
      <body name="head" pos="0 0 0.35">
        <joint name="pan" type="hinge" axis="0 0 1" range="-2.6 2.6" damping="0.6" armature="0.01"/>
        <joint name="tilt" type="hinge" axis="0 1 0" range="-0.8 0.8" damping="0.6" armature="0.01"/>
        <geom name="head" type="sphere" size="0.09" mass="0.5" rgba="0.9 0.9 0.95 1"/>
      </body>
      <body name="gripper" pos="0.3 0 0.0">
        <geom name="gripper" type="box" size="0.03 0.05 0.03" mass="0.1" contype="0" conaffinity="0"/>
      </body>
    </body>
  </worldbody>
  <equality>{welds}</equality>
  <actuator>
    <velocity name="vx" joint="x" kv="300"/>
    <velocity name="vy" joint="y" kv="300"/>
    <velocity name="vyaw" joint="yaw" kv="60"/>
    <position name="pan" joint="pan" kp="20"/>
    <position name="tilt" joint="tilt" kp="20"/>
  </actuator>
</mujoco>"""


class Body:
    def __init__(self, world: dict, realtime: float) -> None:
        self.world = world
        self.model = mujoco.MjModel.from_xml_string(build_xml(world))
        self.data = mujoco.MjData(self.model)
        self.realtime = realtime
        self.holding: str | None = None
        self.stop_requested = False
        self.base_geom = self.model.geom("base").id
        # Free-jointed objects come first in qpos; address the base's joints by name.
        self.qpos_at = {j: int(self.model.joint(j).qposadr[0]) for j in ("x", "y", "yaw", "pan")}
        self.qvel_at = [int(self.model.joint(j).dofadr[0]) for j in ("x", "y", "yaw")]

    # -- geometry -----------------------------------------------------------
    def pose(self) -> tuple[float, float, float]:
        q = self.data.qpos
        yaw = float(q[self.qpos_at["yaw"]])
        return float(q[self.qpos_at["x"]]), float(q[self.qpos_at["y"]]), math.atan2(math.sin(yaw), math.cos(yaw))

    def position_of(self, target: str) -> tuple[float, float] | None:
        if target in self.world["places"]:
            return tuple(self.world["places"][target])
        for prefix in ("object:", "person:"):
            try:
                body = self.model.body(prefix + target)
            except KeyError:
                continue
            x, y, _ = self.data.xpos[body.id]
            return float(x), float(y)
        return None

    def place(self) -> str | None:
        x, y, _ = self.pose()
        best = None
        for name, (px, py) in self.world["places"].items():
            d = math.hypot(px - x, py - y)
            if d <= 0.5 and (best is None or d < best[1]):
                best = (name, d)
        return best[0] if best else None

    def state(self) -> dict:
        x, y, yaw = self.pose()
        return {"x": round(x, 3), "y": round(y, 3), "yaw": round(yaw, 3), "place": self.place(), "holding": self.holding}

    def gripper_xy(self) -> tuple[float, float]:
        gx, gy, _ = self.data.xpos[self.model.body("gripper").id]
        return float(gx), float(gy)

    # -- stepping -----------------------------------------------------------
    def collided(self) -> str | None:
        for i in range(self.data.ncon):
            contact = self.data.contact[i]
            pair = {contact.geom1, contact.geom2}
            if self.base_geom in pair:
                other = (pair - {self.base_geom}).pop() if len(pair) == 2 else None
                if other is None:
                    continue
                name = self.model.geom(other).name
                if name.startswith(("obstacle:", "person:")):
                    return name
        return None

    def run(self, controller, max_sim_seconds: float, commands: "queue.Queue[dict | None]") -> tuple[bool, str, float]:
        started_sim = self.data.time
        started_wall = time.monotonic()
        steps = 0
        while True:
            done = controller()
            if done is not None:
                self.halt()
                return done[0], done[1], self.data.time - started_sim
            mujoco.mj_step(self.model, self.data)
            steps += 1
            hit = self.collided()
            if hit:
                self.halt()
                self.back_off(hit)
                return False, f"Stopped: contact with {hit}; backed off.", self.data.time - started_sim
            if self.data.time - started_sim > max_sim_seconds:
                self.halt()
                return False, "Timed out before reaching the goal.", self.data.time - started_sim
            if steps % 25 == 0:
                if self.drain(commands):
                    self.halt()
                    return False, "Stopped by a stop command.", self.data.time - started_sim
                if self.realtime > 0:
                    ahead = (self.data.time - started_sim) / self.realtime - (time.monotonic() - started_wall)
                    if ahead > 0:
                        time.sleep(ahead)

    def drain(self, commands: "queue.Queue[dict | None]") -> bool:
        """Stop and quit act during motion; anything else waits its turn."""
        pending = []
        stop = False
        while True:
            try:
                command = commands.get_nowait()
            except queue.Empty:
                break
            if command is None or command.get("cmd") in ("stop", "quit"):
                stop = True
                if command is None or command.get("cmd") == "quit":
                    pending.append(command)
            else:
                pending.append(command)
        for command in pending:
            commands.put(command)
        return stop

    def back_off(self, geom_name: str, distance: float = 0.08) -> None:
        """After a contact, step away from it so the next intent starts clear."""
        x, y, _ = self.pose()
        gx, gy, _ = self.data.geom_xpos[self.model.geom(geom_name).id]
        dx, dy = x - float(gx), y - float(gy)
        norm = math.hypot(dx, dy) or 1.0
        self.data.qpos[self.qpos_at["x"]] = x + distance * dx / norm
        self.data.qpos[self.qpos_at["y"]] = y + distance * dy / norm
        mujoco.mj_forward(self.model, self.data)

    def obstacles(self) -> list[tuple[float, float, float]]:
        """Centers to keep away from, with a clearance radius: people and fixed obstacles."""
        out = [(float(x), float(y), 0.95) for x, y in self.world.get("people", {}).values()]
        out += [(float(x), float(y), 0.6 + max(w, h) / 2) for x, y, w, h in self.world.get("obstacles", [])]
        return out

    def halt(self) -> None:
        self.data.ctrl[0:3] = 0.0
        for index in self.qvel_at:
            self.data.qvel[index] = 0.0

    # -- behaviors ----------------------------------------------------------
    def drive_to(self, goal: tuple[float, float], stop_short: float, max_speed: float, commands) -> tuple[bool, str, float]:
        def controller():
            x, y, yaw = self.pose()
            dx, dy = goal[0] - x, goal[1] - y
            dist = math.hypot(dx, dy)
            if dist <= stop_short + ARRIVED_M:
                return True, f"Arrived ({dist:.2f} m from the goal)."
            speed = min(max_speed, 1.5 * (dist - stop_short))
            vx, vy = dx / dist, dy / dist
            # Steer around people and obstacles (a simple potential field), but not around the goal itself.
            for ox, oy, clearance in self.obstacles():
                ax, ay = x - ox, y - oy
                d = math.hypot(ax, ay)
                if 1e-6 < d < clearance and math.hypot(goal[0] - ox, goal[1] - oy) > clearance:
                    push = (clearance - d) / clearance * 4.0
                    vx += push * ax / d - push * 0.5 * ay / d
                    vy += push * ay / d + push * 0.5 * ax / d
            norm = math.hypot(vx, vy) or 1.0
            self.data.ctrl[0] = speed * vx / norm
            self.data.ctrl[1] = speed * vy / norm
            heading = math.atan2(dy, dx)
            error = math.atan2(math.sin(heading - yaw), math.cos(heading - yaw))
            self.data.ctrl[2] = max(-1.5, min(1.5, 3.0 * error))
            return None

        return self.run(controller, 90.0, commands)

    def look_at(self, target: tuple[float, float], commands) -> tuple[bool, str, float]:
        x, y, yaw = self.pose()
        pan = math.atan2(target[1] - y, target[0] - x) - yaw
        pan = math.atan2(math.sin(pan), math.cos(pan))
        pan = max(-2.6, min(2.6, pan))
        self.data.ctrl[3] = pan

        def controller():
            current = float(self.data.qpos[self.qpos_at["pan"]])
            return (True, "Looking at the target.") if abs(current - pan) < 0.05 else None

        return self.run(controller, 5.0, commands)

    def execute(self, intent: dict, limits: dict, commands) -> tuple[bool, str, float]:
        kind = intent.get("type")
        max_speed = max(0.05, min(1.0, float(limits.get("maxSpeedMps", 0.5))))
        if kind == "stop":
            self.halt()
            return True, "Stopped.", 0.0
        if kind in ("look_at", "point"):
            target = self.position_of(str(intent.get("targetId", "")))
            if target is None:
                return False, f"The simulator does not know {intent.get('targetId')}.", 0.0
            return self.look_at(target, commands)
        if kind == "gesture":
            name = str(intent.get("name", "nod"))
            return True, f"Gesture {name} with the head.", 0.5
        if kind in ("navigate_to", "follow"):
            target_id = str(intent.get("targetId") or intent.get("personId") or "")
            goal = self.position_of(target_id)
            if goal is None:
                return False, f"The simulator does not know {target_id}.", 0.0
            short = PERSON_GAP_M if kind == "follow" or target_id in self.world.get("people", {}) else 0.0
            return self.drive_to(goal, short, max_speed, commands)
        if kind == "grasp":
            name = str(intent.get("objectId", ""))
            if self.holding:
                return False, f"Already holding {self.holding}.", 0.0
            goal = self.position_of(name)
            if goal is None or name not in self.world.get("objects", {}):
                return False, f"No object {name} in the simulator.", 0.0
            ok, detail, seconds = self.drive_to(goal, 0.3, max_speed, commands)
            if not ok:
                return ok, detail, seconds
            gx, gy = self.gripper_xy()
            ox, oy = self.position_of(name) or goal
            if math.hypot(ox - gx, oy - gy) > REACH_M:
                return False, f"{name} is out of the gripper's reach.", seconds
            self.data.eq_active[self.model.equality(f"hold:{name}").id] = 1
            self.holding = name
            return True, f"Holding {name}.", seconds
        if kind in ("place", "handover"):
            name = str(intent.get("objectId", ""))
            if self.holding != name:
                return False, f"Not holding {name}.", 0.0
            target_id = str(intent.get("onId") or intent.get("personId") or "")
            goal = self.position_of(target_id)
            if goal is None:
                return False, f"The simulator does not know {target_id}.", 0.0
            short = PERSON_GAP_M if kind == "handover" else 0.3
            ok, detail, seconds = self.drive_to(goal, short, min(max_speed, 0.3), commands)
            if not ok:
                return ok, detail, seconds
            self.data.eq_active[self.model.equality(f"hold:{name}").id] = 0
            self.holding = None
            verb = "Handed" if kind == "handover" else "Placed"
            return True, f"{verb} {name} {'to' if kind == 'handover' else 'on'} {target_id}.", seconds
        return False, f"The simulator cannot do {kind}.", 0.0


def read_commands(commands: "queue.Queue[dict | None]") -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except json.JSONDecodeError:
            emit({"kind": "error", "atISO": now_iso(), "message": "unreadable command"})
    commands.put(None)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--world", default="", help="JSON file with places, objects, people, obstacles")
    parser.add_argument("--realtime", type=float, default=1.0, help="1 = real time, 0 = as fast as possible")
    args = parser.parse_args()
    world = DEFAULT_WORLD
    if args.world:
        with open(args.world, encoding="utf-8") as handle:
            world = json.load(handle)
    try:
        body = Body(world, args.realtime)
    except Exception as error:  # noqa: BLE001
        emit({"kind": "error", "atISO": now_iso(), "message": f"simulator failed to start: {error}"})
        return 2

    commands: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=read_commands, args=(commands,), daemon=True).start()
    emit({
        "kind": "start",
        "atISO": now_iso(),
        "places": sorted(world["places"]),
        "objects": world.get("objects", {}),
        "people": sorted(world.get("people", {})),
    })
    while True:
        command = commands.get()
        if command is None or command.get("cmd") == "quit":
            return 0
        if command.get("cmd") == "stop":
            body.halt()
            continue
        if command.get("cmd") == "state":
            emit({"kind": "state", "id": command.get("id"), "state": body.state()})
            continue
        if command.get("cmd") == "execute":
            try:
                ok, detail, seconds = body.execute(command.get("intent", {}), command.get("limits", {}), commands)
            except Exception as error:  # noqa: BLE001
                ok, detail, seconds = False, f"simulator error: {error}", 0.0
            emit({
                "kind": "result",
                "id": command.get("id"),
                "ok": ok,
                "detail": detail,
                "simSeconds": round(seconds, 2),
                "state": body.state(),
            })


if __name__ == "__main__":
    sys.exit(main())
