/**
 * Source of the observer injected into the ChatGPT tab.
 *
 * It pushes settled assistant replies out through a CDP binding instead of
 * being polled, and records when the operator last authored a turn so the
 * policy can refuse orders that nobody asked for.
 */

export const BRIDGE_BINDING_NAME = "__openclawBridge";

export type ObservedTurn = {
  type: "assistant";
  messageId: string;
  text: string;
  observedAt: number;
  lastUserTurnAt: number | null;
};

/** Builds the injected script. `settleMs` is how long a reply must stop changing. */
export function buildObserverSource(settleMs: number): string {
  return `(() => {
  if (window.__openclawBridgeInstalled) { return "already-installed"; }
  window.__openclawBridgeInstalled = true;
  var TURN = '[data-message-author-role]';
  var SETTLE_MS = ${Math.max(200, Math.trunc(settleMs))};
  var lastUserTurnAt = null;
  var timers = new Map();

  function emit(payload) {
    try { ${BRIDGE_BINDING_NAME}(JSON.stringify(payload)); } catch (e) { /* binding gone */ }
  }

  function scheduleAssistant(el) {
    var id = el.getAttribute('data-message-id');
    if (!id) { return; }
    if (timers.has(id)) { clearTimeout(timers.get(id)); }
    timers.set(id, setTimeout(function () {
      timers.delete(id);
      emit({
        type: 'assistant',
        messageId: id,
        text: el.innerText || '',
        observedAt: Date.now(),
        lastUserTurnAt: lastUserTurnAt
      });
    }, SETTLE_MS));
  }

  function consider(el) {
    if (!el || el.nodeType !== 1) { return; }
    var role = el.getAttribute('data-message-author-role');
    if (role === 'user') { lastUserTurnAt = Date.now(); return; }
    if (role === 'assistant') { scheduleAssistant(el); }
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) { return; }
    if (node.matches && node.matches(TURN)) { consider(node); }
    if (!node.querySelectorAll) { return; }
    var found = node.querySelectorAll(TURN);
    for (var i = 0; i < found.length; i++) { consider(found[i]); }
  }

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      for (var j = 0; j < record.addedNodes.length; j++) { scan(record.addedNodes[j]); }
      var target = record.target;
      var el = target && target.nodeType === 1 ? target : target && target.parentElement;
      if (el && el.closest) {
        var host = el.closest(TURN);
        if (host && host.getAttribute('data-message-author-role') === 'assistant') {
          scheduleAssistant(host);
        }
      }
    }
  });

  function start() {
    if (!document.body) { setTimeout(start, 250); return; }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  start();

  window.__openclawBridgeStop = function () {
    observer.disconnect();
    timers.forEach(function (handle) { clearTimeout(handle); });
    timers.clear();
    window.__openclawBridgeInstalled = false;
  };
  return "installed";
})()`;
}

/** Parses a binding payload, returning undefined for anything unexpected. */
export function parseObservedTurn(payload: unknown): ObservedTurn | undefined {
  if (typeof payload !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "assistant") {
    return undefined;
  }
  const messageId = typeof record.messageId === "string" ? record.messageId : "";
  const text = typeof record.text === "string" ? record.text : "";
  const observedAt = typeof record.observedAt === "number" ? record.observedAt : Number.NaN;
  if (!messageId || !text || !Number.isFinite(observedAt)) {
    return undefined;
  }
  const lastUserTurnAt =
    typeof record.lastUserTurnAt === "number" && Number.isFinite(record.lastUserTurnAt)
      ? record.lastUserTurnAt
      : null;
  return { type: "assistant", messageId, text, observedAt, lastUserTurnAt };
}
