/**
 * gateway-methods.ts — The owner channel as gateway RPC methods.
 *
 * The Control UI's Lumina tab renders natively and calls these over its
 * authenticated gateway session, like the Logbook tab. Reads need
 * operator.read; every command needs operator.write. The state is the
 * process-wide cognitive core, so no method touches a user's profile.
 */
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { MemoryChannelError } from "./memory-channel.js";
import {
  createOwnerCommands,
  coreState,
  OwnerChannelError,
  type OwnerChannelDeps,
} from "./owner-channel.js";

function handler(run: (params: Readonly<Record<string, unknown>>) => unknown) {
  return async ({ params, respond }: GatewayRequestHandlerOptions) => {
    try {
      respond(true, await run(params ?? {}));
    } catch (error) {
      const message = formatErrorMessage(error);
      const code =
        error instanceof OwnerChannelError || error instanceof MemoryChannelError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      respond(false, { error: message }, errorShape(code, message));
    }
  };
}

export function registerCoreGatewayMethods(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod">,
  deps: OwnerChannelDeps,
): void {
  const options = (scope: "operator.read" | "operator.write") =>
    ({ scope, profileAccess: "independent" }) as const;
  api.registerGatewayMethod(
    "lumina.core.state",
    handler(() => coreState(deps)),
    options("operator.read"),
  );
  api.registerGatewayMethod(
    "lumina.core.audit.verify",
    handler(() => deps.runtime.safety.verifyStoredAudit()),
    options("operator.read"),
  );
  for (const [method, run] of Object.entries(createOwnerCommands(deps))) {
    api.registerGatewayMethod(method, handler(run), options("operator.write"));
  }
}
