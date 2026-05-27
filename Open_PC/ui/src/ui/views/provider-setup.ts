import { html, nothing } from "lit";

export type LuminaModelChoice = {
  id: string;
  name: string;
  description: string;
  context?: string;
};

export type LuminaProviderCatalog = {
  id: string;
  name: string;
  badge: string;
  description: string;
  defaultModelId: string;
  models: LuminaModelChoice[];
};

type DirectProviderCatalog = LuminaProviderCatalog & {
  apiFormat: string;
  baseUrl: string;
  apiKeyPlaceholder: string;
  apiKeyUrl?: string;
};

export type ProviderSetupProps = {
  connected: boolean;
  configSaving: boolean;
  lastError: string | null;
  activeModel: string | null;
  customPanelOpen: boolean;
  customProviderId: string;
  customApiKey: string;
  customBaseUrl: string;
  customModelId: string;
  customModelName: string;
  customApiFormat: string;
  onSelectLuminaModel: (modelId: string) => void;
  onCustomPanelOpenChange: (open: boolean) => void;
  onCustomFieldChange: (field: string, value: string) => void;
  onSaveCustomProvider: () => void;
};

const LUMINA_PROVIDER_CATALOG: LuminaProviderCatalog[] = [
  {
    id: "lumina",
    name: "Lumina IA",
    badge: "Default",
    description: "Ruta principal de Lumina. No usa API key visible en la PC del usuario.",
    defaultModelId: "I24D",
    models: [
      {
        id: "I24D",
        name: "Lumina IA",
        description: "Cerebro principal con memoria, router y aprendizaje del ecosistema Lumina.",
      },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    badge: "Router",
    description: "Modelos OpenAI administrados por Lumina/Render sin exponer tokens internos.",
    defaultModelId: "gpt-5.5",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        description:
          "Default recomendado para Lumina OpenClaw cuando se necesita maxima capacidad.",
      },
      {
        id: "gpt-5.4-pro",
        name: "GPT-5.4 Pro",
        description: "Modelo de mayor compute para respuestas mas precisas.",
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        description: "Modelo flagship de alta inteligencia y contexto amplio.",
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        description: "Alto rendimiento para coding, volumen y menor latencia.",
      },
      {
        id: "gpt-5.2",
        name: "GPT-5.2",
        description: "Modelo fuerte para agentes y razonamiento avanzado.",
      },
      {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        description: "Optimizado para coding y flujos agente largos.",
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        description: "Rapido y eficiente para tareas claras.",
      },
      {
        id: "gpt-4.1",
        name: "GPT-4.1",
        description: "Modelo estable de contexto largo.",
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        description: "Multimodal estable y flexible.",
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "Router",
    description: "Claude administrado por Lumina para agentes, analisis y contexto largo.",
    defaultModelId: "claude-opus-4-7",
    models: [
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        description: "Claude mas capaz en el perfil Lumina Code actual.",
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Opus de alta inteligencia para tareas criticas.",
      },
      {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        description: "Recomendado para uso diario avanzado y coding.",
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
        description: "Claude rapido y eficiente.",
      },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "Router",
    description: "Gemini enrutado por Lumina para contexto largo, imagen, audio y video.",
    defaultModelId: "gemini-2.5-pro-preview-06-05",
    models: [
      {
        id: "gemini-2.5-pro-preview-06-05",
        name: "Gemini 2.5 Pro Preview",
        description: "Modelo Gemini principal configurado en Lumina Code.",
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro",
        description: "Modelo Pro para razonamiento y contexto muy largo.",
      },
      {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        description: "Modelo rapido para flujos agente.",
      },
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        description: "Razonamiento fuerte y multimodalidad.",
      },
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Balance entre velocidad, costo y capacidad.",
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    badge: "Router",
    description: "DeepSeek administrado por Lumina para chat, codigo y razonamiento eficiente.",
    defaultModelId: "deepseek-chat",
    models: [
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        description: "Default DeepSeek compatible con el perfil Lumina Code actual.",
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        description: "Razonamiento para problemas complejos.",
      },
      {
        id: "deepseek-v3.1",
        name: "DeepSeek V3.1",
        description: "Modelo general avanzado.",
      },
      {
        id: "deepseek-r1-0528",
        name: "DeepSeek R1",
        description: "Modelo de razonamiento R1.",
      },
    ],
  },
];

