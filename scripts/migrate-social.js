import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";

const version = "004_social_phase1";
const migrationUrl = new URL("../migrations/004_social_phase1.sql", import.meta.url);
const db = await createDb();
const client = await db.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [version]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  const { rows } = await client.query(
    "SELECT to_regclass('public.users') AS users, to_regclass('public.games') AS games"
  );
  if (!rows[0].users || !rows[0].games) {
    throw new Error("PostgreSQL users and games tables must exist before applying social migration.");
  }

  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1",
    [version]
  );
  if (applied.rowCount) {
    await client.query("COMMIT");
    console.log("Social migration is already applied.");
  } else {
    const sql = await readFile(migrationUrl, "utf8");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    await client.query("COMMIT");
    console.log("Applied social migration 004_social_phase1.");
  }
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error("Social migration rollback failed:", rollbackError.code || "database error");
  }
  throw error;
} finally {
  client.release();
  await db.end();
}
