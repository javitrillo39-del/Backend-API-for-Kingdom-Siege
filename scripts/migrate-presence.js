import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";

const version = "006_realtime_presence";
const migrationUrl = new URL("../migrations/006_realtime_presence.sql", import.meta.url);
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
    "SELECT to_regclass('public.player_profiles') AS player_profiles"
  );
  if (!rows[0].player_profiles) {
    throw new Error("The social profile migration must be applied before presence migration.");
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
            COUNT(public_player_id)::INTEGER AS "profilesWithPublicIds",
            COUNT(DISTINCT public_player_id)::INTEGER AS "uniquePublicIds"
     FROM player_profiles`
  );
  const result = verification[0];
  if (
    result.profiles !== result.profilesWithPublicIds ||
    result.profiles !== result.uniquePublicIds
  ) {
    throw new Error("Presence migration verification failed.");
  }

  await client.query("COMMIT");
  console.log(
    `Presence migration verified: ${result.profiles} profiles retain unique public IDs.`
  );
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error("Presence migration rollback failed:", rollbackError.code || "database error");
  }
  throw error;
} finally {
  client.release();
  await db.end();
}
