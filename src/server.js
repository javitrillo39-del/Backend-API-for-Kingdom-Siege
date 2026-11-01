import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { createDb, getGame } from "./db.js";
import { requireAuth, signPresenceToken, signToken } from "./auth.js";
import { ensurePlayerProfile } from "./playerProfiles.js";
import { createSocialRouter } from "./social.js";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required. Copy .env.example to .env.");
const db = await createDb();
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const configuredFrontendOrigins = process.env.FRONTEND_ORIGINS
  ?.split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const frontendOrigins = configuredFrontendOrigins?.length
  ? [...new Set(configuredFrontendOrigins)]
  : [...new Set([
      "http://localhost:5173",
      "https://kingdom-siege-game.onrender.com",
      ...(process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN.trim()] : [])
    ].filter(Boolean))];
app.use(cors({ origin: frontendOrigins }));
app.use(express.json({ limit: "32kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const buildings = {
  farm: { baseCost: 60 }, lumber: { baseCost: 70 }, barracks: { baseCost: 100 }, castle: { baseCost: 180 }
};
const enemies = {
  goblin: { name: "Goblin Camp", power: 30, reward: 70 },
  bandit: { name: "Bandit Fort", power: 85, reward: 160 },
  shadow: { name: "Shadow Keep", power: 180, reward: 350 }
};
const powerOf = g => g.troops * 5 + g.castle * 20 + g.barracks * 8;
const cleanName = value => typeof value === "string" ? value.trim() : "";
const presenceSections = new Set(["City", "Army", "Map", "Social"]);
const presenceLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.id)
});

async function updateLastSeen(userId, force = false) {
  const { rows } = await db.query(
    `UPDATE player_profiles
     SET last_seen_at = CASE
       WHEN $2::BOOLEAN OR last_seen_at IS NULL
         OR last_seen_at <= CURRENT_TIMESTAMP - INTERVAL '1 minute'
       THEN CURRENT_TIMESTAMP
       ELSE last_seen_at
     END
     WHERE user_id = $1
     RETURNING last_seen_at AS "lastSeenAt"`,
    [userId, force]
  );
  return rows[0] ?? null;
}

function validPresenceRequest(body) {
  return body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    presenceSections.has(body.activeSection);
}

app.get("/api/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, service: "kingdom-siege-api" });
  } catch (error) {
    console.error("PostgreSQL health check failed:", error.code || "database error");
    res.status(503).json({ ok: false, service: "kingdom-siege-api", database: "unavailable" });
  }
});

app.post("/api/auth/register", route(async (req, res) => {
  const username = cleanName(req.body.username);
  const password = String(req.body.password || "");
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Username must be 3-20 letters, numbers or underscores" });
  if (password.length < 8) return res.status(400).json({ error: "Password must contain at least 8 characters" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const hash = await bcrypt.hash(password, 12);
    const inserted = await client.query(
      "INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id, username",
      [username, hash]
    );
    const user = inserted.rows[0];
    await ensurePlayerProfile(client, user.id, user.username);
    await client.query("INSERT INTO games(user_id) VALUES($1)", [user.id]);
    await client.query("COMMIT");
    res.status(201).json({ token: signToken(user), user, game: await getGame(db, user.id) });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Registration rollback failed:", rollbackError.code || "database error");
    }
    if (error.code === "23505") return res.status(409).json({ error: "Username already exists" });
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/auth/login", route(async (req, res) => {
  const username = cleanName(req.body.username);
  const { rows } = await db.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user), user: { id: user.id, username: user.username }, game: await getGame(db, user.id) });
}));

app.get("/api/game", requireAuth, route(async (req, res) => res.json({
  user: { id: req.user.id, username: req.user.username },
  game: await getGame(db, req.user.id)
})));

