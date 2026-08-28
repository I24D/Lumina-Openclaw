import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { styleMap } from "lit/directives/style-map.js";
import type {
  SessionPlacementDiskSpace,
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../packages/gateway-protocol/src/index.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequest,
} from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../../app/exec-approval.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import type { ChatSendShortcut } from "../../app/settings.ts";
import { renderExecApprovalCard } from "../../components/exec-approval-card.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import type { BoardProvider } from "../../lib/board/provider.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { resolveAsciiShortcutKey } from "../../lib/keyboard-shortcuts.ts";
import type { ProviderUsageDisplayProps } from "../../lib/provider-quota-summary.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import type { UiSessionDefaultsHost } from "../../lib/sessions/session-key.ts";
import type { ChatRunStartupStatus } from "./chat-run-startup.ts";
import { type ChatCloudStartupNoticeProps, renderChatViewNotices } from "./chat-view-notices.ts";
import { createChatAttachmentDropHandlers } from "./components/chat-attachments.ts";
import type { BackgroundTasksProps } from "./components/chat-background-tasks.types.ts";
import type {
  CapabilityMenuProps,
  ChatComposerDisabledBanner,
  ChatComposerProps,
  ChatQueuedEditProps,
} from "./components/chat-composer-types.ts";
import { isChatRunWorking, renderChatComposer } from "./components/chat-composer.ts";
import { isImageLightboxEvent, openInlineChatImage } from "./components/chat-image-lightbox.ts";
import type { ArtifactDownloadResolver } from "./components/chat-message-media.ts";
import { renderChatPullRequests } from "./components/chat-pull-requests.ts";
import { renderChatSessionSuggestions } from "./components/chat-session-suggestions.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./components/chat-sidebar.ts";
import { renderChatSwarmProgress } from "./components/chat-swarm-progress.ts";
import { renderChatTaskSuggestionTray } from "./components/chat-task-suggestions.ts";
import type { ChatTaskSuggestionTrayProps } from "./components/chat-task-suggestions.ts";
import type { ReplyMessageAccess } from "./components/chat-thread-interactions.ts";
import {
  renderTranscriptSearch,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkCameraDevice } from "./realtime-talk-input.ts";
import type { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus, PlanStatus } from "./tool-stream.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";
import "../../components/resizable-divider.ts";

