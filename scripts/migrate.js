import "dotenv/config";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { createDb } from "../src/db.js";

const schemaVersion = "001_initial_postgres";
const dataVersion = "002_import_sqlite";
const migrations = [
  { version: schemaVersion, path: new URL("../migrations/001_initial_postgres.sql", import.meta.url) },
  { version: "003_nonnegative_constraints", path: new URL("../migrations/003_nonnegative_constraints.sql", import.meta.url) }
];
const sqlitePath = fileURLToPath(new URL("../data/kingdom-siege.db", import.meta.url));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Configure it in .env.");
}
if (!existsSync(sqlitePath)) {
  throw new Error("SQLite source database not found at data/kingdom-siege.db; no PostgreSQL data was imported.");
}

const sqlite = await open({
  filename: sqlitePath,
  driver: sqlite3.Database,
  mode: sqlite3.OPEN_READONLY
});
let sourceUsers;
let sourceGames;
try {
  sourceUsers = await sqlite.all(
    "SELECT id, username, password_hash, created_at FROM users ORDER BY id"
  );
  sourceGames = await sqlite.all(
    `SELECT user_id, food, wood, gold, troops, health, farm, lumber, barracks, castle,
            victories, updated_at
     FROM games ORDER BY user_id`
  );
} finally {
  await sqlite.close();
}

const db = await createDb();
const client = await db.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  for (const migration of migrations) {
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [migration.version]
    );
    if (applied.rowCount) continue;

    const sql = await readFile(migration.path, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [migration.version]);
      await client.query("COMMIT");
      console.log(`Applied PostgreSQL migration ${migration.version}.`);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Migration rollback failed:", rollbackError.code || "database error");
      }
      throw error;
    }
  }

  const completed = await client.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1",
    [dataVersion]
  );
  if (completed.rowCount) {
    console.log("SQLite data migration is already applied; PostgreSQL data was not changed.");
  } else {
    const existing = await client.query(
      `SELECT (SELECT COUNT(*) FROM users)::INTEGER AS users,
              (SELECT COUNT(*) FROM games)::INTEGER AS games`
    );
    if (existing.rows[0].users || existing.rows[0].games) {
      throw new Error("PostgreSQL already contains users or games without the import marker; refusing to merge or overwrite data.");
    }

    await client.query("BEGIN");
    try {
      for (const user of sourceUsers) {
        await client.query(
          "INSERT INTO users(id, username, password_hash, created_at) VALUES($1, $2, $3, $4)",
          [user.id, user.username, user.password_hash, user.created_at]
        );
      }
      for (const game of sourceGames) {
        await client.query(
          `INSERT INTO games(user_id, food, wood, gold, troops, health, farm, lumber,
           barracks, castle, victories, updated_at)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            game.user_id, game.food, game.wood, game.gold, game.troops, game.health,
            game.farm, game.lumber, game.barracks, game.castle, game.victories, game.updated_at
          ]
        );
      }
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('users', 'id'),
           COALESCE(MAX(id), 1),
           COUNT(*) > 0
         ) FROM users`
      );
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [dataVersion]);
      await client.query("COMMIT");
      console.log(`Migration complete. Imported ${sourceUsers.length} users and ${sourceGames.length} games; SQLite remains unchanged.`);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Migration rollback failed:", rollbackError.code || "database error");
      }
      throw error;
    }
  }
} finally {
  client.release();
  await db.end();
}
