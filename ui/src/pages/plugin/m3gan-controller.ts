import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { M3ganStatePayload, M3ganUiState } from "./m3gan-types.ts";

const POLL_INTERVAL_MS = 5_000;

type M3ganControllerState = M3ganUiState & {
  // Rebinding to another gateway client retires every pending result, so an
  // old connection never writes into the replacement view.
  client: GatewayBrowserClient | null;
  generation: number;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
};

const m3ganStates = new WeakMap<object, M3ganControllerState>();

export function getM3ganState(host: object): M3ganControllerState {
  let state = m3ganStates.get(host);
  if (!state) {
    state = {
      tab: "live",
      state: null,
      loading: false,
      error: null,
      pending: null,
      notice: null,
      requestUpdate: null,
      client: null,
      generation: 0,
      pollTimer: null,
    };
    m3ganStates.set(host, state);
  }
  return state;
}

function notify(state: M3ganControllerState): void {
  state.requestUpdate?.();
}

function bindClient(state: M3ganControllerState, client: GatewayBrowserClient | null): void {
  if (state.client === client) {
    return;
  }
  state.client = client;
  state.generation += 1;
  state.loading = false;
  state.pending = null;
}

export async function loadM3gan(
  state: M3ganControllerState,
  client: GatewayBrowserClient | null,
  opts?: { silent?: boolean },
): Promise<void> {
  if (!client || state.client !== client) {
    return;
  }
  const generation = state.generation;
  if (!opts?.silent) {
    state.loading = true;
    state.error = null;
    notify(state);
  }
  try {
    const next = await client.request<M3ganStatePayload>("m3gan.state", {});
    if (state.generation === generation) {
      state.state = next;
      state.error = null;
    }
  } catch (error) {
    if (state.generation === generation) {
      state.error = formatUiError(error);
    }
  } finally {
    if (state.generation === generation) {
      state.loading = false;
      notify(state);
    }
  }
}

/** Keeps the view current while it is shown; stops when the client goes away. */
export function configureM3ganPolling(
  state: M3ganControllerState,
  client: GatewayBrowserClient | null,
): void {
  if (!client) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    bindClient(state, null);
    return;
  }
  if (state.pollTimer && state.client === client) {
    return;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  bindClient(state, client);
  state.pollTimer = setInterval(
    () => void loadM3gan(state, client, { silent: true }),
    POLL_INTERVAL_MS,
  );
}

export function stopM3ganPolling(host: object): void {
  const state = m3ganStates.get(host);
  if (state?.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/** Runs one owner command, shows a refusal's reason, then refreshes the picture. */
export async function runM3ganCommand(
  state: M3ganControllerState,
  client: GatewayBrowserClient | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  if (!client || state.client !== client || state.pending) {
    return;
  }
  const generation = state.generation;
  state.pending = method;
  state.notice = null;
  notify(state);
  try {
    const result = await client.request<{ ok?: boolean; reason?: string; error?: string }>(
      method,
      params,
    );
    if (state.generation === generation && result && result.ok === false) {
      state.notice = formatUiExternalText(result.reason ?? result.error, method);
    }
  } catch (error) {
    if (state.generation === generation) {
      state.notice = formatUiError(error);
    }
  } finally {
    if (state.generation === generation) {
      state.pending = null;
      notify(state);
      void loadM3gan(state, client, { silent: true });
    }
  }
}
