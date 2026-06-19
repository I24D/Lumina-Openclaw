/**
 * tool-schemas.mjs — Static tool definitions for all lumina-pc tools
 *
 * Sent with every BrainTurnRequest so Lumina Brain knows what it can call.
 * These schemas mirror the TypeBox definitions in the lumina-pc plugin source.
 * Update this file if new tools are added to the plugin.
 */

/** @type {import("../../../packages/lumina-protocol/src/types.js").ToolDefinition[]} */
export const LUMINA_TOOL_SCHEMAS = [
  {
    name: "lumina_system_metrics",
    description:
      "Returns real-time system metrics for the local Windows PC: " +
      "CPU usage %, total/free RAM, uptime, platform info, and optional network interfaces. " +
      "Use when the user asks about PC performance, RAM, CPU load, or hardware specs.",
    parameters: {
      type: "object",
      properties: {
        include_network: {
          type: "boolean",
          description: "Include network interface details. Default: false.",
        },
      },
    },
  },

  {
    name: "lumina_process_list",
    description:
      "Lists running processes on the Windows PC with name, PID, CPU and memory usage. " +
      "Use when the user asks what programs are running, task manager data, or wants to find a specific process.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Filter processes by name (partial match, case-insensitive). Leave empty for all.",
        },
        top: {
          type: "number",
          description: "Return only the top N processes sorted by CPU. Default: 50. Max: 500.",
          minimum: 1,
          maximum: 500,
        },
        sort_by: {
          type: "string",
          enum: ["cpu", "memory", "name"],
          description: "Sort by cpu | memory | name. Default: cpu.",
        },
      },
    },
  },

  {
    name: "lumina_window_control",
    description:
      "Lists visible windows on the desktop, or brings a specific window to the foreground. " +
      "Use when the user asks what windows are open, wants to switch focus, or asks about active apps.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "focus"],
          description: "list — enumerate all visible windows. focus — bring a window to the front.",
        },
        title: {
          type: "string",
          description: "Window title to focus (partial match). Required for focus action.",
        },
      },
      required: ["action"],
    },
  },

  {
    name: "lumina_clipboard",
    description:
      "Reads or writes the Windows clipboard text content. " +
      "Use get to see what the user has copied. Use set to place text into the clipboard.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set"],
          description: "get — read clipboard content. set — write text to clipboard.",
        },
        text: {
          type: "string",
          description: "Text to write to the clipboard. Required for set action.",
        },
      },
      required: ["action"],
    },
  },

  {
    name: "lumina_screen_capture",
    description:
      "Takes a screenshot of the primary monitor. Optionally runs Windows OCR to extract visible text. " +
      "Use when the user asks what is on their screen, wants a screenshot, or needs OCR of screen content.",
    parameters: {
      type: "object",
      properties: {
        ocr: {
          type: "boolean",
          description: "If true, also extract visible text via Windows OCR. Default: false.",
        },
        return_image: {
          type: "boolean",
          description: "If true (default), include the screenshot image in the result.",
        },
      },
    },
  },

  {
    name: "lumina_file_ops",
    description:
      "Performs file system operations on the local Windows PC: " +
      "read a file, write/append text, list a directory, delete, move, copy, stat, or check existence. " +
      "Paths can be absolute (C:\\Users\\...) or relative.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write", "append", "list", "delete", "move", "copy", "exists", "stat"],
          description: "Action to perform.",
        },
        path: {
          type: "string",
          description: "Target file or directory path.",
        },
        content: {
          type: "string",
          description: "Content to write or append (required for write/append).",
        },
        destination: {
          type: "string",
          description: "Destination path (required for move/copy).",
        },
        recursive: {
          type: "boolean",
          description: "For list: include subdirectories recursively. Default: false.",
        },
        limit: {
          type: "number",
          description: "For list: number of entries to return. Default: 200. Max: 500.",
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: "number",
          description: "For list: zero-based offset for pagination. Default: 0.",
          minimum: 0,
        },
        encoding: {
          type: "string",
          description: "Text encoding for read/write. Default: utf8.",
        },
      },
      required: ["action", "path"],
    },
  },

  {
    name: "lumina_shell_run",
    description:
      "Executes a PowerShell (or CMD) command on the local Windows PC and returns stdout, stderr, exit code. " +
      "Use for querying WMI, managing files or services, running scripts, installing packages, etc. " +
      "Requires explicit user approval for destructive operations.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The PowerShell command or script block. " +
            "Example: Get-Process | Sort-Object CPU -Descending | Select-Object -First 10",
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in milliseconds. Default: 30000. Max: 120000.",
          minimum: 1000,
          maximum: 120000,
        },
        shell: {
          type: "string",
          enum: ["powershell", "cmd"],
          description: "Shell to use. Default: powershell.",
        },
      },
      required: ["command"],
    },
  },

  {
    name: "lumina_notify_toast",
    description:
      "Shows a Windows Toast notification to the user. " +
      "Use when you need to alert the user about an important event, completion, or error " +
      "while they are doing something else.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Notification title (short, 1–5 words).",
          maxLength: 64,
        },
        message: {
          type: "string",
          description: "Notification body text. Keep under 200 characters.",
          maxLength: 256,
        },
        app_id: {
          type: "string",
          description: "App identifier shown in Windows notifications. Default: 'OpenClaw · Lumina_PC'.",
        },
      },
      required: ["title", "message"],
    },
  },
];
