import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createChatGptBridgeService } from "./src/bridge-service.js";

export default definePluginEntry({
  id: "chatgpt-bridge",
  name: "ChatGPT Bridge",
  description: "Relays marked orders from a ChatGPT tab into an OpenClaw chat session",
  register(api) {
    api.registerService(createChatGptBridgeService(api));
  },
});
