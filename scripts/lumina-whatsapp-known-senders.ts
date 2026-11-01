import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Keeps the whatsapp agent's sender-scoped tool policy in step with Dal's contact
// book. WhatsApp DMs are open by Dal's choice, so the agent answers everyone, but
// only known numbers (whatsapp_contacts.json plus channels.whatsapp.allowFrom) keep
// the archive/profile tools; any other sender gets conversation only.
//
// Dry run by default: prints counts, never phone numbers. `--write` applies the
// result through `openclaw config patch`, which the gateway reloads without a restart.
//
// Run: node --import ./scripts/tsx.mjs scripts/lumina-whatsapp-known-senders.ts [--write]

type ToolPolicy = { deny: string[] };

const OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(OPENCLAW_HOME, "openclaw.json");
const CONTACTS_PATH = path.join(OPENCLAW_HOME, "workspace", "whatsapp_contacts.json");
const AGENT_ID = "whatsapp";
// Known contacts may run the archive script and edit their profiles, but untrusted
// conversation text must not be able to rewrite the agent's skills.
const KNOWN_SENDER_POLICY: ToolPolicy = { deny: ["skill_workshop"] };
const UNKNOWN_SENDER_POLICY: ToolPolicy = {
  deny: ["group:runtime", "group:fs", "group:web", "group:memory", "group:media", "group:agents"],
};

function toE164(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const digits = String(value)
    .replace(/@.*/, "")
    .replace(/[^0-9]/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function collectKnownSenders(config: Record<string, unknown>): Set<string> {
  const known = new Set<string>();
  const contacts = readJson(CONTACTS_PATH);
  if (!Array.isArray(contacts)) {
    throw new Error(`${CONTACTS_PATH} is not a JSON array`);
  }
  for (const contact of contacts) {
    const phone = toE164((contact as { phone?: unknown } | null)?.phone);
    if (phone) {
      known.add(phone);
    }
  }
  const channels = config.channels as { whatsapp?: { allowFrom?: unknown } } | undefined;
  const allowFrom = channels?.whatsapp?.allowFrom;
  for (const entry of Array.isArray(allowFrom) ? allowFrom : []) {
    const phone = entry === "*" ? null : toE164(entry);
    if (phone) {
      known.add(phone);
    }
  }
  return known;
}

function buildToolsBySender(known: Set<string>): Record<string, ToolPolicy> {
  const policy: Record<string, ToolPolicy> = {};
  for (const phone of [...known].toSorted()) {
    policy[`e164:${phone}`] = KNOWN_SENDER_POLICY;
  }
  policy["*"] = UNKNOWN_SENDER_POLICY;
  return policy;
}

function main(): void {
  const write = process.argv.includes("--write");
  const config = readJson(CONFIG_PATH) as Record<string, unknown>;
  const agents = config.agents as
    | { entries?: Record<string, { tools?: { toolsBySender?: Record<string, unknown> } }> }
    | undefined;
  const current = agents?.entries?.[AGENT_ID]?.tools?.toolsBySender ?? {};
  const desired = buildToolsBySender(collectKnownSenders(config));

  const currentKeys = new Set(Object.keys(current));
  const desiredKeys = new Set(Object.keys(desired));
  const added = [...desiredKeys].filter((key) => !currentKeys.has(key)).length;
  const removed = [...currentKeys].filter((key) => !desiredKeys.has(key)).length;
  const changed = [...desiredKeys].filter(
    (key) => currentKeys.has(key) && JSON.stringify(current[key]) !== JSON.stringify(desired[key]),
  ).length;
  console.log(
    `known senders: ${desiredKeys.size - 1}; to add: ${added}; to remove: ${removed}; to update: ${changed}`,
  );
  if (added + removed + changed === 0) {
    console.log("toolsBySender is already in sync.");
    return;
  }
  if (!write) {
    console.log("Dry run. Re-run with --write to apply.");
    return;
  }

  // `config patch` merges objects and deletes on null, so one write adds, updates and
  // removes keys without ever leaving the wildcard policy out.
  const toolsBySender: Record<string, ToolPolicy | null> = { ...desired };
  for (const key of currentKeys) {
    if (!desiredKeys.has(key)) {
      toolsBySender[key] = null;
    }
  }
  const patchFile = path.join(os.tmpdir(), `lumina-whatsapp-senders-${process.pid}.json`);
  fs.writeFileSync(
    patchFile,
    JSON.stringify({ agents: { entries: { [AGENT_ID]: { tools: { toolsBySender } } } } }),
  );
  try {
    execFileSync(process.execPath, ["dist/index.js", "config", "patch", "--file", patchFile], {
      stdio: "inherit",
      cwd: path.resolve(import.meta.dirname, ".."),
    });
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

main();
