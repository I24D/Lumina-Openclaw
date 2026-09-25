import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createChatGptBridgeService } from "./src/bridge-service.js";
import { registerChatGptMcpGatewayMethods } from "./src/mcp-gateway.js";

export default definePluginEntry({
  id: "chatgpt-bridge",
  name: "ChatGPT Bridge",
  description: "Durably delegates ChatGPT work to OpenClaw and retains the browser relay",
  register(api) {
    registerChatGptMcpGatewayMethods(api);
    api.registerService(createChatGptBridgeService(api));
  },
});
