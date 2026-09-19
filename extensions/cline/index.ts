import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerClineSessionCatalog } from "./session-catalog-plugin.js";

export default definePluginEntry({
  id: "cline",
  name: "Cline",
  description: "Native Cline session discovery and continuation through ACP",
  register(api) {
    registerClineSessionCatalog(api);
  },
});
