/**
 * Tests for `handleMemoryV3GateStats` in `memory-v3-routes.ts`.
 *
 * The handler aggregates gate runs from the durable `memory_v3_gate_runs`
 * table in the memory DB. These tests cover:
 *   - empty DB returns zero counts, all buckets present, scoredPassRate null
 *   - mixed rows land in the correct buckets by real_concept_page_count
 *   - scored vs unscored runs are counted separately
 *   - rows with no real_concept_page_count go to unknownPageCount
 *   - lookbackDays is clamped to [1, 90]
 *   - null/absent DB returns a zero response
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { ensureMemoryV3GateRunsSchema } from "../../../../../persistence/migrations/360-add-memory-v3-gate-runs.js";
import { handleMemoryV3GateStats } from "../memory-v3-routes.js";

// ---------------------------------------------------------------------------
// Minimal fake SQLite DB backed by an in-memory SQLite instance
// ---------------------------------------------------------------------------

type GateRow = {
  pass: number;
  scored: number;
  reason?: string | null;
  real_concept_page_count?: number | null;
};

function fakeDb(rows: GateRow[]): Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const sqlite = new Database(":memory:");
  ensureMemoryV3GateRunsSchema(sqlite);
  const stmt = sqlite.prepare(
    `INSERT INTO memory_v3_gate_runs
       (id, created_at, pass, scored, reason, real_concept_page_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let seq = 0;
  for (const row of rows) {
    stmt.run(
      `id-${seq++}`,
      Date.now(),
      row.pass,
      row.scored,
      row.reason ?? null,
      row.real_concept_page_count ?? null,
    );
  }
  return sqlite;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleMemoryV3GateStats", () => {
  test("returns zero counts with all buckets when DB is null", () => {
    const result = handleMemoryV3GateStats(30, null);
    expect(result.totalRuns).toBe(0);
    expect(result.buckets).toHaveLength(4);
    for (const bucket of result.buckets) {
      expect(bucket.total).toBe(0);
      expect(bucket.scored).toBe(0);
      expect(bucket.passed).toBe(0);
      expect(bucket.scoredPassRate).toBeNull();
      expect(bucket.reasons).toEqual({});
    }
    expect(result.unknownPageCount).toEqual({
      total: 0,
      passed: 0,
      reasons: {},
    });
  });

  test("returns zero counts with all buckets when DB returns no rows", () => {
    const result = handleMemoryV3GateStats(30, fakeDb([]));
    expect(result.totalRuns).toBe(0);
    expect(result.buckets[0]!.pageCountRange).toBe("0–9");
    expect(result.buckets[3]!.pageCountRange).toBe("200+");
    for (const b of result.buckets) {
      expect(b.scoredPassRate).toBeNull();
    }
  });

  test("buckets a dense_pass row into 10-49 bucket", () => {
    const rows: GateRow[] = [
      {
        pass: 1,
        scored: 1,
        reason: "dense_pass",
        real_concept_page_count: 25,
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.totalRuns).toBe(1);
    const bucket = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(bucket.total).toBe(1);
    expect(bucket.scored).toBe(1);
    expect(bucket.passed).toBe(1);
    expect(bucket.scoredPassRate).toBe(1);
    expect(bucket.reasons).toEqual({ dense_pass: 1 });
  });

  test("buckets a fail row into 200+ bucket", () => {
    const rows: GateRow[] = [
      {
        pass: 0,
        scored: 1,
        reason: "fail_no_signal",
        real_concept_page_count: 350,
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "200+")!;
    expect(bucket.total).toBe(1);
    expect(bucket.passed).toBe(0);
    expect(bucket.scoredPassRate).toBe(0);
    expect(bucket.reasons).toEqual({ fail_no_signal: 1 });
  });

  test("unscored pass-open rows count in total but not scored", () => {
    const rows: GateRow[] = [
      {
        pass: 1,
        scored: 0,
        reason: "dense_unavailable",
        real_concept_page_count: 5,
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "0–9")!;
    expect(bucket.total).toBe(1);
    expect(bucket.scored).toBe(0);
    expect(bucket.passed).toBe(1);
    // No scored runs: scoredPassRate is null (unscored pass does not count)
    expect(bucket.scoredPassRate).toBeNull();
  });

  test("unscored pass mixed with scored fail does not inflate scoredPassRate", () => {
    // Regression: before fix, pass-open + scored-fail in same bucket gave 100%
    const rows: GateRow[] = [
      {
        pass: 1,
        scored: 0,
        reason: "dense_unavailable",
        real_concept_page_count: 30,
      },
      {
        pass: 0,
        scored: 1,
        reason: "fail_no_signal",
        real_concept_page_count: 40,
      },
    ];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    const bucket = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(bucket.total).toBe(2);
    expect(bucket.scored).toBe(1);
    expect(bucket.passed).toBe(1); // total passes (scored + unscored)
    // Only the scored fail counts toward the rate: no scored passes
    expect(bucket.scoredPassRate).toBe(0);
  });

  test("rows with no real_concept_page_count go to unknownPageCount", () => {
    const rows: GateRow[] = [{ pass: 0, scored: 1, reason: "fail_no_signal" }];
    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.unknownPageCount.total).toBe(1);
    expect(result.unknownPageCount.passed).toBe(0);
    expect(result.unknownPageCount.reasons).toEqual({ fail_no_signal: 1 });
    for (const b of result.buckets) {
      expect(b.total).toBe(0);
    }
  });

  test("mixed rows across multiple buckets are aggregated correctly", () => {
    const rows: GateRow[] = [
      // 0-9 bucket: 1 unscored pass
      {
        pass: 1,
        scored: 0,
        reason: "dense_disabled",
        real_concept_page_count: 3,
      },
      // 10-49 bucket: 1 pass, 1 fail (both scored)
      { pass: 1, scored: 1, reason: "dense_pass", real_concept_page_count: 20 },
      {
        pass: 0,
        scored: 1,
        reason: "fail_no_signal",
        real_concept_page_count: 45,
      },
      // 50-199 bucket: 2 passes
      {
        pass: 1,
        scored: 1,
        reason: "sparse_only_strong",
        real_concept_page_count: 100,
      },
      {
        pass: 1,
        scored: 1,
        reason: "dense_pass",
        real_concept_page_count: 150,
      },
    ];

    const result = handleMemoryV3GateStats(30, fakeDb(rows));
    expect(result.totalRuns).toBe(5);

    const b09 = result.buckets.find((b) => b.pageCountRange === "0–9")!;
    expect(b09.total).toBe(1);
    expect(b09.scored).toBe(0);
    expect(b09.scoredPassRate).toBeNull();

    const b1049 = result.buckets.find((b) => b.pageCountRange === "10–49")!;
    expect(b1049.total).toBe(2);
    expect(b1049.scored).toBe(2);
    expect(b1049.passed).toBe(1);
    expect(b1049.scoredPassRate).toBe(0.5);
    expect(b1049.reasons).toEqual({ dense_pass: 1, fail_no_signal: 1 });

    const b50199 = result.buckets.find((b) => b.pageCountRange === "50–199")!;
    expect(b50199.scored).toBe(2);
    expect(b50199.passed).toBe(2);
    expect(b50199.scoredPassRate).toBe(1);
  });

  test("lookbackDays is clamped to 1-90", () => {
    const r1 = handleMemoryV3GateStats(0, fakeDb([]));
    expect(r1.lookbackDays).toBe(1);
    const r2 = handleMemoryV3GateStats(999, fakeDb([]));
    expect(r2.lookbackDays).toBe(90);
    const r3 = handleMemoryV3GateStats(30, fakeDb([]));
    expect(r3.lookbackDays).toBe(30);
  });
});
