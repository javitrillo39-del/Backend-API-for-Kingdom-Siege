import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createDb } from "../src/db.js";

const version = "008_chat";
const migrationUrl = new URL("../migrations/008_chat.sql", import.meta.url);
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
    "SELECT to_regclass('public.users') AS users, to_regclass('public.player_profiles') AS player_profiles"
  );
  if (!rows[0].users || !rows[0].player_profiles) {
    throw new Error("The users and social profile migrations must be applied before chat.");
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

  const { rows: verification } = await client.query(`
    SELECT
      to_regclass('public.chat_channels') IS NOT NULL AS channels,
      to_regclass('public.chat_channel_members') IS NOT NULL AS members,
      to_regclass('public.chat_messages') IS NOT NULL AS messages,
      to_regclass('public.message_reports') IS NOT NULL AS reports,
      to_regclass('public.muted_users') IS NOT NULL AS mutes,
      EXISTS (SELECT 1 FROM chat_channels WHERE channel_type = 'global' AND channel_key = 'global') AS global_channel
  `);
  const result = verification[0];
  if (!result.channels || !result.members || !result.messages || !result.reports || !result.mutes || !result.global_channel) {
    throw new Error("Chat migration verification failed.");
  }

  await client.query("COMMIT");
  console.log(applied.rowCount ? "Chat migration is already applied." : "Applied chat migration 008_chat.");
  console.log("Chat tables and the global channel were verified.");
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    console.error("Chat migration rollback failed:", rollbackError.code || "database error");
  }
  throw error;
} finally {
  client.release();
  await db.end();
}