/** Above this length a Talk answer stops being a glanceable line and needs body sizing. */
const TALK_WINDOW_DENSE_ANSWER_CHARS = 180;
type ChatReplyTarget = {
  messageId: string;
  text: string;
  senderLabel?: string | null;
  sourceMessageId?: string | null;
};

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
export type ChatProps = ChatTaskSuggestionTrayProps &
  ChatCloudStartupNoticeProps & {
    transcript: ChatTranscriptController;
    paneId: string;
    sessionKey: string;
    announceTranscript?: boolean;
    onSessionKeyChange: (next: string) => void;
    thinkingLevel: string | null;
    showThinking: boolean;
    showToolCalls: boolean;
    persistCommentary?: boolean;
    loading: boolean;
    sending: boolean;
    canAbort?: boolean;
    runStatus?: ChatRunUiStatus | null;
    startupStatus?: ChatRunStartupStatus | null;
    waitingApproval?: boolean;
    compactionStatus?: CompactionStatus | null;
    fallbackStatus?: FallbackStatus | null;
    planStatus?: PlanStatus | null;
    gatewayQuestionPrompts?: readonly QuestionPrompt[];
    onGatewayQuestionChange?: () => void;
    onGatewayQuestionSubmit?: (
      id: string,
      answers: Record<string, string[]>,
    ) => void | Promise<void>;
    onGatewayQuestionSkip?: (id: string) => void | Promise<void>;
    messages: unknown[];
    historyPagination?: {
      hasMore: boolean;
      loading: boolean;
      onShowEarlier: () => void;
    };
    toolMessages: unknown[];
    streamSegments: ChatStreamSegment[];
    stream: string | null;
    streamStartedAt: number | null;
    /** Browser-local active run identity, retained across transient disconnects. */
    runId?: string | null;
    runOutputTokens?: number | null;
    assistantAvatarUrl?: string | null;
    draft: string;
    queue: ChatQueueItem[];
    queuedOutboxCount?: number;
    realtimeTalkActive?: boolean;
    realtimeTalkStatus?: RealtimeTalkStatus;
    realtimeTalkDetail?: string | null;
    realtimeTalkInputLevel?: RealtimeTalkLevelSignal;
    realtimeTalkConversation?: RealtimeTalkConversationEntry[];
    realtimeTalkVideoStream?: MediaStream | null;
    realtimeTalkCameraDevices?: RealtimeTalkCameraDevice[];
    realtimeTalkVideoCapable?: boolean;
    realtimeTalkVideoPending?: boolean;
    realtimeTalkCameraError?: boolean;
    realtimeTalkScreenStream?: MediaStream | null;
    realtimeTalkScreenCapable?: boolean;
    realtimeTalkScreenPending?: boolean;
    realtimeTalkScreenError?: boolean;
    connected: boolean;
    offline?: boolean;
    gatewayClient?: GatewayBrowserClient | null;
    composerHoldToRecord?: boolean;
    suggestionComposer?: boolean;
    typingActors?: readonly { id: string; label: string }[];
    onTypingChange?: (typing: boolean) => void;
    canSend: boolean;
    disabledReason: string | null;
    disabledBanner?: ChatComposerDisabledBanner;
    modelSetupRequired?: boolean;
    onModelSetup?: () => void;
    error: string | null;
    diskSpace?: SessionPlacementDiskSpace;
    runError?: { summary: string } | null;
    inlineApproval?: ExecApprovalRequest | null;
    approvalBusy?: boolean;
    approvalErrors?: ReadonlyMap<string, string>;
    approvalNowMs?: number;
    onApprovalDecision?: (
      approvalId: string,
      decision: ExecApprovalDecision,
    ) => void | Promise<void>;
    workspaceConflict?: WorkspaceResultConflict;
    onDismissWorkspaceConflict?: () => void;
    sessions: SessionsListResult | null;
    toolOverrides?: SessionToolOverrides;
    capabilityMenu?: CapabilityMenuProps;
    swarmSessions?: readonly GatewaySessionRow[];
    /** Host context resolving global-alias session keys (scope=global fleets). */
    sessionHost?: UiSessionDefaultsHost | null;
    providerUsage?: ProviderUsageDisplayProps;
    focusMode?: boolean;
    canvasPluginSurfaceUrl?: string | null;
    boardProvider?: BoardProvider;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
    chatMessageMaxWidth?: string | null;
    assistantName: string;
    sendShortcut?: ChatSendShortcut;
    followUpMode?: ControlUiFollowUpMode;
    assistantAvatar: string | null;
    userId?: string | null;
    userName?: string | null;
    userAvatar?: string | null;
    localMediaPreviewRoots?: string[];
    assistantAttachmentAuthToken?: string | null;
    resolveArtifactDownload?: ArtifactDownloadResolver;
    autoExpandToolCalls?: boolean;
    attachmentLimits?: { maxBytes: number; maxImageBytes: number };
    attachments?: ChatAttachment[];
    getAttachments?: () => ChatAttachment[];
    pendingAttachmentReads?: number;
    getPendingAttachmentReads?: () => number;
    readSignal?: AbortSignal;
    onPendingReadsChange?: (delta: 1 | -1) => void;
    onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
    onRemoveAttachment?: (attachment: ChatAttachment) => void;
    onAssistantAttachmentLoaded?: () => void;
    onRequestOpenImage?: () => number;
    onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
    showNewMessages?: boolean;
    onScrollToBottom?: (options?: { smooth?: boolean }) => void;
    onRefresh: () => void;
    onToggleFocusMode?: () => void;
    getDraft?: () => string;
    onDraftChange: (next: string) => void;
    onRequestUpdate?: () => void;
    onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
    onSlashIntent?: () => void | Promise<void>;
    onSend: ChatComposerProps["onSend"];
    onCompact?: () => void | Promise<void>;
    onOpenSessionCheckpoints?: () => void | Promise<void>;
    onToggleRealtimeTalk?: () => void;
    onToggleRealtimeCamera?: () => void;
    onToggleRealtimeScreenShare?: () => void;
    onSwitchRealtimeCamera?: () => void;
    onDismissError?: () => void;
    onDismissRealtimeTalkError?: () => void;
    onDictationError?: (message: string) => void;
    onAbort?: () => void;
    onQueueRemove: (id: string) => void;
    onQueueRetry?: (id: string) => void;
    onQueueSteer?: (id: string) => void;
    onQueueMove?: (id: string, toIndex: number) => void;
    queuedEdit?: ChatQueuedEditProps;
    onGoalCommand?: (command: string) => void;
    onHistoryIntent?: (event: Event) => void;
    onCompanionQuestion?: (question: string) => void;
    onCompanionPrefill?: (question: string) => void;
    onClearHistory?: () => void;
    agentsList: {
      agents: Array<{
        id: string;
        name?: string;
        identity?: { name?: string; avatarUrl?: string };
      }>;
      defaultId?: string;
    } | null;
    currentAgentId: string;
    fullMessageAgentId?: string;
    loadFullAssistantMessage?: SidebarFullMessageLoader | null;
    onAgentChange: (agentId: string) => void;
    onNavigateToAgent?: () => void;
    onSessionSelect?: (sessionKey: string) => void;
    onOpenSidebar?: (content: SidebarContent) => void;
    onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
    onRevealWorkspaceFile?: (path: string) => void;
    onChatScroll?: (event: Event) => void;
    basePath?: string;
    composerControls?: TemplateResult | typeof nothing;
    replyTarget?: ChatReplyTarget | null;
    onClearReply?: () => void;
    onSetReply?: (target: ChatReplyTarget) => void;
    replyMessageAccess?: ReplyMessageAccess;
    onRewindMessage?: (entryId: string) => Promise<boolean> | boolean;
    onForkMessage?: (entryId: string) => Promise<void> | void;
    backgroundTasks?: BackgroundTasksProps;
    header?: TemplateResult | typeof nothing;
    talkWindow?: boolean;
    sessionSuggestions?: readonly SessionSuggestion[];
    sessionSuggestionRole?: SessionSharingRole;
    sessionSuggestionBusyIds?: ReadonlySet<string>;
    sessionSuggestionsArchived?: boolean;
    canResolveSessionSuggestions?: boolean;
    onResolveSessionSuggestion?: (
      suggestion: SessionSuggestion,
      resolution: SessionSuggestionResolution,
    ) => void;
    pullRequests?: ControlUiSessionPullRequest[];
    pullRequestsBranch?: ControlUiSessionBranch;
    pullRequestsRateLimited?: boolean;
    pullRequestsExpanded?: boolean;
    onOpenSessionDiff?: () => void;
    onExpandPullRequests?: () => void;
    onDismissPullRequest?: (pullRequest: ControlUiSessionPullRequest) => void;
  };

