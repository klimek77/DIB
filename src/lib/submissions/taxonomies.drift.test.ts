import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BRANCHES, DEPARTMENTS, ENRICHMENT_STATUSES, REVIEW_STATUSES, TONES, TOPICS } from "./taxonomies";

// Risk #4 (taxonomy drift). taxonomies.ts mirrors the DB CHECK enums by hand; if the
// two ever diverge, a value valid in TS passes app validation only to be REJECTED by
// the DB CHECK on INSERT (the "<1s thank-you, silently lost" failure). This guard reads
// the migration SQL — the physical source of truth (there is no Postgres ENUM/domain) —
// and asserts set-equality in BOTH directions, DIACRITIC-SENSITIVELY (the failure mode is
// exactly `Oświęcim` vs `Oswiecim`, `Pomysł` vs `Pomysl`), so a future drift fails CI
// instead of a user's submission.

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));

// Read every migration in filename (timestamp-prefixed → chronological) order, so a
// future DROP CONSTRAINT + re-ADD resolves to the last definition that wins.
function migrationsInDateOrder(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8"));
}

// Strip SQL comments so a `-- CONSTRAINT ...` line in a comment can never be parsed as DDL.
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

// Extract the balanced `CHECK (...)` expression from a constraint body. Balanced-paren
// matching is required: `CHECK (col IN (...))` nests, and slicing past the close paren
// would wrongly pull literals from later SQL (e.g. `WHERE enrichment_status = 'done'` in
// the partial indexes that follow the last CHECK). Returns null when the body is not a CHECK.
function extractCheckExpr(body: string): string | null {
  const open = /\bCHECK\s*\(/i.exec(body);
  if (!open) return null;
  const parenStart = open.index + open[0].length - 1;
  let depth = 0;
  for (let i = parenStart; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") {
      depth--;
      if (depth === 0) return body.slice(parenStart + 1, i);
    }
  }
  return null;
}

// Map every named CHECK that pins a string-value SET to its allowed values, resolving
// ADD/DROP across files in order (last definition wins). Non-CHECK constraints and CHECKs
// without string literals (e.g. `char_length(content) BETWEEN 1 AND 800`) are skipped.
// NOTE: `DROP CONSTRAINT IF EXISTS <name>` is handled — the optional `IF EXISTS` is skipped so the
// constraint name is captured, not `IF`. The presence assertion below remains a backstop: it fails
// loudly on a now-missing constraint, the safe direction if the parser ever misses a form.
function collectCheckValueSets(): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const raw of migrationsInDateOrder()) {
    const sql = stripSqlComments(raw);
    const tokens = [...sql.matchAll(/(?:DROP|ADD)?\s*CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)];
    for (let i = 0; i < tokens.length; i++) {
      const name = tokens[i][1];
      if (/^\s*DROP\b/i.test(tokens[i][0])) {
        sets.delete(name);
        continue;
      }
      const start = tokens[i].index + tokens[i][0].length;
      const end = i + 1 < tokens.length ? tokens[i + 1].index : sql.length;
      const checkExpr = extractCheckExpr(sql.slice(start, end));
      if (checkExpr === null) continue;
      const literals = [...checkExpr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (literals.length === 0) continue;
      sets.set(name, new Set(literals));
    }
  }
  return sets;
}

const CHECK_SETS = collectCheckValueSets();

// taxonomies.ts const ←→ the migration CHECK constraint that DB-enforces it.
const ENFORCED: readonly { column: string; constraint: string; values: readonly string[] }[] = [
  { column: "department", constraint: "submissions_department_check", values: DEPARTMENTS },
  { column: "branch", constraint: "submissions_branch_check", values: BRANCHES },
  { column: "topic", constraint: "submissions_topic_check", values: TOPICS },
  { column: "enrichment_status", constraint: "submissions_enrichment_status_check", values: ENRICHMENT_STATUSES },
  { column: "ai_tone", constraint: "submissions_ai_tone_check", values: TONES },
  { column: "review_status", constraint: "submissions_review_status_check", values: REVIEW_STATUSES },
];

describe("taxonomy drift guard — taxonomies.ts ≡ migration CHECK", () => {
  it("parsed all six enforced CHECK constraints from the migrations", () => {
    // Defensive: if a future migration changes CHECK syntax so the parser misses a
    // constraint, fail here rather than silently comparing the const against ∅.
    for (const { constraint } of ENFORCED) {
      expect(CHECK_SETS.has(constraint), `parser found no CHECK constraint named ${constraint}`).toBe(true);
    }
  });

  for (const { column, constraint, values } of ENFORCED) {
    it(`${column}: taxonomies.ts equals ${constraint} (both directions, diacritic-sensitive)`, () => {
      const dbValues = CHECK_SETS.get(constraint) ?? new Set<string>();
      const tsValues = new Set<string>(values);

      const inTsNotDb = [...tsValues].filter((value) => !dbValues.has(value));
      const inDbNotTs = [...dbValues].filter((value) => !tsValues.has(value));

      expect(inTsNotDb, `values in taxonomies.ts but absent from ${constraint}`).toEqual([]);
      expect(inDbNotTs, `values in ${constraint} but absent from taxonomies.ts`).toEqual([]);
    });
  }

  it("ai_classification has NO DB CHECK (app-level SSOT only)", () => {
    // CLASSIFICATIONS is deliberately not DB-enforced. Catch a future migration that adds
    // an ai_classification CHECK without this test being updated to expect it.
    const hasClassificationCheck = [...CHECK_SETS.keys()].some((name) => name.includes("ai_classification"));
    expect(hasClassificationCheck, "unexpected ai_classification CHECK found in a migration").toBe(false);
  });
});
