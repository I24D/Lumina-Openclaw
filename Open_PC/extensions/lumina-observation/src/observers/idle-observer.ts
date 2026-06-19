/**
 * User-idle observer.
 *
 * Reads how long since the last input (mouse/keyboard) via the Win32
 * `GetLastInputInfo` API. This is the canonical way to know whether the
 * user is "at the desk". It does NOT distinguish between a screen lock
 * and an away user — Phase 3 treats both as "user is idle".
 */
import { runPowerShellJson } from "../utils/powershell.js";

const PS_SCRIPT = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public static class IdleAPI {
      [StructLayout(LayoutKind.Sequential)]
      public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
      }
      [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
      [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    }
"@ -ErrorAction SilentlyContinue
  $info = New-Object IdleAPI+LASTINPUTINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [IdleAPI]::GetLastInputInfo([ref]$info)) { return @{ idleMs = -1 } }
  $idleMs = [IdleAPI]::GetTickCount() - $info.dwTime
  return @{ idleMs = [int64]$idleMs }
`;

type RawIdle = {
  idleMs?: number;
};

export async function readUserIdleMs(): Promise<number> {
  const r = await runPowerShellJson<RawIdle>(PS_SCRIPT, 5_000);
  if (!r.ok || r.data === null) return 0;
  const ms = Number(r.data.idleMs ?? 0);
  // -1 means GetLastInputInfo failed; treat as 0 (active) to avoid false
  // "user is idle" narrations.
  return ms < 0 ? 0 : ms;
}