const DIRECT_PROVIDER_CATALOG: DirectProviderCatalog[] = [
  {
    id: "openai",
    name: "OpenAI",
    badge: "Direct",
    description: "Usa tu propia OpenAI API key. Lumina configura OpenClaw por ti.",
    defaultModelId: "gpt-5.4-pro",
    apiFormat: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKeyPlaceholder: "Enter your OpenAI API key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", description: "Maxima capacidad OpenAI." },
      { id: "gpt-5.4", name: "GPT-5.4", description: "Flagship OpenAI." },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", description: "Rapido y eficiente." },
      { id: "gpt-5.2", name: "GPT-5.2", description: "Razonamiento avanzado." },
      { id: "gpt-5-mini", name: "GPT-5 Mini", description: "Baja latencia." },
      { id: "gpt-4.1", name: "GPT-4.1", description: "Contexto largo." },
      { id: "gpt-4o", name: "GPT-4o", description: "Multimodal estable." },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    badge: "Direct",
    description: "Conecta Claude con tu propia Anthropic API key.",
    defaultModelId: "claude-opus-4-7",
    apiFormat: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyPlaceholder: "Enter your Anthropic API key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        description: "Claude de maxima capacidad.",
      },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", description: "Opus avanzado." },
      {
        id: "claude-sonnet-4-5-20250929",
        name: "Claude Sonnet 4.5",
        description: "Balance ideal.",
      },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", description: "Rapido." },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    badge: "Direct",
    description: "Conecta Gemini con tu propia Google AI API key.",
    defaultModelId: "gemini-2.5-pro-preview-06-05",
    apiFormat: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyPlaceholder: "Enter your Google AI API key",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    models: [
      {
        id: "gemini-2.5-pro-preview-06-05",
        name: "Gemini 2.5 Pro Preview",
        description: "Pro preview.",
      },
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", description: "Contexto muy largo." },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", description: "Alta velocidad." },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Razonamiento fuerte." },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "Balance y velocidad." },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    badge: "Direct",
    description: "Conecta DeepSeek con tu propia API key.",
    defaultModelId: "deepseek-chat",
    apiFormat: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyPlaceholder: "Enter your DeepSeek API key",
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", description: "Chat general." },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", description: "Razonamiento." },
      { id: "deepseek-v3.1", name: "DeepSeek V3.1", description: "General avanzado." },
      { id: "deepseek-r1-0528", name: "DeepSeek R1", description: "Razonamiento R1." },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "Direct",
    description: "Un endpoint compatible con OpenAI para muchos proveedores.",
    defaultModelId: "openai/gpt-5.4-pro",
    apiFormat: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyPlaceholder: "Enter your OpenRouter API key",
    apiKeyUrl: "https://openrouter.ai/keys",
    models: [
      {
        id: "openai/gpt-5.4-pro",
        name: "OpenAI GPT-5.4 Pro",
        description: "OpenAI via OpenRouter.",
      },
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        description: "Claude via OpenRouter.",
      },
      {
        id: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        description: "Gemini via OpenRouter.",
      },
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek Chat",
        description: "DeepSeek via OpenRouter.",
      },
    ],
  },
  {
    id: "custom",
    name: "Custom API",
    badge: "Advanced",
    description: "Endpoint compatible con OpenAI o Anthropic.",
    defaultModelId: "",
    apiFormat: "openai-completions",
    baseUrl: "",
    apiKeyPlaceholder: "Enter your API key",
    models: [],
  },
];

function activeLuminaModelId(activeModel: string | null): string | null {
  if (!activeModel) return null;
  const parts = activeModel.split("/");
  if (parts[0] === "lumina" && parts[1]) return parts.slice(1).join("/");
  return null;
}

function findProviderModel(
  provider: LuminaProviderCatalog,
  modelId: string | null,
): LuminaModelChoice {
  return (
    provider.models.find((model) => model.id === modelId) ??
    provider.models.find((model) => model.id === provider.defaultModelId) ??
    provider.models[0]
  );
}

