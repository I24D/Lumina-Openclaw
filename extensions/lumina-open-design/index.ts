import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "./api.js";
import { resolveLuminaOpenDesignSettings } from "./src/config.js";
import {
  createLuminaOpenDesignHttpHandler,
  type GatewayRequest,
  type GatewayRequestOptions,
  submitLuminaOpenDesign,
} from "./src/http.js";
import { LuminaOpenDesignRuntime } from "./src/runtime.js";
import { LUMINA_OPEN_DESIGN_BASE_PATH } from "./src/ui.js";

export default definePluginEntry({
  id: "lumina-open-design",
  name: "Lumina Design",
  description: "OpenDesign workspace controlled by Lumina and the current OpenClaw model.",
  register(api) {
    const settings = resolveLuminaOpenDesignSettings(api.pluginConfig);
    const liveConfig = api.runtime.config?.current?.() ?? api.config ?? {};
    const gatewayPort = liveConfig.gateway?.port ?? 18789;
    const configuredAuth = liveConfig.gateway?.auth;
    const configuredSecret =
      configuredAuth?.mode === "password" ? configuredAuth.password : configuredAuth?.token;
    const bearerToken =
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      (typeof configuredSecret === "string" ? configuredSecret : undefined);
    const runtime = new LuminaOpenDesignRuntime(settings, api.logger, {
      apiBaseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
      openAiProxyBaseUrl: `http://127.0.0.1:${gatewayPort}${LUMINA_OPEN_DESIGN_BASE_PATH}/openai/v1`,
      bearerToken,
    });
    let integrationTimer: ReturnType<typeof setTimeout> | undefined;
    // Gateway handlers answer through `respond`; a returned value is dropped.
    const respondError = (respond: GatewayRequestHandlerOptions["respond"], err: unknown) => {
      const message = formatErrorMessage(err);
      respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
    };
    const gatewayRequest: GatewayRequest = <T>(method: string, params?: Record<string, unknown>) =>
      api.runtime.gateway.request<T>(method, params, {
        scopes: ["operator.write"],
        timeoutMs: 20_000,
      });

    api.registerGatewayMethod(
      "lumina.openDesign.create",
      async ({ params, respond }) => {
        try {
          respond(
            true,
            await submitLuminaOpenDesign(
              { runtime, sessionKey: settings.sessionKey, gatewayRequest },
              params,
            ),
          );
        } catch (err) {
          respondError(respond, err);
        }
      },
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "lumina.openDesign.studio",
      async ({ params, respond }) => {
        try {
          const projectId =
            typeof params.projectId === "string" && params.projectId.trim()
              ? params.projectId.trim()
              : undefined;
          const status = await runtime.launchDesktop(projectId);
          respond(true, { ok: true, source: status.source, projectId });
        } catch (err) {
          respondError(respond, err);
        }
      },
      { scope: "operator.write", profileAccess: "independent" },
    );

    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "design",
      label: "Diseño",
      description: "Create and inspect OpenDesign artifacts with Lumina.",
      icon: "palette",
      group: "control",
      order: 35,
      openInNewWindow: true,
      path: LUMINA_OPEN_DESIGN_BASE_PATH,
      requiredScopes: ["operator.write"],
    });

    api.registerHttpRoute({
      path: LUMINA_OPEN_DESIGN_BASE_PATH,
      auth: "gateway",
      match: "prefix",
      gatewayRuntimeScopeSurface: "write-default",
      handler: createLuminaOpenDesignHttpHandler({
        runtime,
        sessionKey: settings.sessionKey,
        gatewayRequest: <T>(
          method: string,
          params?: Record<string, unknown>,
          options?: GatewayRequestOptions,
        ) => api.runtime.gateway.request<T>(method, params, options),
      }),
    });

    api.registerService({
      id: "lumina-open-design-runtime",
      start: async ({ serviceHealth }) => {
        const status = await runtime.ensureReady();
        if (status.ready) {
          serviceHealth?.clearFailure();
          api.logger.info(`lumina-open-design: OpenDesign ${status.version ?? "unknown"} is ready`);
          await runtime.syncGatewayAgent({ testConnection: false });
          integrationTimer = setTimeout(() => {
            void runtime
              .syncGatewayAgent()
              .then((integration) => {
                if (integration.connected) {
                  api.logger.info(
                    `lumina-open-design: Studio is connected to ${integration.model} through OpenClaw`,
                  );
                } else {
                  api.logger.warn(
                    `lumina-open-design: Studio gateway integration needs attention: ${integration.error ?? "connection test failed"}`,
                  );
                }
              })
              .catch((error) => {
                api.logger.warn(
                  `lumina-open-design: deferred integration check failed: ${formatErrorMessage(error)}`,
                );
              });
          }, 1_500);
        } else {
          const error = new Error(status.error ?? "OpenDesign is unavailable");
          serviceHealth?.reportFailure(error);
          api.logger.warn(`lumina-open-design: ${error.message}`);
        }
      },
      stop: async () => {
        if (integrationTimer) {
          clearTimeout(integrationTimer);
          integrationTimer = undefined;
        }
        await runtime.stop();
      },
    });
  },
});
