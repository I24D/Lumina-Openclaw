import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { CoreStatePayload, LuminaCoreUiState } from "./lumina-core-types.ts";

const POLL_INTERVAL_MS = 5_000;

type LuminaCoreControllerState = LuminaCoreUiState & {
  // Rebinding to another gateway client retires every pending result, so an
  // old connection never writes into the replacement view.
  client: GatewayBrowserClient | null;
  generation: number;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
};

const coreStates = new WeakMap<object, LuminaCoreControllerState>();

export function getCoreState(host: object): LuminaCoreControllerState {
  let state = coreStates.get(host);
  if (!state) {
    state = {
      tab: "live",
      state: null,
      loading: false,
      error: null,
      pending: null,
      notice: null,
      memoryQuery: "",
      requestUpdate: null,
      client: null,
      generation: 0,
      pollTimer: null,
    };
    coreStates.set(host, state);
  }
  return state;
}

function notify(state: LuminaCoreControllerState): void {
  state.requestUpdate?.();
}

function bindClient(state: LuminaCoreControllerState, client: GatewayBrowserClient | null): void {
  if (state.client === client) {
    return;
  }
  state.client = client;
  state.generation += 1;
  state.loading = false;
  state.pending = null;
}

export async function loadLuminaCore(
  state: LuminaCoreControllerState,
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
    const next = await client.request<CoreStatePayload>("lumina.core.state", {});
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
export function configureLuminaCorePolling(
  state: LuminaCoreControllerState,
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
    () => void loadLuminaCore(state, client, { silent: true }),
    POLL_INTERVAL_MS,
  );
}

export function stopLuminaCorePolling(host: object): void {
  const state = coreStates.get(host);
  if (state?.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/** Runs one owner command, shows a refusal's reason, then refreshes the picture. */
export async function runLuminaCoreCommand(
  state: LuminaCoreControllerState,
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
      void loadLuminaCore(state, client, { silent: true });
    }
  }
}