function findDirectProvider(providerId: string): DirectProviderCatalog {
  return (
    DIRECT_PROVIDER_CATALOG.find((provider) => provider.id === providerId) ??
    DIRECT_PROVIDER_CATALOG[0]
  );
}

function managedOptionLabel(provider: LuminaProviderCatalog, model: LuminaModelChoice): string {
  if (provider.id === "lumina") return model.name;
  return `${provider.name} - ${model.name}`;
}

function renderProviderIcon(name: string) {
  return html`<span class="provider-logo">${name.slice(0, 1).toUpperCase()}</span>`;
}

function setDirectProviderPreset(props: ProviderSetupProps, providerId: string) {
  const provider = findDirectProvider(providerId);
  const firstModel = provider.models[0];
  props.onCustomFieldChange("providerId", provider.id);
  props.onCustomFieldChange("baseUrl", provider.baseUrl);
  props.onCustomFieldChange("apiFormat", provider.apiFormat);
  props.onCustomFieldChange("modelId", firstModel?.id ?? "");
  props.onCustomFieldChange("modelName", firstModel?.name ?? "");
}

function setDirectModelPreset(
  props: ProviderSetupProps,
  provider: DirectProviderCatalog,
  modelId: string,
) {
  if (modelId === "__custom__") {
    props.onCustomFieldChange("modelId", "");
    props.onCustomFieldChange("modelName", "");
    return;
  }
  const model = provider.models.find((entry) => entry.id === modelId);
  props.onCustomFieldChange("modelId", modelId);
  props.onCustomFieldChange("modelName", model?.name ?? modelId);
}

function renderPrimaryModelCard(props: ProviderSetupProps) {
  const activeLumina = activeLuminaModelId(props.activeModel);
  const customActive = props.activeModel && !activeLumina;
  const selectedValue = activeLumina ?? "";
  const disabled = !props.connected || props.configSaving;
  const activeChoice = activeLumina
    ? LUMINA_PROVIDER_CATALOG.flatMap((provider) => provider.models).find(
        (model) => model.id === activeLumina,
      )
    : null;
  return html`
    <section class="provider-role-card">
      <div class="provider-role-row">
        <div class="provider-role-main">
          <div class="provider-role-title">
            Chat <span class="provider-shortcut">OpenClaw</span>
          </div>
          <div class="provider-role-copy">
            Usado por Chat, Agentes, Habilidades y automatizaciones. Elige y sigue chateando.
          </div>
        </div>
        <button
          class="provider-icon-button"
          title="Agregar proveedor propio"
          ?disabled=${disabled}
          @click=${() => props.onCustomPanelOpenChange(true)}
        >
          +
        </button>
      </div>
      <div class="provider-select-row">
        <select
          class="provider-main-select"
          .value=${selectedValue}
          ?disabled=${disabled}
          @change=${(e: Event) => props.onSelectLuminaModel((e.target as HTMLSelectElement).value)}
        >
          ${customActive
            ? html`<option value="" disabled>Proveedor propio activo: ${props.activeModel}</option>`
            : nothing}
          ${LUMINA_PROVIDER_CATALOG.map(
            (provider) => html`
              <optgroup label=${provider.name}>
                ${provider.models.map(
                  (model) =>
                    html`<option value=${model.id}>${managedOptionLabel(provider, model)}</option>`,
                )}
              </optgroup>
            `,
          )}
        </select>
        <button
          class="provider-gear"
          title="Configurar proveedor propio"
          ?disabled=${disabled}
          @click=${() => props.onCustomPanelOpenChange(true)}
        >
          ...
        </button>
      </div>
      <div class="provider-model-note">
        ${customActive
          ? "Este chat esta usando un proveedor directo con la API key del usuario."
          : (activeChoice?.description ??
            "Lumina enruta este modelo desde Render. No hay keys visibles para el usuario.")}
      </div>
    </section>
  `;
}

