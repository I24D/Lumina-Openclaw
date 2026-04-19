/**
 * notify-toast.ts
 * Tool: lumina_notify_toast
 *
 * Shows a Windows Toast notification using PowerShell + WinRT.
 * I24D uses this to alert the user of important events that need attention.
 *
 * Works on Windows 10+ without any extra dependencies.
 */

import { Type } from "@sinclair/typebox";
import { jsonResult } from "../../../../src/agents/tools/common.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { psEscape, runPowerShell } from "../utils/powershell.js";

function buildToastCommand(params: {
  title: string;
  message: string;
  app_id?: string;
}): string {
  const title = psEscape(params.title);
  const message = psEscape(params.message);
  const appId = psEscape(params.app_id ?? "OpenClaw · Lumina_PC");

  return `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null

$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${title}</text>
      <text>${message}</text>
    </binding>
  </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${appId}").Show($toast)
Write-Output "ok"
`.trim();
}

export function createNotifyToastTool(): AnyAgentTool {
  return {
    name: "lumina_notify_toast",
    description:
      "Shows a Windows Toast notification to the user. " +
      "Use this when I24D needs to alert the user about something important: " +
      "a task completed, an error occurred, attention is required, etc. " +
      "The notification appears in the Windows notification area.",
    parameters: Type.Object({
      title: Type.String({
        description: "Notification title (short, 1–5 words). Example: 'I24D Alert'",
        maxLength: 64,
      }),
      message: Type.String({
        description: "Notification body text. Keep it concise (under 200 characters).",
        maxLength: 256,
      }),
      app_id: Type.Optional(
        Type.String({
          description: "App identifier shown in Windows notifications. Default: 'OpenClaw · Lumina_PC'.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params) {
      if (process.platform !== "win32") {
        return jsonResult({ ok: false, error: "Toast notifications are only available on Windows." });
      }

      const title = (params.title ?? "").trim().slice(0, 64) || "Lumina_PC";
      const message = (params.message ?? "").trim().slice(0, 256);

      const psCmd = buildToastCommand({ title, message, app_id: params.app_id });
      const result = await runPowerShell(psCmd, 8_000);

      return jsonResult({
        ok: result.ok,
        title,
        message,
        error: result.ok ? undefined : result.error ?? result.stderr,
      });
    },
  };
}
