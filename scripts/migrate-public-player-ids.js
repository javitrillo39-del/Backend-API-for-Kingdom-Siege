import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";

const version = "005_public_player_ids";
const migrationUrl = new URL("../migrations/005_public_player_ids.sql", import.meta.url);
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

  const { rows: tables } = await client.query(
    "SELECT to_regclass('public.player_profiles') AS player_profiles"
  );
  if (!tables[0].player_profiles) {
    throw new Error("The social profile migration must be applied before public player IDs.");
  }

  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1",
    [version]
  );
  if (!applied.rowCount) {
    const sql = await readFile(migrationUrl, "utf8");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
  }

  const { rows: verification } = await client.query(
    `SELECT COUNT(*)::INTEGER AS profiles,
            COUNT(public_player_id)::INTEGER AS assigned,
            COUNT(DISTINCT public_player_id)::INTEGER AS unique_ids
     FROM player_profiles`
  );
  const result = verification[0];
  if (result.profiles !== result.assigned || result.profiles !== result.unique_ids) {
    throw new Error("Public player ID migration verification failed.");
  }

  await client.query("COMMIT");
  console.log(
    `Public player IDs verified: ${result.assigned} profiles, all IDs present and unique.`
  );
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error("Public player ID migration rollback failed:", rollbackError.code || "database error");
  }
  throw error;
} finally {
  client.release();
  await db.end();
}
