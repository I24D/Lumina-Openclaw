/**
 * window-control.ts
 * Tool: lumina_window_control
 *
 * Lists open windows and controls their focus/state via PowerShell + WinAPI.
 * I24D uses this to understand what the user has open and to switch focus.
 */

import { Type } from "typebox";
import { ToolInputError, jsonResult } from "../../../../src/agents/tools/common.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { psEscape, runPowerShell } from "../utils/powershell.js";

const LIST_WINDOWS_PS = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<object[]> GetAll() {
    var list = new List<object[]>();
    EnumWindows((h,_) => {
      if (IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        var t = sb.ToString().Trim();
        if (t.Length > 0) {
          uint pid = 0; GetWindowThreadProcessId(h, out pid);
          list.Add(new object[]{ h.ToInt64(), t, pid });
        }
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$wins = [WinList]::GetAll()
$result = $wins | ForEach-Object {
  $proc = Get-Process -Id $_[2] -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    handle = $_[0]
    title  = $_[1]
    pid    = $_[2]
    process = if($proc){ $proc.ProcessName } else { "unknown" }
  }
}
$result | ConvertTo-Json -Compress
`.trim();

const FOCUS_WINDOW_PS = (title: string) =>
  `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lp2);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
"@
$target = "${psEscape(title)}"
$found = $false
[WinFocus]::EnumWindows({
  param($h, $lp)
  if ([WinFocus]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinFocus]::GetWindowText($h, $sb, 256) | Out-Null
    if ($sb.ToString() -like "*$target*") {
      [WinFocus]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
      [WinFocus]::SetForegroundWindow($h) | Out-Null
      $script:found = $true
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output $found
`.trim();

export function createWindowControlTool(): AnyAgentTool {
  return {
    name: "lumina_window_control",
    description:
      "Lists visible windows on the desktop or focuses a specific window by title. " +
      "Use list to see what the user has open. Use focus to bring a window to the foreground.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("focus")], {
        description: "list — enumerate all visible windows. focus — bring a window to the front.",
      }),
      title: Type.Optional(
        Type.String({
          description: "Window title to focus (partial match). Required for focus action.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (process.platform !== "win32") {
        return jsonResult({
          ok: false,
          error: "lumina_window_control is only available on Windows.",
        });
      }

      if (params.action === "list") {
        const result = await runPowerShell(LIST_WINDOWS_PS, 15_000);
        if (!result.ok) {
          return jsonResult({ ok: false, error: result.error ?? result.stderr });
        }
        let windows: unknown[] = [];
        try {
          const parsed = JSON.parse(result.stdout);
          windows = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          windows = [];
        }
        return jsonResult({ ok: true, count: windows.length, windows });
      }

      if (params.action === "focus") {
        const title = params.title?.trim();
        if (!title) throw new ToolInputError("title is required for focus action.");
        const result = await runPowerShell(FOCUS_WINDOW_PS(title), 10_000);
        const focused = result.stdout.trim().toLowerCase() === "true";
        return jsonResult({
          ok: result.ok && focused,
          focused,
          title,
          error: result.ok
            ? focused
              ? undefined
              : `No window matching "${title}" found.`
            : result.error,
        });
      }

      throw new ToolInputError("action must be list or focus.");
    },
  };
}