function renderLuminaProviderCard(
  props: ProviderSetupProps,
  provider: LuminaProviderCatalog,
  activeLumina: string | null,
) {
  const isActiveProvider = provider.models.some((model) => model.id === activeLumina);
  const selectedModel = findProviderModel(
    provider,
    isActiveProvider ? activeLumina : provider.defaultModelId,
  );
  const disabled = !props.connected || props.configSaving;
  return html`
    <article class="provider-card ${isActiveProvider ? "provider-card--active" : ""}">
      <div class="provider-card__header">
        <div class="provider-card__brand">
          ${renderProviderIcon(provider.name)}
          <div>
            <span class="provider-card__name">${provider.name}</span>
            <span class="provider-card__desc">${provider.description}</span>
          </div>
        </div>
        <span class="provider-card__badge">${provider.badge}</span>
      </div>
      <label class="provider-model-picker">
        <span class="provider-model-picker__label">Modelo</span>
        <select
          class="provider-model-picker__select"
          .value=${selectedModel.id}
          ?disabled=${disabled}
          @change=${(e: Event) => props.onSelectLuminaModel((e.target as HTMLSelectElement).value)}
        >
          ${provider.models.map((model) => html`<option value=${model.id}>${model.name}</option>`)}
        </select>
      </label>
      <span class="provider-model-picker__hint">${selectedModel.description}</span>
      <button
        class="provider-card__action"
        ?disabled=${disabled || activeLumina === selectedModel.id}
        @click=${() => props.onSelectLuminaModel(selectedModel.id)}
      >
        ${activeLumina === selectedModel.id ? "Seleccionado" : "Usar"}
      </button>
    </article>
  `;
}

function renderLuminaSection(props: ProviderSetupProps) {
  const activeLumina = activeLuminaModelId(props.activeModel);
  return html`
    <section class="provider-section">
      <div class="provider-section__header">
        <div>
          <div class="provider-section__title">Lumina Router</div>
          <div class="provider-section__subtitle">
            Estos modelos hablan con OpenClaw a traves de Lumina/Render. Las keys reales nunca se
            exponen.
          </div>
        </div>
      </div>
      <div class="provider-cards">
        ${LUMINA_PROVIDER_CATALOG.map((provider) =>
          renderLuminaProviderCard(props, provider, activeLumina),
        )}
      </div>
    </section>
  `;
}

