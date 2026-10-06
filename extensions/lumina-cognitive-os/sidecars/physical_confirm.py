"""physical_confirm.py - A confirmation only a person at the keyboard can give.

Lumina spec section 44 (hardware safety) and 143 (human override). A physical
action waiting for a person can be approved with Ctrl+Alt+Y or refused with
Ctrl+Alt+N on the real keyboard. Key presses that software injected (SendInput,
which the agent's PC tools use) carry the LLKHF_INJECTED flag in the Windows
low-level keyboard hook and are ignored, so the agent cannot press the keys for
itself. Only one request is armed at a time and only while armed does a chord
count.

Protocol (one JSON object per line):
  stdout  {"kind":"start","atISO":...}
          {"kind":"confirmed","requestId":r,"approve":true|false,"atISO":...}
          {"kind":"injected_ignored","atISO":...}
          {"kind":"error","atISO":...,"message":...}
  stdin   {"cmd":"arm","requestId":r}
          {"cmd":"disarm"}
          {"cmd":"stop"}
Exits when stdin closes, so it never outlives the gateway.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone

LLKHF_INJECTED = 0x10
APPROVE = {"ctrl", "alt", "y"}
REJECT = {"ctrl", "alt", "n"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    if os.name != "nt":
        emit({"kind": "error", "atISO": now_iso(), "message": "physical confirmation needs Windows"})
        return 2
    try:
        from pynput import keyboard
    except Exception as error:  # noqa: BLE001
        emit({"kind": "error", "atISO": now_iso(), "message": f"pynput unavailable: {error}"})
        return 2

    lock = threading.Lock()
    armed: dict = {"requestId": None}
    pressed: set[str] = set()
    stopping = threading.Event()

    def name(key) -> str:
        mapping = {
            keyboard.Key.ctrl_l: "ctrl", keyboard.Key.ctrl_r: "ctrl",
            keyboard.Key.alt_l: "alt", keyboard.Key.alt_r: "alt", keyboard.Key.alt_gr: "alt",
        }
        if key in mapping:
            return mapping[key]
        # With Ctrl held, char is a control code; the virtual key code is reliable.
        vk = getattr(key, "vk", None)
        if vk is not None and 0x41 <= vk <= 0x5A:
            return chr(vk).lower()
        char = getattr(key, "char", None)
        return char.lower() if char else str(key)

    def win32_filter(_msg, data) -> bool:
        if data.flags & LLKHF_INJECTED:
            if armed["requestId"] is not None:
                # Worth knowing only while a confirmation is pending: something tried to answer it.
                emit({"kind": "injected_ignored", "atISO": now_iso()})
            return False  # software-made: never reaches on_press
        return True

    def on_press(key) -> None:
        pressed.add(name(key))
        with lock:
            request_id = armed["requestId"]
            if request_id is None:
                return
            decision = True if APPROVE <= pressed else False if REJECT <= pressed else None
            if decision is None:
                return
            armed["requestId"] = None
        emit({"kind": "confirmed", "requestId": request_id, "approve": decision, "atISO": now_iso()})

    def on_release(key) -> None:
        pressed.discard(name(key))

    def read_commands() -> None:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("cmd") == "arm":
                with lock:
                    armed["requestId"] = command.get("requestId")
            elif command.get("cmd") == "disarm":
                with lock:
                    armed["requestId"] = None
            elif command.get("cmd") == "stop":
                break
        stopping.set()

    listener = keyboard.Listener(on_press=on_press, on_release=on_release, win32_event_filter=win32_filter)
    listener.start()
    threading.Thread(target=read_commands, daemon=True).start()
    emit({"kind": "start", "atISO": now_iso()})
    stopping.wait()
    listener.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
