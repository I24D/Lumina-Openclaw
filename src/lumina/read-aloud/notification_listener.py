"""Windows toast-notification source for Start Talk's read-aloud pipeline.

Reads the WinRT UserNotificationListener directly, so nothing steals focus and no
window is opened: the Action Center is queried in place. Pure Python WinRT, never
PowerShell, because Bitdefender's AMSI hook blocks scripted PowerShell here.

Modes:
  (default)   one JSON snapshot of the current toasts on stdout, then exit.
  --watch     stay alive and print one JSON line per NEW toast as it arrives. The
              first sweep is a silent baseline so toasts already sitting in the
              Action Center at startup are not read out loud.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from typing import Any, Dict, List

MAX_TEXT = 1000
MAX_SEEN_IDS = 500


def _clip(value: Any) -> str:
    return str(value or "").strip()[:MAX_TEXT]


def _write(payload: Dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


async def _open_listener():
    """Returns (listener, error). The listener is None when access is unavailable."""
    try:
        from winsdk.windows.ui.notifications.management import (
            UserNotificationListener,
            UserNotificationListenerAccessStatus,
        )
    except Exception as exc:  # noqa: BLE001 - any import failure means no listener
        return None, f"winsdk_missing: {exc!s}"

    listener = UserNotificationListener.current
    access = await listener.request_access_async()
    if access != UserNotificationListenerAccessStatus.ALLOWED:
        return None, "notification_access_denied"
    return listener, None


async def _read(listener) -> List[Dict[str, Any]]:
    from winsdk.windows.ui.notifications import NotificationKinds

    notifications = await listener.get_notifications_async(NotificationKinds.TOAST)
    out: List[Dict[str, Any]] = []
    for item in notifications:
        app_id = ""
        app_name = ""
        try:
            app_id = _clip(item.app_info.app_user_model_id)
            app_name = _clip(item.app_info.display_info.display_name)
        except Exception:  # noqa: BLE001 - AppInfo is best effort on some builds
            pass

        texts: List[str] = []
        try:
            # The literal template name is required: this winsdk build exposes no
            # toast_generic member on KnownNotificationBindings.
            binding = item.notification.visual.get_binding("ToastGeneric")
            if binding is not None:
                texts = [_clip(element.text) for element in binding.get_text_elements()]
        except Exception:  # noqa: BLE001 - non-generic toasts carry no readable text
            pass
        texts = [text for text in texts if text][:8]
        if not texts:
            continue  # silent or progress-only toast

        created_iso = ""
        try:
            created = item.creation_time
            created_iso = created.isoformat() if hasattr(created, "isoformat") else str(created)
        except Exception:  # noqa: BLE001
            pass
        try:
            notification_id = str(item.id)
        except Exception:  # noqa: BLE001
            notification_id = ""

        out.append(
            {
                "id": f"{notification_id}|{app_id}|{created_iso}",
                "notificationId": notification_id,
                "appName": app_name or "Notificacion",
                "appUserModelId": app_id or None,
                "title": texts[0],
                "body": " ".join(texts[1:]) or None,
                "textElements": texts,
                "createdAt": created_iso,
            }
        )
    return out


async def _snapshot() -> Dict[str, Any]:
    listener, error = await _open_listener()
    if listener is None:
        return {"ok": False, "error": error}
    return {
        "ok": True,
        "source": "user-notification-listener",
        "notifications": await _read(listener),
        "readAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


async def _watch(interval_ms: int) -> int:
    listener, error = await _open_listener()
    if listener is None:
        _write({"type": "error", "error": error})
        return 1

    seen: Dict[str, float] = {}
    baselined = False
    while True:
        try:
            notifications = await _read(listener)
        except Exception as exc:  # noqa: BLE001 - a transient read must not kill the watcher
            _write({"type": "warning", "error": f"read_failed: {exc!s}"})
            await asyncio.sleep(interval_ms / 1000)
            continue

        current = time.time()
        for notification in notifications:
            key = notification["id"]
            if key in seen:
                seen[key] = current
                continue
            seen[key] = current
            if baselined:
                _write({"type": "notification", "notification": notification})

        if not baselined:
            baselined = True
            _write({"type": "ready", "baseline": len(seen)})

        if len(seen) > MAX_SEEN_IDS:
            # Drop the oldest ids; a toast that old cannot come back as "new".
            for key in sorted(seen, key=lambda item: seen[item])[: len(seen) - MAX_SEEN_IDS]:
                del seen[key]

        await asyncio.sleep(interval_ms / 1000)


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser(description="Read Windows toast notifications (WinRT)")
    parser.add_argument("--watch", action="store_true", help="stream new toasts as they arrive")
    parser.add_argument("--interval-ms", type=int, default=2000, help="watch poll interval")
    args = parser.parse_args()

    if sys.platform != "win32":
        _write({"type": "error", "error": "notification_listener_only_runs_on_windows"})
        raise SystemExit(2)

    if args.watch:
        try:
            raise SystemExit(asyncio.run(_watch(max(500, args.interval_ms))))
        except KeyboardInterrupt:
            raise SystemExit(0)

    try:
        result = asyncio.run(_snapshot())
    except Exception as exc:  # noqa: BLE001
        _write({"ok": False, "error": f"listener_failed: {exc!s}"})
        raise SystemExit(1)
    _write(result)
    raise SystemExit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
