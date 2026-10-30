/** The Postgres stores' statements (WALLET_SQL, KV_SQL) against the schema in migrations/. The store tests run on
 * fakes, so this is what ties the statements to real tables: every table a statement names, every column it reads or
 * writes and every ON CONFLICT target must be created by a migration. Also: the migrations stay additive and
 * idempotent, and the schema's limits match the server's. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { KV_SQL } from "../src/kv.ts";
import { BACKUP_MAX_BYTES, isCredentialId, WALLET_SQL } from "../src/services/walletBackup.ts";

const DIR = new URL("../migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();
const RAW = new Map(FILES.map((name) => [name, readFileSync(new URL(name, DIR), "utf8")]));
/** Every comment in these files runs to the end of its line, and no string literal holds "--". */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const sqlOf = (file: string) => stripComments(RAW.get(file) ?? "");

// ---- the schema ----------------------------------------------------------------------------------------------

type Table = { columns: Map<string, string>; keys: string[] };
const CONSTRAINTS = new Set(["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "EXCLUDE"]);

/** "(a, b)" anywhere in `text` → "a,b". */
const columnList = (text: string) => (/\(([^)]*)\)/.exec(text)?.[1] ?? "").split(",").map((c) => c.trim()).join(",");

/** CREATE TABLE bodies split at top-level commas: each column with its type, and each unique key (PRIMARY KEY or
 * UNIQUE, on a column or the table, or a CREATE UNIQUE INDEX) as its comma-joined columns. */
function parseTables(sql: string): Map<string, Table> {
  const tables = new Map<string, Table>();
  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)) {
    const parts: string[] = [];
    let depth = 1, quoted = false, part = "";
    for (let i = (match.index ?? 0) + match[0].length; depth > 0; i++) {
      const ch = sql[i];
      if (ch === undefined) throw new Error(`unterminated CREATE TABLE ${match[1]}`);
      if (ch === "'") quoted = !quoted;
      else if (!quoted && ch === "(") depth++;
      else if (!quoted && ch === ")") depth--;
      if (!quoted && (depth === 0 || (depth === 1 && ch === ","))) {
        parts.push(part.trim());
        part = "";
      } else {
        part += ch;
      }
    }
    const table: Table = { columns: new Map(), keys: [] };
    for (const definition of parts) {
      const [name = "", type = ""] = definition.split(/\s+/);
      if (/^(PRIMARY KEY|UNIQUE)\b/i.test(definition)) {
        table.keys.push(columnList(definition));
      } else if (!CONSTRAINTS.has(name.toUpperCase())) {
        table.columns.set(name, type);
        if (/\b(PRIMARY KEY|UNIQUE)\b/i.test(definition)) table.keys.push(name);
      }
    }
    tables.set(match[1] ?? "", table);
  }
  for (const match of sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON (\w+) (\([^)]*\))/g)) {
    tables.get(match[1] ?? "")?.keys.push(columnList(match[2] ?? ""));
  }
  return tables;
}

const SCHEMA = FILES.map(sqlOf).join("\n");
const TABLES = parseTables(SCHEMA);

// ---- the statements ------------------------------------------------------------------------------------------

const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "INSERT", "INTO", "VALUES", "ON",
  "CONFLICT", "DO", "NOTHING", "UPDATE", "SET", "RETURNING", "DELETE", "ORDER", "BY", "ASC", "DESC", "LIMIT", "FOR",
  "CASE", "WHEN", "THEN", "ELSE", "END"]);

/** The tables a statement names: after FROM, INTO, UPDATE or JOIN ("DO UPDATE SET" and a closing "FOR UPDATE" name
 * none). */
const tablesOf = (sql: string) =>
  [...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/gi)].map((m) => m[1] ?? "").filter((name) => !KEYWORDS.has(name.toUpperCase()));

/** The names left in a statement once string literals, ::casts, named arguments (secs =>), AS aliases, function
 * names (written name( with no space), $n parameters and keywords are taken out. A qualified name stays whole. */