export function renderChat(props: ChatProps) {
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const canCompose = props.canSend;
  const showModelSetupSplash =
    props.modelSetupRequired === true &&
    props.messages.length === 0 &&
    props.toolMessages.length === 0 &&
    props.streamSegments.length === 0 &&
    !props.stream &&
    props.queue.length === 0;
  const openImage = props.onOpenImage
    ? (item: ImageLightboxItem, requestVersion?: number) =>
        requestVersion === undefined
          ? props.onOpenImage?.(item)
          : props.onOpenImage?.(item, requestVersion)
    : undefined;
  const openImmediateImage = props.onOpenImage
    ? (item: ImageLightboxItem) => openImage?.(item, props.onRequestOpenImage?.())
    : undefined;
  const attachmentDropHandlers = createChatAttachmentDropHandlers({ ...props, canCompose });
  let chatSection: HTMLElement | null = null;
  const thread = renderChatThread(
    {
      paneId: props.paneId,
      sessionKey: props.sessionKey,
      announceTranscript: props.announceTranscript,
      loading: props.loading,
      historyLoading: props.historyPagination?.loading,
      messages: props.messages,
      toolMessages: props.toolMessages,
      streamSegments: props.streamSegments,
      stream: props.stream,
      streamStartedAt: props.streamStartedAt,
      runId: props.runId,
      runOutputTokens: props.runOutputTokens,
      queue: props.queue,
      showThinking: props.showThinking,
      showToolCalls: props.showToolCalls,
      persistCommentary: props.persistCommentary,
      runActive: Boolean(props.canAbort),
      runWorking: isChatRunWorking(props),
      startupStatus: props.startupStatus,
      waitingApproval: props.waitingApproval,
      planStatus: props.planStatus,
      questionPrompts: props.gatewayQuestionPrompts,
      sessions: props.sessions,
      sessionHost: props.sessionHost,
      boardProvider: props.boardProvider,
      assistantName: props.assistantName,
      assistantAvatar: props.assistantAvatar,
      assistantAvatarUrl: props.assistantAvatarUrl,
      userId: props.userId,
      userName: props.userName,
      userAvatar: props.userAvatar,
      basePath: props.basePath,
      fullMessageAgentId: props.fullMessageAgentId,
      loadFullAssistantMessage: props.loadFullAssistantMessage,
      localMediaPreviewRoots: props.localMediaPreviewRoots,
      assistantAttachmentAuthToken: props.assistantAttachmentAuthToken,
      resolveArtifactDownload: props.resolveArtifactDownload,
      canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
      embedSandboxMode: props.embedSandboxMode,
      allowExternalEmbedUrls: props.allowExternalEmbedUrls,
      autoExpandToolCalls: props.autoExpandToolCalls,
      realtimeTalkConversation: props.realtimeTalkConversation,
      onOpenSidebar: props.onOpenSidebar,
      onOpenWorkspaceFile: props.onOpenWorkspaceFile,
      onOpenSessionCheckpoints: props.onOpenSessionCheckpoints,
      onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
      onRequestOpenImage: props.onRequestOpenImage,
      onOpenImage: openImage,
      onRequestUpdate: requestUpdate,
      onChatScroll: props.onChatScroll,
      onHistoryIntent: props.onHistoryIntent,
      onDraftChange: props.onDraftChange,
      onSend: props.onSend,
      onSetReply: props.onSetReply,
      replyMessageAccess: props.replyMessageAccess,
      onRewindMessage: props.onRewindMessage,
      onForkMessage: props.onForkMessage,
      onCompanionQuestion:
        props.canSend && !props.suggestionComposer ? props.onCompanionQuestion : undefined,
      onCompanionPrefill:
        props.canSend && !props.suggestionComposer ? props.onCompanionPrefill : undefined,
      onOpenSession: props.onSessionSelect,
      modelSetupRequired: props.modelSetupRequired,
      onModelSetup: props.onModelSetup,
      backgroundTasks: props.backgroundTasks,
      onFocusComposer: () =>
        chatSection
          ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
          ?.focus({ preventScroll: true }),
    },
    props.transcript,
  );
  const chatColumnFooter = renderChatComposer({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    currentAgentId: props.currentAgentId,
    connected: props.connected,
    offline: props.offline,
    queuedOutboxCount: props.queuedOutboxCount,
    canSend: props.canSend,
    disabledReason: props.disabledReason,
    disabledBanner: props.disabledBanner,
    runError: props.runError,
    sending: props.sending,
    canAbort: props.canAbort,
    runStatus: props.runStatus,
    waitingApproval: props.waitingApproval,
    compactionStatus: props.compactionStatus,
    fallbackStatus: props.fallbackStatus,
    planStatus: props.planStatus,
    gatewayQuestionPrompts: props.gatewayQuestionPrompts,
    messages: props.messages,
    stream: props.stream,
    queue: props.queue,
    draft: props.draft,
    sessions: props.sessions,
    toolOverrides: props.toolOverrides,
    capabilityMenu: props.capabilityMenu,
    providerUsage: props.providerUsage,
    assistantName: props.assistantName,
    sendShortcut: props.sendShortcut,
    followUpMode: props.followUpMode,
    attachmentLimits: props.attachmentLimits,
    attachments: props.attachments,
    getAttachments: props.getAttachments,
    pendingAttachmentReads: props.pendingAttachmentReads,
    getPendingAttachmentReads: props.getPendingAttachmentReads,
    readSignal: props.readSignal,
    onPendingReadsChange: props.onPendingReadsChange,
    replyTarget: props.replyTarget,
    realtimeTalkActive: props.realtimeTalkActive,
    realtimeTalkStatus: props.realtimeTalkStatus,
    realtimeTalkDetail: props.realtimeTalkDetail,
    realtimeTalkInputLevel: props.realtimeTalkInputLevel,
    realtimeTalkConversation: props.realtimeTalkConversation,
    realtimeTalkVideoStream: props.realtimeTalkVideoStream,
    realtimeTalkCameraDevices: props.realtimeTalkCameraDevices,
    realtimeTalkVideoCapable: props.realtimeTalkVideoCapable,
    realtimeTalkVideoPending: props.realtimeTalkVideoPending,
    realtimeTalkCameraError: props.realtimeTalkCameraError,
    gatewayClient: props.gatewayClient,
    composerHoldToRecord: props.composerHoldToRecord,
    suggestionComposer: props.suggestionComposer,
    typingActors: props.typingActors,
    onTypingChange: props.onTypingChange,
    composerControls: props.composerControls,
    getDraft: props.getDraft,
    onDraftChange: props.onDraftChange,
    onRequestUpdate: requestUpdate,
    onHistoryKeydown: props.onHistoryKeydown,
    onSlashIntent: props.onSlashIntent,
    onSend: props.onSend,
    onCompact: props.suggestionComposer ? undefined : props.onCompact,
    onToggleRealtimeTalk: props.suggestionComposer ? undefined : props.onToggleRealtimeTalk,
    onToggleRealtimeCamera: props.onToggleRealtimeCamera,
    onSwitchRealtimeCamera: props.onSwitchRealtimeCamera,
    onDismissRealtimeTalkError: props.onDismissRealtimeTalkError,
    onDictationError: props.onDictationError,
    onAbort: props.onAbort,
    onQueueRemove: props.onQueueRemove,
    onQueueRetry: props.onQueueRetry,
    onQueueSteer: props.onQueueSteer,
    onQueueMove: props.onQueueMove,
    queuedEdit: props.queuedEdit,
    onGoalCommand: props.onGoalCommand,
    onGatewayQuestionChange: props.onGatewayQuestionChange,
    onGatewayQuestionSubmit: props.onGatewayQuestionSubmit,
    onGatewayQuestionSkip: props.onGatewayQuestionSkip,
    onClearReply: props.onClearReply,
    onAttachmentsChange: props.onAttachmentsChange,
    onRemoveAttachment: props.onRemoveAttachment,
    onOpenImage: openImmediateImage,
  });
  const scrollToBottomButton =
    props.showNewMessages && props.onScrollToBottom
      ? html`
          <div class="chat-scroll-to-bottom-wrap">
            <button
              class="chat-scroll-to-bottom"
              type="button"
              @click=${() => props.onScrollToBottom?.({ smooth: true })}
              aria-label=${t("chat.actions.scrollToLatest")}
            >
              ${icons.arrowDown}
            </button>
          </div>
        `
      : nothing;
  const earlierHistoryButton = props.historyPagination?.hasMore
    ? html`
        <button
          class="btn btn--sm chat-history-available"
          type="button"
          aria-busy=${props.historyPagination.loading ? "true" : "false"}
          aria-label=${t("chat.thread.showEarlier")}
          @click=${props.historyPagination.onShowEarlier}
        >
          ${props.historyPagination.loading
            ? html`<span class="session-run-spinner" aria-hidden="true"></span>`
            : nothing}
          <span role="status">
            ${props.historyPagination.loading
              ? t("chat.thread.loadingEarlier")
              : t("chat.thread.earlierHistoryAvailable")}
          </span>
          <strong>${t("chat.thread.showEarlier")}</strong>
        </button>
      `
    : nothing;
  if (props.talkWindow) {
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
    let talkDarkBackground = false;
    try {
      talkDarkBackground =
        globalThis.localStorage?.getItem("openclaw:talk-window:dark-background") === "1";
    } catch {
      talkDarkBackground = false;
    }
    const toggleTalkWindowBackground = (event: Event) => {
      const section = (event.currentTarget as HTMLElement | null)?.closest(".chat--talk-window");
      const enabled = !(
        section instanceof HTMLElement && section.classList.contains("chat--talk-window-dark")
      );
      section?.classList.toggle("chat--talk-window-dark", enabled);
      try {
        globalThis.localStorage?.setItem(
          "openclaw:talk-window:dark-background",
          enabled ? "1" : "0",
        );
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
          chatSection = element instanceof HTMLElement ? element : null;
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

  return html`
    <section
      ${ref((element) => {
        chatSection = element instanceof HTMLElement ? element : null;
      })}
      class="card chat"
      style=${styleMap(
        props.chatMessageMaxWidth
          ? {
              "--chat-thread-max-width": props.chatMessageMaxWidth,
              "--chat-message-max-width": "100%",
            }
          : {},
      )}
      @drop=${attachmentDropHandlers.onDrop}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @click=${(event: Event) => openInlineChatImage(event, openImmediateImage)}
      @dragover=${attachmentDropHandlers.onDragover}
      @keydown=${(event: KeyboardEvent) => {
        if (isImageLightboxEvent(event)) {
          return;
        }
        if (
          (event.key === "Enter" || event.key === " ") &&
          openInlineChatImage(event, openImmediateImage)
        ) {
          return;
        }
        if (event.key === "Escape" && props.replyTarget && !event.defaultPrevented) {
          event.preventDefault();
          props.onClearReply?.();
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          resolveAsciiShortcutKey(event) === "f"
        ) {
          event.preventDefault();
          toggleTranscriptSearch(props.paneId, requestUpdate, event);
        }
      }}
    >
      <div class="chat-workbench">
        <div class="chat-workbench__main">
          <div class="chat-split-container">
            <div class="chat-main">
              <div class="chat-main__conversation-column">
                ${props.header ?? nothing} ${renderChatViewNotices(props)}
                ${renderTranscriptSearch(props.paneId, requestUpdate)}
                <div class="chat-main__conversation">
                  ${thread} ${earlierHistoryButton} ${scrollToBottomButton}
                  ${props.inlineApproval && props.onApprovalDecision
                    ? html`<div class="chat-inline-approval">
                        ${renderExecApprovalCard({
                          approval: props.inlineApproval,
                          busy: props.approvalBusy === true,
                          error: props.approvalErrors?.get(props.inlineApproval.id) ?? null,
                          nowMs: props.approvalNowMs ?? Date.now(),
                          variant: "inline",
                          onDecision: props.onApprovalDecision,
                        })}
                      </div>`
                    : nothing}
                  ${renderChatTaskSuggestionTray(props)}
                  ${renderChatPullRequests({
                    pullRequests: props.pullRequests ?? [],
                    branch: props.pullRequestsBranch,
                    rateLimited: props.pullRequestsRateLimited === true,
                    expanded: props.pullRequestsExpanded === true,
                    onExpand: () => props.onExpandPullRequests?.(),
                    onDismiss: (pullRequest) => props.onDismissPullRequest?.(pullRequest),
                    onOpenSessionDiff: props.onOpenSessionDiff,
                  })}
                  ${renderChatSessionSuggestions({
                    suggestions: props.sessionSuggestions ?? [],
                    role: props.sessionSuggestionRole,
                    busyIds: props.sessionSuggestionBusyIds ?? new Set(),
                    archived: props.sessionSuggestionsArchived === true,
                    canResolve: props.canResolveSessionSuggestions === true,
                    onResolve: (suggestion, resolution) =>
                      props.onResolveSessionSuggestion?.(suggestion, resolution),
                  })}
                  ${renderChatSwarmProgress({
                    sessions: props.swarmSessions ?? [],
                    sessionKey: props.sessionKey,
                  })}
                  ${showModelSetupSplash ? nothing : chatColumnFooter}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
