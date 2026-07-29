/**
 * Tests for the learned-edge lane (`learned-edges.ts`).
 *
 * `computeLearnedEdgeGraph` reads `memory_v3_selections` over the dedicated
 * memory connection: each test installs an in-memory SQLite db into the
 * `memory` singleton slot (where the accessor resolves its connection), seeds
 * it with selection rows, and asserts the NPMI association graph. Rows
 * sharing a `(conversation_id, created_at)` form one selector call.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  clearStoredDb,
  setStoredDb,
} from "../../../../persistence/db-singleton.js";
import { ensureMemoryV3SelectionsSchema } from "../../../../persistence/migrations/338-move-memory-v3-selections-to-memory-db.js";
import * as schema from "../../../../persistence/schema/index.js";
import type { EdgeGraph } from "./edge.js";
import {
  computeLearnedEdgeGraph,
  type LearnedEdgesOptions,
} from "./learned-edges.js";

const HALF_LIFE_MS = 1_000_000;
const NOW = 100_000;

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  ensureMemoryV3SelectionsSchema(sqlite);
  setStoredDb("memory", drizzle(sqlite, { schema }), () => sqlite.close());
});

afterEach(() => {
  clearStoredDb("memory");
});

let nextTurn = 0;
/** Insert one selector call: every slug shares the same (conv, created_at). */
function seedCall(slugs: string[], createdAt = NOW, conv = "conv-1"): void {
  const stmt = sqlite.query(
    `INSERT INTO memory_v3_selections (conversation_id, turn, slug, source, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const turn = nextTurn++;
  for (const slug of slugs) {
    stmt.run(conv, turn, slug, "needle", 0, createdAt);
  }
}

function graphOf(overrides: Partial<LearnedEdgesOptions> = {}) {
  return computeLearnedEdgeGraph({
    halfLifeMs: HALF_LIFE_MS,
    minCount: 2,
    npmiFloor: 0.2,
    maxPerPage: 6,
    now: NOW,
    windowMs: NOW,
    knownSlugs: new Set([
      "page-a",
      "page-b",
      "page-c",
      "page-d",
      "skills/widget",
    ]),
    ...overrides,
  });
}

const peersOf = (
  graph: ReturnType<typeof computeLearnedEdgeGraph>,
  slug: string,
): string[] => [...(graph.adjacency.get(slug)?.keys() ?? [])];

describe("computeLearnedEdgeGraph", () => {
  test("pages selected together (and rarely apart) form a symmetric edge", () => {
    // a+b co-select twice; c selects alone twice (so a/b are not ubiquitous).
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-c"], NOW, "conv-3");
    seedCall(["page-c"], NOW, "conv-4");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
    expect(peersOf(graph, "page-b")).toEqual(["page-a"]);
    expect(graph.hubs.size).toBe(0);
  });

  test("a page selected in every call forms no edges (NPMI → 0)", () => {
    // page-a rides every call; page-b/page-c each appear half the time.
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-c"], NOW, "conv-3");
    seedCall(["page-a", "page-c"], NOW, "conv-4");

    const graph = graphOf();
    // p(a) = 1 ⇒ p(a,b) = p(b) ⇒ npmi = 0, floored out — for every pairing.
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("a pair co-selected in every call forms no edge (NPMI is undefined)", () => {
    // Every in-window call selects exactly {a, b}: pab = pa = pb = 1, so the
    // NPMI normalizer -log(pab) is -0 and the score is NaN. NaN must not slip
    // past the floor into the adjacency (it would also corrupt the
    // strongest-first neighbor ordering).
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-b"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(peersOf(graph, "page-b")).toEqual([]);
  });

  test("pairs below the co-occurrence mass floor form no edge", () => {
    seedCall(["page-a", "page-b"], NOW, "conv-1"); // mass ≈ 1 < minCount 2
    seedCall(["page-c"], NOW, "conv-2");
    seedCall(["page-d"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("decay pushes old co-selections below the mass floor", () => {
    // Two co-selections ten half-lives ago: decayed mass ≈ 0.002 < 2.
    seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-1");
    seedCall(["page-a", "page-b"], NOW - 10 * HALF_LIFE_MS, "conv-2");
    seedCall(["page-c"], NOW, "conv-3");

    const graph = graphOf({ windowMs: 20 * HALF_LIFE_MS });
    expect(peersOf(graph, "page-a")).toEqual([]);
  });

  test("maxPerPage keeps the strongest associations first", () => {
    // page-a co-selects with b twice and with c once alongside others, making
    // a↔b the stronger association; cap page-a to one edge.
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");
    seedCall(["page-a", "page-c", "page-d"], NOW, "conv-3");
    seedCall(["page-a", "page-c", "page-d"], NOW, "conv-4");
    seedCall(["page-d"], NOW, "conv-5");
    seedCall(["page-d"], NOW, "conv-6");

    const graph = graphOf({ maxPerPage: 1 });
    expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
  });

  test("capability slugs participate like any page", () => {
    seedCall(["skills/widget", "page-a"], NOW, "conv-1");
    seedCall(["skills/widget", "page-a"], NOW, "conv-2");
    seedCall(["page-b"], NOW, "conv-3");
    seedCall(["page-b"], NOW, "conv-4");

    const graph = graphOf();
    expect(peersOf(graph, "skills/widget")).toEqual(["page-a"]);
    expect(peersOf(graph, "page-a")).toEqual(["skills/widget"]);
  });

  test("slugs outside knownSlugs never form edges", () => {
    seedCall(["page-a", "deleted-page"], NOW, "conv-1");
    seedCall(["page-a", "deleted-page"], NOW, "conv-2");
    seedCall(["page-b"], NOW, "conv-3");

    const graph = graphOf();
    expect(peersOf(graph, "page-a")).toEqual([]);
    expect(graph.adjacency.has("deleted-page")).toBe(false);
  });

  test("maxPerPage = 0 disables the lane", () => {
    seedCall(["page-a", "page-b"], NOW, "conv-1");
    seedCall(["page-a", "page-b"], NOW, "conv-2");

    const graph = graphOf({ maxPerPage: 0 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("rows outside the scan window are ignored", () => {
    seedCall(["page-a", "page-b"], NOW - 50_000, "conv-1");
    seedCall(["page-a", "page-b"], NOW - 60_000, "conv-2");

    const graph = graphOf({ windowMs: 10_000 });
    expect(graph.adjacency.size).toBe(0);
  });

  test("degrades to an empty graph when the memory database is unavailable", () => {
    // Simulate unavailability through the singleton slot instead of
    // `mock.module`, which is process-global and leaks into sibling test
    // files. The accessor extracts the raw connection from the stored
    // handle's `$client`, so a handle without one makes `getMemorySqlite()`
    // resolve to null, the same contract computeLearnedEdgeGraph sees when
    // the dedicated open fails.
    clearStoredDb("memory");
    setStoredDb("memory", { $client: null }, () => {});

    const graph = graphOf();
    expect(graph.adjacency.size).toBe(0);
    expect(graph.hubs.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Cold-start structural seeding
  // ---------------------------------------------------------------------------

  describe("structural cold-start (no behavioral data)", () => {
    function makeEdgeGraph(
      adjacency: Record<string, string[]>,
      hubs: string[] = [],
    ): EdgeGraph {
      const knownSlugs = new Set([
        "page-a",
        "page-b",
        "page-c",
        "page-d",
        "skills/widget",
      ]);
      return {
        adjacency: new Map(
          Object.entries(adjacency).map(([source, targets]) => [
            source,
            new Map(targets.map((t) => [t, undefined])),
          ]),
        ),
        hubs: new Set(hubs),
        slugs: knownSlugs,
      };
    }

    test("uses structural prior when no behavioral rows exist", () => {
      // No seedCall: selection log is empty.
      const prior = makeEdgeGraph({ "page-a": ["page-b", "page-c"] });
      const graph = graphOf({ structuralPrior: prior });

      expect(peersOf(graph, "page-a")).toEqual(["page-b", "page-c"]);
      // Structural seeding is directional (authored link, not behavioral
      // co-selection). page-b had no authored edges in the prior.
      expect(peersOf(graph, "page-b")).toEqual([]);
    });

    test("cold-start edges are filtered to knownSlugs", () => {
      // Prior includes a target not in knownSlugs: it should be dropped.
      const prior: EdgeGraph = {
        adjacency: new Map([
          [
            "page-a",
            new Map<string, undefined>([
              ["page-b", undefined],
              ["deleted-page", undefined], // not in knownSlugs
            ]),
          ],
        ]),
        hubs: new Set(),
        slugs: new Set(["page-a", "page-b", "deleted-page"]),
      };
      const graph = graphOf({ structuralPrior: prior });

      expect(peersOf(graph, "page-a")).toEqual(["page-b"]);
      expect(graph.adjacency.has("deleted-page")).toBe(false);
    });

    test("cold-start edges are capped at maxPerPage", () => {
      // page-a has 4 authored neighbors; maxPerPage is 2 → only 2 survive.
      const prior = makeEdgeGraph({
        "page-a": ["page-b", "page-c", "page-d", "skills/widget"],
      });
      const graph = graphOf({ structuralPrior: prior, maxPerPage: 2 });

      expect(peersOf(graph, "page-a")).toHaveLength(2);
      expect(peersOf(graph, "page-a")).toEqual(["page-b", "page-c"]);
    });

    test("hub pages from the prior are preserved in the cold-start graph", () => {
      // page-c is a hub in the authored graph: should carry through.
      const prior = makeEdgeGraph({ "page-a": ["page-b", "page-c"] }, [
        "page-c",
      ]);
      const graph = graphOf({ structuralPrior: prior });

      expect(graph.hubs.has("page-c")).toBe(true);
      // page-c still appears as a neighbor (hub exclusion is edgeExpand's job,
      // not the graph builder's).
      expect(peersOf(graph, "page-a")).toContain("page-c");
    });

    test("structural prior is ignored once behavioral data exists", () => {
      // Seed two calls so a real NPMI edge forms between page-b and page-d.
      seedCall(["page-b", "page-d"], NOW, "conv-1");
      seedCall(["page-b", "page-d"], NOW, "conv-2");
      seedCall(["page-a"], NOW, "conv-3"); // background

      // Prior has an authored edge page-a → page-b that would dominate if the
      // behavioral path were skipped.
      const prior = makeEdgeGraph({ "page-a": ["page-b"] });
      const graph = graphOf({ structuralPrior: prior, minCount: 2 });

      // Behavioral NPMI edge exists; authored prior is NOT applied.
      expect(peersOf(graph, "page-b")).toEqual(["page-d"]);
      // page-a had no behavioral co-selections: it forms no edges through
      // the behavioral path, and the prior is not used (rows > 0).
      expect(peersOf(graph, "page-a")).toEqual([]);
    });

    test("returns empty graph when no prior and no behavioral data", () => {
      // Original behavior preserved: no prior, no rows → empty.
      const graph = graphOf();
      expect(graph.adjacency.size).toBe(0);
    });
  });
});