function identifiers(sql: string): string[] {
  const bare = sql
    .replace(/'[^']*'/g, " ")
    .replace(/::\w+(\[\])?/g, " ")
    .replace(/\b\w+\s*=>/g, " ")
    .replace(/\bAS\s+\w+/gi, " ")
    .replace(/\b\w+\(/g, "(")
    .replace(/\$\d+/g, " ");
  return (bare.match(/\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/g) ?? []).filter((word) => !KEYWORDS.has(word.toUpperCase()));
}

/** What `sql` needs that the migrations don't create; empty when the statement fits the schema. */
function problems(sql: string): string[] {
  const named = tablesOf(sql);
  const target = /\bINSERT\s+INTO\s+(\w+)/i.exec(sql)?.[1];
  const found = named.filter((table) => !TABLES.has(table)).map((table) => `table ${table}`);
  for (const word of identifiers(sql)) {
    if (named.includes(word)) continue;
    const dot = word.indexOf(".");
    if (dot < 0) {
      if (!named.some((table) => TABLES.get(table)?.columns.has(word))) found.push(`column ${word}`);
      continue;
    }
    // EXCLUDED is the row an INSERT … ON CONFLICT proposed: it has the insert target's columns.
    const qualifier = word.slice(0, dot), column = word.slice(dot + 1);
    const table = qualifier.toUpperCase() === "EXCLUDED" ? target : qualifier;
    if (!table || !named.includes(table) || !TABLES.get(table)?.columns.has(column)) found.push(`column ${word}`);
  }
  // ON CONFLICT needs a unique key on exactly those columns, or Postgres refuses the statement.
  const conflict = /\bON CONFLICT\s*(\([^)]*\))/i.exec(sql)?.[1];
  if (conflict && target && !TABLES.get(target)?.keys.includes(columnList(conflict))) found.push(`no unique key ${conflict} on ${target}`);
  return found;
}

const STATEMENTS = [
  ...Object.entries(WALLET_SQL).map(([name, sql]) => ({ name: `WALLET_SQL.${name}`, sql: sql as string, file: "0001_wallet.sql" })),
  ...Object.entries(KV_SQL).map(([name, sql]) => ({ name: `KV_SQL.${name}`, sql: sql as string, file: "0002_kv.sql" })),
];

test("the migrations parse into the tables the stores use", () => {
  assert.deepEqual([...TABLES.keys()].sort(), ["exclip_kv", "exclip_kv_windows", "exclip_wallet_backups", "exclip_wallet_credentials"]);
  assert.deepEqual([...TABLES.get("exclip_kv")!.columns.keys()], ["key", "value", "expires_at"]);
  assert.deepEqual(TABLES.get("exclip_kv_windows")!.keys, ["key,member"]);
  assert.deepEqual(TABLES.get("exclip_wallet_backups")!.keys, ["id", "credential_id,version"]);
});

test("every statement the Postgres stores run fits the schema: tables, columns and ON CONFLICT keys", () => {
  for (const { name, sql, file } of STATEMENTS) {
    assert.ok(tablesOf(sql).length > 0, `${name} names a table`);
    assert.deepEqual(problems(sql), [], name);
    // The wallet's statements need only 0001, the KV's only 0002 (whose tables stay unused with Redis).
    const own = parseTables(sqlOf(file));
    for (const table of tablesOf(sql)) assert.ok(own.has(table), `${name}: ${table} is created by ${file}`);
  }
});

test("the schema check catches what it should (negative controls)", () => {
  assert.deepEqual(problems("SELECT nickname FROM exclip_wallet_credentials WHERE credential_id = $1"), ["column nickname"]);
  assert.deepEqual(problems("SELECT score FROM exclip_kv WHERE key = $1"), ["column score"], "a column of another table");
  assert.ok(problems("SELECT value FROM exclip_kv_values WHERE key = $1").includes("table exclip_kv_values"));
  assert.deepEqual(problems("DELETE FROM exclip_kv WHERE exclip_kv_windows.member = $1"), ["column exclip_kv_windows.member"]);
  assert.deepEqual(problems(`INSERT INTO exclip_kv (key, value, expires_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.member`), ["column EXCLUDED.member"]);
  assert.deepEqual(problems(`INSERT INTO exclip_kv_windows (key, member, score, expires_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (key) DO NOTHING`), ["no unique key (key) on exclip_kv_windows"]);
  // Aliases, casts, function names, parameters and a closing FOR UPDATE are none of these.
  assert.deepEqual(problems("SELECT count(*)::int AS n FROM exclip_wallet_backups WHERE credential_id = $1 FOR UPDATE"), []);
});

