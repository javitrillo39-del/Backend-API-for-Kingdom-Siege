import pg from "pg";

const { Pool } = pg;

export async function createDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Configure it in .env.");
  }

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 10_000
  });

  try {
    await db.query("SELECT 1");
    return db;
  } catch (error) {
    await db.end();
    console.error("PostgreSQL connection failed:", error.code || error.name || "database error");
    throw new Error("Unable to connect to PostgreSQL. Verify DATABASE_URL and SSL settings.");
  }
}

export async function getGame(db, userId) {
  const { rows } = await db.query(
    `SELECT food, wood, gold, troops, health, farm, lumber, barracks, castle, victories,
            updated_at AS "updatedAt"
     FROM games WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}
