import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { ChatProps } from "./chat-view.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";

type TalkWindowDropHandlers = {
  onDrop: (event: DragEvent) => void;
  onDragenter: (event: DragEvent) => void;
  onDragleave: (event: DragEvent) => void;
  onDragover: (event: DragEvent) => void;
};

/** Above this length a Talk answer stops being a glanceable line and needs body sizing. */
const TALK_WINDOW_DENSE_ANSWER_CHARS = 180;

function latestRealtimeTalkEntry(
  entries: readonly RealtimeTalkConversationEntry[] | undefined,
  role: RealtimeTalkConversationEntry["role"],
) {
  for (let index = (entries?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = entries?.[index];
    if (entry?.role === role && entry.text.trim()) {
      return entry;
    }
  }
  return null;
}

function talkWindowStatusLabel(
  active: boolean | undefined,
  status: RealtimeTalkStatus | undefined,
) {
  if (!active) {
    return t("chat.composer.talkWindowReady");
  }
  if (status === "thinking") {
    return t("chat.composer.talkWindowThinking");
  }
  if (status === "error") {
    return t("chat.composer.talkConversationError");
  }
  if (status === "connecting") {
    return t("chat.voice.connecting");
  }
  return t("chat.composer.talkWindowListening");
}

function readTalkWindowDarkBackground(): boolean {
  try {
    return globalThis.localStorage?.getItem("openclaw:talk-window:dark-background") === "1";
  } catch {
    return false;
  }
}

export function renderDetachedTalkWindow(
  props: ChatProps,
  attachmentDropHandlers: TalkWindowDropHandlers,
  onSectionChange: (section: HTMLElement | null) => void,
) {
  const talkEntries = props.realtimeTalkConversation ?? [];
  const latestAssistantEntry = latestRealtimeTalkEntry(talkEntries, "assistant");
  const latestUserEntry = latestRealtimeTalkEntry(talkEntries, "user");
  // Headline sizing only reads well for a glanceable sentence. Drafted
  // messages and lists arrive far longer, so they step down a tier.
  const answerIsDense =
    (latestAssistantEntry?.text.trim().length ?? 0) > TALK_WINDOW_DENSE_ANSWER_CHARS;
  const talkStatus = talkWindowStatusLabel(props.realtimeTalkActive, props.realtimeTalkStatus);
  const cameraEnabled = Boolean(props.realtimeTalkVideoStream);
  const screenEnabled = Boolean(props.realtimeTalkScreenStream);
  const cameraDisabled =
    !props.realtimeTalkVideoCapable ||
    props.realtimeTalkVideoPending ||
    props.realtimeTalkStatus === "connecting" ||
    props.realtimeTalkStatus === "error";
  const screenDisabled =
    !props.realtimeTalkScreenCapable ||
    props.realtimeTalkScreenPending ||
    props.realtimeTalkStatus === "connecting" ||
    props.realtimeTalkStatus === "error";
  const cameraFacingMode = props.realtimeTalkVideoStream
    ?.getVideoTracks?.()[0]
    ?.getSettings?.().facingMode;
  const mirrorCameraPreview = cameraFacingMode !== "environment";
  const talkDarkBackground = readTalkWindowDarkBackground();
  const toggleTalkWindowBackground = (event: Event) => {
    const currentTarget = event.currentTarget;
    const section =
      currentTarget instanceof HTMLElement ? currentTarget.closest(".chat--talk-window") : null;
    const enabled = !(
      section instanceof HTMLElement && section.classList.contains("chat--talk-window-dark")
    );
    section?.classList.toggle("chat--talk-window-dark", enabled);
    try {
      globalThis.localStorage?.setItem("openclaw:talk-window:dark-background", enabled ? "1" : "0");
    } catch {
      // Theme preference is cosmetic and must not break Talk controls.
    }
  };
  const closeTalkWindow = () => {
    if (props.realtimeTalkActive) {
      props.onToggleRealtimeTalk?.();
    }
    window.setTimeout(() => window.close(), 0);
  };
  return html`
    <section
      ${ref((element) => {
        onSectionChange(element instanceof HTMLElement ? element : null);
      })}
      class=${`card chat chat--talk-window ${talkDarkBackground ? "chat--talk-window-dark" : ""}`}
      @drop=${attachmentDropHandlers.onDrop}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @dragover=${attachmentDropHandlers.onDragover}
    >
      <div class="agent-chat__talk-window">
        <header class="agent-chat__talk-window-header">
          <div class="agent-chat__talk-window-heading">
            <div class="agent-chat__talk-window-title">${t("chat.composer.talkWindowTitle")}</div>
            <div class="agent-chat__talk-window-subtitle">${props.assistantName}</div>
          </div>
          <div
            class="agent-chat__talk-window-state"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            ${talkStatus}
          </div>
        </header>
        <main class="agent-chat__talk-window-stage">
          <section
            class=${`agent-chat__talk-surface agent-chat__talk-surface--answer${
              answerIsDense ? " is-dense" : ""
            }`}
            aria-label=${t("chat.composer.talkWindowAnswer")}
          >
            <p>
              ${latestAssistantEntry?.text.trim() ||
              (props.realtimeTalkStatus === "thinking"
                ? t("chat.composer.talkWindowThinking")
                : t("chat.composer.talkWindowAnswerPlaceholder"))}
              ${latestAssistantEntry?.isStreaming
                ? html`<span
                    class="agent-chat__voice-turn-stream"
                    aria-label=${t("chat.composer.stillListening")}
                  ></span>`
                : nothing}
            </p>
          </section>
          ${props.realtimeTalkScreenStream
            ? html`
                <div
                  class="agent-chat__talk-vision-preview agent-chat__talk-vision-preview--screen"
                >
                  <video
                    autoplay
                    .muted=${true}
                    playsinline
                    aria-label=${t("chat.composer.screenSharePreview")}
                    ${ref((element) => {
                      if (element instanceof HTMLVideoElement) {
                        element.srcObject = props.realtimeTalkScreenStream ?? null;
                      }
                    })}
                  ></video>
                  <span>${t("chat.composer.screenSharing")}</span>
                </div>
              `
            : nothing}
          ${props.realtimeTalkVideoStream
            ? html`
                <div
                  class="agent-chat__talk-vision-preview agent-chat__talk-vision-preview--camera"
                >
                  <video
                    class=${mirrorCameraPreview ? "agent-chat__video-preview-mirrored" : nothing}
                    autoplay
                    .muted=${true}
                    playsinline
                    aria-label=${t("chat.composer.cameraPreview")}
                    ${ref((element) => {
                      if (element instanceof HTMLVideoElement) {
                        element.srcObject = props.realtimeTalkVideoStream ?? null;
                      }
                    })}
                  ></video>
                  ${props.realtimeTalkCameraDevices &&
                  props.realtimeTalkCameraDevices.length >= 2 &&
                  props.onSwitchRealtimeCamera
                    ? html`
                        <button
                          type="button"
                          class="agent-chat__talk-camera-switch"
                          aria-label=${t("chat.composer.switchCamera")}
                          ?disabled=${props.realtimeTalkVideoPending}
                          @click=${props.onSwitchRealtimeCamera}
                        >
                          ${icons.switchCamera}
                        </button>
                      `
                    : nothing}
                </div>
              `
            : nothing}
          <section
            class="agent-chat__talk-surface agent-chat__talk-surface--question"
            aria-label=${t("chat.composer.talkWindowQuestion")}
          >
            <p>
              ${latestUserEntry?.text.trim() || t("chat.composer.talkWindowQuestionPlaceholder")}
              ${latestUserEntry?.isStreaming
                ? html`<span
                    class="agent-chat__voice-turn-stream"
                    aria-label=${t("chat.composer.stillListening")}
                  ></span>`
                : nothing}
            </p>
          </section>
        </main>
        <footer class="agent-chat__talk-window-footer">
          <div
            class="agent-chat__talk-dock"
            role="toolbar"
            aria-label=${t("chat.composer.talkWindowControls")}
          >
            <div class="agent-chat__talk-action-group">
              <button
                type="button"
                class="agent-chat__talk-action"
                aria-label=${screenEnabled
                  ? t("chat.composer.stopSharingScreen")
                  : t("chat.composer.talkWindowShareScreen")}
                aria-pressed=${screenEnabled ? "true" : "false"}
                title=${screenDisabled && !props.realtimeTalkScreenCapable
                  ? t("chat.composer.talkWindowShareScreenUnavailable")
                  : nothing}
                ?disabled=${screenDisabled}
                @click=${props.onToggleRealtimeScreenShare}
              >
                ${icons.monitor}
              </button>
              <button
                type="button"
                class="agent-chat__talk-action"
                aria-label=${cameraEnabled
                  ? t("chat.composer.turnCameraOff")
                  : t("chat.composer.turnCameraOn")}
                aria-pressed=${cameraEnabled ? "true" : "false"}
                title=${cameraDisabled && !props.realtimeTalkVideoCapable
                  ? t("chat.composer.talkWindowCameraUnavailable")
                  : nothing}
                ?disabled=${cameraDisabled}
                @click=${props.onToggleRealtimeCamera}
              >
                ${cameraEnabled ? icons.cameraOff : icons.camera}
              </button>
              <button
                type="button"
                class="agent-chat__talk-action"
                aria-label=${t("chat.composer.toggleTalkBackground")}
                @click=${toggleTalkWindowBackground}
              >
                ${icons.moon}
              </button>
            </div>
            <div class="agent-chat__talk-input-pill" aria-live="polite">
              ${latestUserEntry?.text.trim() || t("chat.composer.talkWindowQuestionPlaceholder")}
            </div>
            <div class="agent-chat__talk-action-group agent-chat__talk-action-group--end">
              <button
                type="button"
                class="agent-chat__talk-action agent-chat__talk-action--danger"
                aria-label=${props.realtimeTalkActive
                  ? t("chat.composer.stopVoiceInput")
                  : t("chat.composer.startVoiceInput")}
                aria-pressed=${props.realtimeTalkActive ? "true" : "false"}
                @click=${props.onToggleRealtimeTalk}
              >
                ${props.realtimeTalkActive ? icons.micOff : icons.mic}
              </button>
              <button
                type="button"
                class="agent-chat__talk-action agent-chat__talk-action--close"
                aria-label=${t("chat.composer.talkWindowClose")}
                @click=${closeTalkWindow}
              >
                ${icons.x}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </section>
  `;
}
