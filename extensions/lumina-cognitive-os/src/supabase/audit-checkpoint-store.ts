/**
 * audit-checkpoint-store.ts — Audit checkpoints in Lumina's Supabase.
 *
 * Writes to `m3gan_audit_checkpoints`, an append-only table (a trigger rejects
 * updates and deletes), one row per checkpoint, scoped by host. The table is
 * created by `sql/m3gan_audit_checkpoints.sql`; until it exists every call
 * fails and the checkpoint reports itself unavailable instead of pretending.
 */
import type { AuditCheckpoint, CheckpointStore } from "../safety/audit-checkpoint.js";
import { readSupabaseJson, resolveSupabaseConfig, supabaseFetch } from "./supabase-client.js";

const TABLE = "m3gan_audit_checkpoints";

export function createSupabaseCheckpointStore(options: {
  readonly host: string;
  readonly envPath?: string;
}): CheckpointStore {
  const config = () => ({
    ...resolveSupabaseConfig(options.envPath ? { envPath: options.envPath } : {}),
    schema: "public",
  });
  const host = encodeURIComponent(options.host);
  return {
    async latest() {
      const response = await supabaseFetch(
        config(),
        `/rest/v1/${TABLE}?host=eq.${host}&select=seq,head_hash&order=seq.desc&limit=1`,
      );
      const rows = await readSupabaseJson<Array<{ seq: number; head_hash: string }>>(response);
      if (!rows.ok) {
        throw new Error(`HTTP ${rows.status}: ${rows.error.slice(0, 200)}`);
      }
      const row = rows.data[0];
      return row ? { seq: row.seq, hash: row.head_hash } : undefined;
    },
    async write(checkpoint: AuditCheckpoint) {
      const response = await supabaseFetch(config(), `/rest/v1/${TABLE}`, {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({
          host: options.host,
          seq: checkpoint.seq,
          head_hash: checkpoint.hash,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
    },
  };
}
