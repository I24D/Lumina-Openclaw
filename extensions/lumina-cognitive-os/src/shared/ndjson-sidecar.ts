/**
 * ndjson-sidecar.ts — A long-lived Python sidecar that talks in JSON lines.
 *
 * The sidecar writes one JSON object per line on stdout and reads commands the
 * same way on stdin; it exits when stdin closes, so it never outlives the
 * gateway. Camera and voice perception, keyboard confirmation and the MuJoCo
 * body all run on this, so the subprocess lifecycle lives in one place.
 *
 * A sidecar that keeps failing is not respawned in a tight loop: after an
 * unexpected exit, `start()` refuses until a back-off passes (2 s, doubling,
 * at most 5 min), and the last lines of stderr explain why it stopped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pickPython, resolveSidecarScriptPath } from "./python.js";

export type SidecarExit = {
  readonly kind: "exit";
  readonly code: number | null;
  /** The last stderr line, when the sidecar failed. */
  readonly detail?: string;
};

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 300_000;

export type NdjsonSidecarOptions = {
  /** Sidecar file name without `.py`, under `sidecars/`. */
  readonly name: string;
  readonly args: () => ReadonlyArray<string>;
  readonly pythonExe?: string;
  readonly scriptPath?: string;
  readonly spawnImpl?: typeof spawn;
  /** How long `stop()` waits for a clean exit before killing. Default 3 s. */
  readonly stopGraceMs?: number;
  readonly now?: () => number;
};

export class NdjsonSidecar<TEvent extends { readonly kind: string }> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly listeners = new Set<(event: TEvent | SidecarExit) => void>();
  private lastEventAtISO: string | undefined;
  private stderrTail = "";
  private stopping = false;
  private failures = 0;
  private retryAtMs = 0;
  private lastFailure: string | undefined;

  constructor(private readonly options: NdjsonSidecarOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  running(): boolean {
    return this.child !== null;
  }

  status(): {
    readonly running: boolean;
    readonly pid: number | null;
    readonly lastEventAtISO?: string;
    readonly lastFailure?: string;
  } {
    return {
      running: this.child !== null,
      pid: this.child?.pid ?? null,
      ...(this.lastEventAtISO ? { lastEventAtISO: this.lastEventAtISO } : {}),
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  on(listener: (event: TEvent | SidecarExit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TEvent | SidecarExit): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  start(): { readonly ok: boolean; readonly error?: string } {
    if (this.child) {
      return { ok: true };
    }
    const waitMs = this.retryAtMs - this.now();
    if (waitMs > 0) {
      return {
        ok: false,
        error: `${this.lastFailure ?? `${this.options.name} failed`}; retrying in ${Math.ceil(waitMs / 1000)} s`,
      };
    }
    const python = this.options.pythonExe ?? pickPython();
    const script = this.options.scriptPath ?? resolveSidecarScriptPath(this.options.name);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.options.spawnImpl ?? spawn)(python, [script, ...this.options.args()], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";
    this.stopping = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    // stderr carries library warnings and, when the sidecar dies, the reason.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000);
    });
    child.on("error", () => undefined);
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
      }
      const failed = !this.stopping && code !== 0;
      const detail = failed ? this.stderrTail.trim().split(/\r?\n/u).at(-1)?.trim() : undefined;
      if (failed) {
        this.failures += 1;
        this.retryAtMs =
          this.now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (this.failures - 1));
        this.lastFailure = `${this.options.name} exited with code ${code}${detail ? `: ${detail}` : ""}`;
      }
      this.emit({ kind: "exit", code, ...(detail ? { detail } : {}) });
    });
    return { ok: true };
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          const event = JSON.parse(line) as TEvent;
          if (event && typeof event.kind === "string") {
            this.lastEventAtISO = new Date().toISOString();
            // It spoke the protocol: it is healthy, so the back-off starts over.
            this.failures = 0;
            this.emit(event);
          }
        } catch {
          // A partial or foreign line; the protocol has no other output.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Writes one command line; false when the sidecar is not running. */
  send(command: Readonly<Record<string, unknown>>): boolean {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return false;
    }
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  /** Asks the sidecar to stop, then kills it if it has not exited in time. */
  stop(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopping = true;
    this.send({ cmd: "stop" });
    child.stdin.end();
    const timer = setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }, this.options.stopGraceMs ?? 3_000);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
  }
}