test("column types the stores depend on", () => {
  const type = (table: string, column: string) => TABLES.get(table)?.columns.get(column);
  // Sent and read back as Buffers.
  assert.equal(type("exclip_wallet_credentials", "public_key"), "bytea");
  assert.equal(type("exclip_wallet_backups", "blob"), "bytea");
  // Sent as a JS array of strings.
  assert.equal(type("exclip_wallet_credentials", "transports"), "text[]");
  // WebAuthn sign counts are unsigned 32-bit and window scores are Date.now() milliseconds: both outgrow integer.
  assert.equal(type("exclip_wallet_credentials", "sign_count"), "bigint");
  assert.equal(type("exclip_kv_windows", "score"), "bigint");
  for (const [table, { columns }] of TABLES) {
    for (const [column, t] of columns) if (column.endsWith("_at")) assert.equal(t, "timestamptz", `${table}.${column}`);
  }
});

test("the schema's limits match the server's", () => {
  const wallet = sqlOf("0001_wallet.sql");
  assert.ok(wallet.includes(`CHECK (octet_length(blob) BETWEEN 1 AND ${BACKUP_MAX_BYTES})`), "the backup size cap");
  // The credential_id CHECK takes the same alphabet and lengths as isCredentialId.
  assert.ok(wallet.includes("CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 512)"));
  assert.deepEqual([15, 16, 512, 513].map((n) => isCredentialId("A".repeat(n))), [false, true, true, false]);
  assert.equal(isCredentialId(`${"A".repeat(20)}=`), false);
  // Postgres refuses a regex repetition bound over 255 ("invalid repetition count(s)"), which is why lengths are
  // checked with char_length and not {16,512}.
  for (const literal of SCHEMA.match(/'[^']*'/g) ?? []) {
    for (const bound of literal.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
      assert.ok(Number(bound[1]) <= 255 && Number(bound[2] ?? 0) <= 255, `${literal}: a repetition bound over 255`);
    }
  }
});

test("no column holds personal data", () => {
  const PERSONAL = ["email", "ip", "address", "phone", "name", "user", "agent", "country", "phrase", "mnemonic", "seed", "password", "prf"];
  for (const [table, { columns }] of TABLES) {
    for (const column of columns.keys()) assert.ok(!column.split("_").some((part) => PERSONAL.includes(part)), `${table}.${column}`);
  }
});

test("backups are append-only in the database as well as in the store", () => {
  const wallet = sqlOf("0001_wallet.sql").replace(/\s+/g, " ");
  assert.ok(wallet.includes("CREATE TRIGGER exclip_wallet_backups_append_only BEFORE UPDATE ON exclip_wallet_backups FOR EACH ROW EXECUTE FUNCTION exclip_wallet_backups_no_update();"));
  assert.match(wallet, /FUNCTION exclip_wallet_backups_no_update\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION '[^']+'; END; \$\$;/);
  // A backup is deleted only with its credential (the 30-day purge), by cascade.
  assert.ok(wallet.includes("REFERENCES exclip_wallet_credentials (credential_id) ON DELETE CASCADE"));
  for (const { name, sql } of STATEMENTS) assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE FROM) exclip_wallet_backups\b/, name);
});

test("migrations: numbered in order, each says how to apply it, and each is additive and idempotent", () => {
  assert.ok(FILES.length >= 2);
  FILES.forEach((file, i) => assert.match(file, new RegExp(`^${String(i + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`)));
  for (const file of FILES) {
    const raw = RAW.get(file) ?? "";
    assert.ok(raw.split("\n").includes(`-- Apply with: psql "$DATABASE_URL" -f apps/server/migrations/${file}`), `${file}: how to apply it`);
    const sql = stripComments(raw).replace(/\s+/g, " ");
    for (const [create] of sql.matchAll(/\bCREATE [^(;]*/g)) {
      const trigger = /^CREATE TRIGGER (\w+) .*? ON (\w+)/.exec(create);
      if (trigger) assert.ok(sql.includes(`DROP TRIGGER IF EXISTS ${trigger[1]} ON ${trigger[2]}; ${create}`), `${file}: ${create} replaces itself`);
      else assert.match(create, /^CREATE (TABLE IF NOT EXISTS|(UNIQUE )?INDEX IF NOT EXISTS|OR REPLACE FUNCTION) /, `${file}: ${create}`);
    }
    for (const [drop] of sql.matchAll(/\bDROP [^;]*/g)) assert.match(drop, /^DROP TRIGGER IF EXISTS \w+ ON \w+$/, `${file}: ${drop}`);
    assert.doesNotMatch(sql, /\b(DELETE FROM|TRUNCATE|ALTER TABLE)\b/i, `${file}: no rows deleted, no table altered`);
  }
});
