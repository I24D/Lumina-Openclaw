/**
 * Minimal Chrome DevTools Protocol client for the managed browser.
 *
 * The browser plugin owns Playwright-based automation; this bridge only needs to
 * attach to one existing tab and listen, so it speaks CDP directly over the
 * global WebSocket rather than taking that dependency.
 */

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
};

export type CdpConnection = {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  on: (method: string, handler: (params: Record<string, unknown>) => void) => void;
  /** Resolves when the socket closes for any reason. */
  closed: Promise<void>;
  close: () => void;
  targetUrl: string;
};

class CdpError extends Error {}

/** Lists page targets, returning [] when the browser is not reachable. */
export async function listPageTargets(cdpUrl: string, signal?: AbortSignal): Promise<CdpTarget[]> {
  try {
    const response = await fetch(new URL("/json/list", cdpUrl), { signal });
    if (!response.ok) {
      return [];
    }
    const targets = (await response.json()) as CdpTarget[];
    return Array.isArray(targets) ? targets.filter((target) => target.type === "page") : [];
  } catch {
    return [];
  }
}

/** Picks the newest page whose URL contains `urlPattern`. */
export function selectTarget(
  targets: readonly CdpTarget[],
  urlPattern: string,
): CdpTarget | undefined {
  return targets.find((target) => target.url.includes(urlPattern) && target.webSocketDebuggerUrl);
}

export async function connectToTarget(target: CdpTarget): Promise<CdpConnection> {
  const endpoint = target.webSocketDebuggerUrl;
  if (!endpoint) {
    throw new CdpError(`target ${target.id} exposes no debugger endpoint`);
  }
  const socket = new WebSocket(endpoint);
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  let nextId = 1;

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new CdpError(`cannot open a debugger socket for ${target.url}`)),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined) {
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry) {
        return;
      }
      const error = message.error as { message?: string } | undefined;
      if (error) {
        entry.reject(new CdpError(error.message ?? "CDP call failed"));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    if (!method) {
      return;
    }
    for (const handler of handlers.get(method) ?? []) {
      handler((message.params ?? {}) as Record<string, unknown>);
    }
  });

  const finish = () => {
    for (const entry of pending.values()) {
      entry.reject(new CdpError("debugger socket closed"));
    }
    pending.clear();
    resolveClosed();
  };
  socket.addEventListener("close", finish, { once: true });
  socket.addEventListener("error", finish, { once: true });

  return {
    targetUrl: target.url,
    send: <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new CdpError("debugger socket is not open"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, handler) => {
      const existing = handlers.get(method);
      if (existing) {
        existing.push(handler);
      } else {
        handlers.set(method, [handler]);
      }
    },
    closed,
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closing; `finish` still settles the waiters.
      }
    },
  };
}
