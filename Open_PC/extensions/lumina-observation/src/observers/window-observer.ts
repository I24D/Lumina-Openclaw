/**
 * Foreground window observer.
 *
 * Uses Windows' UI Automation via P/Invoke through PowerShell because
 * Tauri's win32 access is sandboxed and we'd rather not ship a native
 * addon. The cost is ~50 ms per call which is fine at our polling rate.
 */
import { runPowerShellJson } from "../utils/powershell.js";
import type { ForegroundWindow } from "../types.js";

const TITLE_CAP = 240;

const PS_SCRIPT = `
  Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public static class WinAPI {
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
      [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
      [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
    }
"@ -ErrorAction SilentlyContinue
  $hWnd = [WinAPI]::GetForegroundWindow()
  if ($hWnd -eq [IntPtr]::Zero) { return $null }
  $len = [WinAPI]::GetWindowTextLength($hWnd)
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][WinAPI]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $pid = 0
  [void][WinAPI]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  [pscustomobject]@{
    title = $sb.ToString()
    processName = if ($proc) { $proc.ProcessName } else { '' }
    processId = $pid
  }
`;

type RawForeground = {
  title?: string;
  processName?: string;
  processId?: number;
};

export async function readForegroundWindow(): Promise<ForegroundWindow | null> {
  const r = await runPowerShellJson<RawForeground>(PS_SCRIPT, 5_000);
  if (!r.ok || r.data === null) return null;
  const title = String(r.data.title ?? "").slice(0, TITLE_CAP);
  const processName = String(r.data.processName ?? "");
  const processId = Number(r.data.processId ?? 0);
  if (!processName || !processId) return null;
  return { title, processName, processId };
}
