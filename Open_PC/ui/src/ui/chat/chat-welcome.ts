import { html } from "lit";
import { t } from "../../i18n/index.ts";
import {
  agentLogoUrl,
  assistantAvatarFallbackUrl,
  resolveChatAvatarRenderUrl,
  resolveAssistantTextAvatar,
} from "../views/agents-utils.ts";

export type ChatWelcomeProps = {
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  basePath?: string;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

const WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.summarizeRecentSessions",
  "chat.welcome.suggestions.configureChannel",
  "chat.welcome.suggestions.checkSystemHealth",
];

function resolveAssistantAvatarUrl(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
}

export function resolveAssistantDisplayAvatar(
  props: Pick<ChatWelcomeProps, "assistantAvatar" | "assistantAvatarUrl">,
): string | null {
  return resolveAssistantAvatarUrl(props) ?? resolveAssistantTextAvatar(props.assistantAvatar);
}

export function renderWelcomeState(props: ChatWelcomeProps) {
  const name = props.assistantName || "Assistant";
  const avatar = resolveAssistantAvatarUrl(props);
  const avatarText = avatar ? null : resolveAssistantTextAvatar(props.assistantAvatar);
  const fallbackAvatarUrl = assistantAvatarFallbackUrl(props.basePath ?? "");
  const logoUrl = agentLogoUrl(props.basePath ?? "");

  return html`
    <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
      <div class="agent-chat__welcome-glow"></div>
      ${avatar
        ? html`<img
            src=${avatar}
            alt=${name}
            style="width:56px; height:56px; border-radius:50%; object-fit:cover;"
          />`
        : avatarText
          ? html`<div class="agent-chat__avatar agent-chat__avatar--text" aria-label=${name}>
              ${avatarText}
            </div>`
          : html`<div class="agent-chat__avatar agent-chat__avatar--logo">
              <img src=${fallbackAvatarUrl} alt=${name} />
            </div>`}
      <h2>${name}</h2>
      <div class="agent-chat__badges">
        <span class="agent-chat__badge"
          ><img src=${logoUrl} alt="" /> ${t("chat.welcome.ready")}</span
        >
      </div>
      <p class="agent-chat__hint">
        ${t("chat.welcome.hintBeforeShortcut")} <kbd>/</kbd>
        ${t("chat.welcome.hintAfterShortcut")}
      </p>
      <div class="agent-chat__suggestions">
        ${WELCOME_SUGGESTION_KEYS.map((key) => {
          const text = t(key);
          return html`
            <button
              type="button"
              class="agent-chat__suggestion"
              @click=${() => {
                props.onDraftChange(text);
                props.onSend();
              }}
            >
              ${text}
            </button>
          `;
        })}
      </div>

      ${renderCapabilitiesPanel(props)}
    </div>
  `;
}

// Capabilities panel — visible on welcome screen so the user sees
// what Lumina can do via integrated apps and MCPs (Copilot-style).
type CapabilityCard = {
  id: string;
  label: string;
  caption: string;
  prompt: string;
  glyph: string;
};

const CAPABILITY_CARDS: CapabilityCard[] = [
  {
    id: "gmail",
    label: "Gmail",
    caption: "Lee, busca, responde y agrupa correos.",
    prompt: "Revisa mi Gmail y dime qué urge hoy.",
    glyph: "✉️",
  },
  {
    id: "drive",
    label: "Google Drive",
    caption: "Encuentra y resume archivos compartidos.",
    prompt: "Busca en mi Drive los últimos archivos sobre I24D.",
    glyph: "📂",
  },
  {
    id: "meta-ads",
    label: "Meta Ads",
    caption: "Crea, audita y optimiza campañas en FB/IG.",
    prompt: "Dame el estado de mis campañas activas en Meta Ads.",
    glyph: "📣",
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    caption: "Responde, resume hilos, manda recordatorios.",
    prompt: "Resume los mensajes no leídos de WhatsApp.",
    glyph: "💬",
  },
  {
    id: "browser",
    label: "Browser & Web",
    caption: "Navega, scrapea, llena formularios por ti.",
    prompt: "Abre y resume esta página: ",
    glyph: "🌐",
  },
  {
    id: "screen",
    label: "Pantalla & Sistema",
    caption: "Ve tu pantalla, lee archivos, ejecuta comandos.",
    prompt: "Mira mi pantalla y dime qué tengo abierto.",
    glyph: "🖥️",
  },
];

function renderCapabilitiesPanel(props: ChatWelcomeProps) {
  return html`
    <div class="agent-chat__capabilities">
      <div class="agent-chat__capabilities-title">Lo que Lumina puede hacer</div>
      <div class="agent-chat__capabilities-grid">
        ${CAPABILITY_CARDS.map(
          (card) => html`
            <button
              type="button"
              class="agent-chat__capability"
              data-cap=${card.id}
              @click=${() => {
                props.onDraftChange(card.prompt);
                if (!card.prompt.endsWith(" ") && !card.prompt.endsWith(": ")) {
                  props.onSend();
                }
              }}
              title=${card.caption}
              aria-label=${`${card.label}: ${card.caption}`}
            >
              <span class="agent-chat__capability-glyph" aria-hidden="true">${card.glyph}</span>
              <span class="agent-chat__capability-body">
                <span class="agent-chat__capability-label">${card.label}</span>
                <span class="agent-chat__capability-caption">${card.caption}</span>
              </span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}
