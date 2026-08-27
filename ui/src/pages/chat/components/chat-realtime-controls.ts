import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "../realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "../realtime-talk.ts";

type ChatRealtimeTalkConversationProps = {
  assistantName: string;
  userName?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
};

function realtimeTalkStatusLabel(
  active: boolean | undefined,
  status: RealtimeTalkStatus | undefined,
) {
  if (!active) {
    return t("chat.composer.talkConversationSaved");
  }
  if (status === "connecting") {
    return t("chat.voice.connecting");
  }
  if (status === "thinking") {
    return t("chat.voice.asking");
  }
  if (status === "error") {
    return t("chat.composer.talkConversationError");
  }
  return t("chat.voice.listening");
}

export function renderRealtimeTalkConversation(props: ChatRealtimeTalkConversationProps) {
  const entries = props.realtimeTalkConversation ?? [];
  if (entries.length === 0 && !props.realtimeTalkActive) {
    return nothing;
  }
  return html`
    <section class="agent-chat__voice-panel" aria-label=${t("chat.composer.talkConversation")}>
      <header class="agent-chat__voice-panel-header">
        <div class="agent-chat__voice-panel-title">${t("chat.composer.talkConversation")}</div>
        <div class="agent-chat__voice-panel-status">
          ${realtimeTalkStatusLabel(props.realtimeTalkActive, props.realtimeTalkStatus)}
        </div>
      </header>
      <div
        class="agent-chat__voice-turns"
        role="log"
        aria-label=${t("chat.composer.voiceTranscript")}
      >
        ${entries.length === 0
          ? html`
              <div class="agent-chat__voice-empty" role="status">
                ${realtimeTalkStatusLabel(props.realtimeTalkActive, props.realtimeTalkStatus)}
              </div>
            `
          : repeat(
              entries,
              (entry) => entry.id,
              (entry) => {
                const label =
                  entry.role === "user" ? props.userName?.trim() || "You" : props.assistantName;
                return html`
                  <div
                    class="agent-chat__voice-turn agent-chat__voice-turn--${entry.role}"
                    data-role=${entry.role}
                  >
                    <span class="agent-chat__voice-turn-speaker">${label}</span>
                    <span class="agent-chat__voice-turn-text">${entry.text}</span>
                    ${entry.isStreaming
                      ? html`<span
                          class="agent-chat__voice-turn-stream"
                          aria-label=${t("chat.composer.stillListening")}
                        ></span>`
                      : nothing}
                  </div>
                `;
              },
            )}
      </div>
    </section>
  `;
}