app.post("/api/presence/session", requireAuth, presenceLimiter, route(async (req, res) => {
  if (!process.env.SUPABASE_JWT_SECRET) {
    return res.status(503).json({ error: "Realtime presence is not configured" });
  }
  if (!validPresenceRequest(req.body)) {
    return res.status(400).json({ error: "A valid activeSection is required" });
  }

  await ensurePlayerProfile(db, req.user.id, req.user.username);
  const lastSeen = await updateLastSeen(req.user.id);
  if (!lastSeen) return res.status(404).json({ error: "Player profile not found" });
  const { rows } = await db.query(
    `SELECT p.public_player_id AS "publicPlayerId", u.username
     FROM player_profiles p
     JOIN users u ON u.id = p.user_id
     WHERE p.user_id = $1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Player profile not found" });

  res.json({
    accessToken: signPresenceToken(rows[0].publicPlayerId),
    presence: {
      publicPlayerId: rows[0].publicPlayerId,
      username: rows[0].username,
      realm: "07",
      activeSection: req.body.activeSection
    }
  });
}));

app.patch("/api/presence/session", requireAuth, presenceLimiter, route(async (req, res) => {
  if (!validPresenceRequest(req.body)) {
    return res.status(400).json({ error: "A valid activeSection is required" });
  }
  const lastSeen = await updateLastSeen(req.user.id);
  if (!lastSeen) return res.status(404).json({ error: "Player profile not found" });
  res.json({ lastSeenAt: lastSeen.lastSeenAt });
}));

app.delete("/api/presence/session", requireAuth, presenceLimiter, route(async (req, res) => {
  const lastSeen = await updateLastSeen(req.user.id, true);
  if (!lastSeen) return res.status(404).json({ error: "Player profile not found" });
  res.status(204).end();
}));

app.post("/api/game/upgrade", requireAuth, route(async (req, res) => {
  const type = req.body.type;
  if (!buildings[type]) return res.status(400).json({ error: "Unknown building" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM games WHERE user_id = $1 FOR UPDATE", [req.user.id]);
    const game = rows[0];
    const cost = buildings[type].baseCost * game[type];
    const goldCost = Math.ceil(cost / 2);
    if (game.wood < cost || game.gold < goldCost) {
      await client.query("COMMIT");
      return res.status(409).json({ error: "Not enough resources", required: { wood: cost, gold: goldCost } });
    }
    await client.query(
      `UPDATE games SET wood=wood-$1, gold=gold-$2, ${type}=${type}+1,
       updated_at=TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
       WHERE user_id=$3`,
      [cost, goldCost, req.user.id]
    );
    await client.query("COMMIT");
    res.json({ game: await getGame(db, req.user.id), message: `${type} upgraded` });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Upgrade rollback failed:", rollbackError.code || "database error");
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/game/train", requireAuth, route(async (req, res) => {
  const amount = 5;
  const result = await db.query(
    `UPDATE games SET food=food-50, gold=gold-20, troops=troops+$1,
     updated_at=TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
     WHERE user_id=$2 AND food>=50 AND gold>=20`,
    [amount, req.user.id]
  );
  if (!result.rowCount) return res.status(409).json({ error: "Not enough food or gold" });
  res.json({ game: await getGame(db, req.user.id), message: "Five troops trained" });
}));

app.post("/api/game/repair", requireAuth, route(async (req, res) => {
  const result = await db.query(
    `UPDATE games SET wood=wood-40, health=LEAST(100,health+25),
     updated_at=TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
     WHERE user_id=$1 AND wood>=40`,
    [req.user.id]
  );
  if (!result.rowCount) return res.status(409).json({ error: "Not enough wood" });
  res.json({ game: await getGame(db, req.user.id), message: "Walls repaired" });
}));

app.post("/api/game/attack", requireAuth, route(async (req, res) => {
  const enemy = enemies[req.body.enemyId];
  if (!enemy) return res.status(400).json({ error: "Unknown enemy" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM games WHERE user_id = $1 FOR UPDATE", [req.user.id]);
    const game = rows[0];
    if (game.health <= 0 || game.troops < 1) {
      await client.query("COMMIT");
      return res.status(409).json({ error: "Kingdom cannot attack" });
    }
    const power = powerOf(game);
    const loss = Math.max(1, Math.ceil((enemy.power / Math.max(12, power)) * 5));
    const won = power >= enemy.power;
    await client.query(
      `UPDATE games SET troops=GREATEST(0,troops-$1), gold=gold+$2,
       health=GREATEST(0,health-$3), victories=victories+$4,
       updated_at=TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
       WHERE user_id=$5`,
      [loss, won ? enemy.reward : 0, won ? 0 : 12, won ? 1 : 0, req.user.id]
    );
    await client.query("COMMIT");
    res.json({ won, enemy: enemy.name, loss, reward: won ? enemy.reward : 0, game: await getGame(db, req.user.id) });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Attack rollback failed:", rollbackError.code || "database error");
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/game/collect", requireAuth, route(async (req, res) => {
  const seconds = Math.max(1, Math.min(60, Number(req.body.seconds) || 1));
  await db.query(
    `UPDATE games SET food=food+farm*8*$1, wood=wood+lumber*6*$1,
     gold=gold+castle*2*$1,
     updated_at=TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
     WHERE user_id=$2`,
    [seconds, req.user.id]
  );
  res.json({ game: await getGame(db, req.user.id) });
}));

app.get("/api/ranking", route(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.username, g.victories,
     (g.troops*5 + g.castle*20 + g.barracks*8) AS power
     FROM games g JOIN users u ON u.id=g.user_id
     ORDER BY power DESC, victories DESC LIMIT 50`
  );
  res.json({ ranking: rows });
}));

app.use("/api", createSocialRouter(db));

app.use((err, req, res, next) => {
  console.error("API request failed:", err.code || "unexpected error");
  res.status(500).json({ error: "Server error" });
});

const port = Number(process.env.PORT) || 3001;
const server = app.listen(port, () => console.log(`Kingdom Siege API running at http://localhost:${port}`));
server.on("close", () => db.end());
