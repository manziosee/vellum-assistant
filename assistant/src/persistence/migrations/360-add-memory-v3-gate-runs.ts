import type { Database } from "bun:sqlite";

import type { DrizzleDb } from "../db-connection.js";
import { getMemorySqlite } from "../db-connection.js";

/**
 * Create the `memory_v3_gate_runs` table and its index on the memory DB.
 * Idempotent (`IF NOT EXISTS`). Exported so tests can stand up the schema
 * without running the full migration chain.
 *
 * Columns mirror the detail fields recorded by `recordGateRun` in
 * `v3/orchestrate.ts`. All are nullable except `id`, `created_at`, `pass`,
 * and `scored`, which are always present.
 */
export function ensureMemoryV3GateRunsSchema(memoryRaw: Database): void {
  memoryRaw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_v3_gate_runs (
      id TEXT NOT NULL PRIMARY KEY,
      created_at INTEGER NOT NULL,
      pass INTEGER NOT NULL DEFAULT 0,
      scored INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      real_concept_page_count INTEGER,
      top_dense_score REAL,
      top_norm_sparse_score REAL,
      checked_articles INTEGER
    )
  `);
  memoryRaw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_v3_gate_runs_created_at
      ON memory_v3_gate_runs (created_at)
  `);
}

/**
 * Add the `memory_v3_gate_runs` table to the memory database. The table is
 * the durable local store for injection-gate diagnostics: the
 * `GET /memory/v3/gate-stats` endpoint reads from it instead of the
 * telemetry outbox, whose rows are deleted after each successful platform
 * flush and therefore cover only a short recent window in a healthy system.
 *
 * Because this table lives entirely inside `assistant-memory.db` (which the
 * migration runner opens directly), no relocation step is needed.
 */
export async function migrateAddMemoryV3GateRuns(
  _database: DrizzleDb,
): Promise<void> {
  const raw = getMemorySqlite();
  if (!raw) {
    return;
  }
  ensureMemoryV3GateRunsSchema(raw);
}