function renderCustomProviderPanel(props: ProviderSetupProps) {
  if (!props.customPanelOpen) {
    return nothing;
  }
  const selectedProvider = findDirectProvider(props.customProviderId);
  const customModelSelected =
    selectedProvider.id === "custom" ||
    (props.customModelId.trim() &&
      !selectedProvider.models.some((model) => model.id === props.customModelId.trim()));
  const modelSelectValue = customModelSelected
    ? "__custom__"
    : props.customModelId.trim() || selectedProvider.defaultModelId;
  const baseUrl = props.customBaseUrl || selectedProvider.baseUrl;
  const apiFormat = props.customApiFormat || selectedProvider.apiFormat;
  const modelId = props.customModelId || selectedProvider.defaultModelId;
  const canConnect =
    props.connected &&
    !props.configSaving &&
    props.customApiKey.trim() &&
    baseUrl.trim() &&
    modelId.trim();
  return html`
    <section class="provider-add-panel">
      <div class="provider-add-panel__top">
        <div>
          <div class="provider-add-panel__eyebrow">Advanced</div>
          <h2>Add Chat model</h2>
          <p>Conecta tu propia key sin editar JSON ni archivos de configuracion.</p>
        </div>
        <button
          class="provider-close"
          title="Cerrar"
          @click=${() => props.onCustomPanelOpenChange(false)}
        >
          x
        </button>
      </div>

      <div class="provider-add-grid">
        <label class="provider-form__field">
          <span class="provider-form__label">Provider</span>
          <select
            class="provider-form__input"
            .value=${selectedProvider.id}
            ?disabled=${!props.connected || props.configSaving}
            @change=${(e: Event) =>
              setDirectProviderPreset(props, (e.target as HTMLSelectElement).value)}
          >
            ${DIRECT_PROVIDER_CATALOG.map(
              (provider) => html`<option value=${provider.id}>${provider.name}</option>`,
            )}
          </select>
        </label>

        <label class="provider-form__field">
          <span class="provider-form__label">Model</span>
          <select
            class="provider-form__input"
            .value=${modelSelectValue}
            ?disabled=${!props.connected || props.configSaving}
            @change=${(e: Event) =>
              setDirectModelPreset(props, selectedProvider, (e.target as HTMLSelectElement).value)}
          >
            ${selectedProvider.models.map(
              (model) => html`<option value=${model.id}>${model.name}</option>`,
            )}
            <option value="__custom__">Custom model id...</option>
          </select>
        </label>

        ${customModelSelected
          ? html`
              <label class="provider-form__field">
                <span class="provider-form__label">Custom model ID</span>
                <input
                  class="provider-form__input"
                  type="text"
                  placeholder="provider-model-id"
                  .value=${props.customModelId}
                  ?disabled=${!props.connected || props.configSaving}
                  @input=${(e: Event) =>
                    props.onCustomFieldChange("modelId", (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="provider-form__field">
                <span class="provider-form__label">Display name</span>
                <input
                  class="provider-form__input"
                  type="text"
                  placeholder="My model"
                  .value=${props.customModelName}
                  ?disabled=${!props.connected || props.configSaving}
                  @input=${(e: Event) =>
                    props.onCustomFieldChange("modelName", (e.target as HTMLInputElement).value)}
                />
              </label>
            `
          : nothing}

        <label class="provider-form__field provider-form__field--wide">
          <span class="provider-form__label">API key</span>
          <input
            class="provider-form__input"
            type="password"
            placeholder=${selectedProvider.apiKeyPlaceholder}
            .value=${props.customApiKey}
            ?disabled=${!props.connected || props.configSaving}
            @input=${(e: Event) =>
              props.onCustomFieldChange("apiKey", (e.target as HTMLInputElement).value)}
          />
          ${selectedProvider.apiKeyUrl
            ? html`
                <a class="provider-help-link" href=${selectedProvider.apiKeyUrl} target="_blank">
                  Crear API key de ${selectedProvider.name}
                </a>
              `
            : nothing}
        </label>

        <label class="provider-form__field">
          <span class="provider-form__label">URL / API Base</span>
          <input
            class="provider-form__input"
            type="url"
            placeholder="https://api.example.com/v1"
            .value=${baseUrl}
            ?disabled=${!props.connected || props.configSaving}
            @input=${(e: Event) =>
              props.onCustomFieldChange("baseUrl", (e.target as HTMLInputElement).value)}
          />
        </label>

        <label class="provider-form__field">
          <span class="provider-form__label">API format</span>
          <select
            class="provider-form__input"
            .value=${apiFormat}
            ?disabled=${!props.connected || props.configSaving}
            @change=${(e: Event) =>
              props.onCustomFieldChange("apiFormat", (e.target as HTMLSelectElement).value)}
          >
            <option value="openai-completions">OpenAI compatible</option>
            <option value="anthropic-messages">Anthropic Messages</option>
            <option value="google-generative-ai">Google Gemini</option>
          </select>
        </label>
      </div>

      <button
        class="provider-connect"
        ?disabled=${!canConnect}
        @click=${() => props.onSaveCustomProvider()}
      >
        ${props.configSaving ? "Connecting..." : "Connect"}
      </button>
      <div class="provider-add-panel__foot">
        Esto actualiza la configuracion interna de OpenClaw y selecciona el modelo automaticamente.
      </div>
    </section>
  `;
}

export function renderProviderSetup(props: ProviderSetupProps) {
  return html`
    <div class="provider-setup">
      <header class="provider-hero">
        <div>
          <p class="provider-hero__eyebrow">Proveedor</p>
          <h1>Models</h1>
          <p>
            Lumina viene lista por defecto. Si el usuario quiere su propia key, pulsa +, elige
            proveedor/modelo y conecta.
          </p>
        </div>
        <button
          class="provider-add-button"
          ?disabled=${!props.connected || props.configSaving}
          @click=${() => props.onCustomPanelOpenChange(true)}
          title="Add Chat model"
        >
          +
        </button>
      </header>
      ${props.lastError
        ? html`<div class="callout danger provider-setup__error">${props.lastError}</div>`
        : nothing}
      ${!props.connected
        ? html`<div class="callout provider-setup__offline">
            Conecta el gateway para configurar proveedores.
          </div>`
        : nothing}
      ${renderPrimaryModelCard(props)} ${renderCustomProviderPanel(props)}
      ${renderLuminaSection(props)}
    </div>
  `;
}
