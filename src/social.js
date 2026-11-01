import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "./auth.js";
import { ensurePlayerProfile } from "./playerProfiles.js";

const MAX_PAGE = 10_000;
const MAX_LIMIT = 50;
const ONLINE_WINDOW_MINUTES = 5;
const REALM_NAME = "Realm 07";
const PUBLIC_PLAYER_ID_PATTERN = /^KS-[A-Z0-9]{8}$/i;

const asyncRoute = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const parseId = value => {
  if (!/^[1-9]\d*$/.test(String(value ?? ""))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

const isPlayerReference = value =>
  parseId(value) !== null ||
  (typeof value === "string" && PUBLIC_PLAYER_ID_PATTERN.test(value));

async function resolvePlayerId(db, value) {
  if (typeof value === "string" && PUBLIC_PLAYER_ID_PATTERN.test(value)) {
    const { rows } = await db.query(
      "SELECT user_id FROM player_profiles WHERE UPPER(public_player_id) = UPPER($1)",
      [value]
    );
    return rows[0]?.user_id ?? null;
  }
  return parseId(value);
}

const escapeLike = value => value.replace(/[\\%_]/g, character => `\\${character}`);

const parsePage = value => {
  if (value === undefined) return 1;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_PAGE ? page : null;
};

const parseLimit = value => {
  if (value === undefined) return 20;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_LIMIT ? limit : null;
};

const pageOptions = query => {
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit);
  if (page === null || limit === null) return null;
  return { page, limit, offset: (page - 1) * limit };
};

const validText = (value, maxLength, allowEmpty = false) => {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  return (allowEmpty || length > 0) &&
    length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(normalized);
};

const socialLimiter = (windowMs, limit) => rateLimit({
  windowMs,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.id)
});

async function withTransaction(db, operation) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Social transaction rollback failed:", rollbackError.code || "database error");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function isBlocked(db, playerA, playerB) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM blocked_users
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
     ) AS blocked`,
    [playerA, playerB]
  );
  return rows[0].blocked;
}

async function isBlockedBy(db, blockerId, blockedId) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2
     ) AS blocked`,
    [blockerId, blockedId]
  );
  return rows[0].blocked;
}

export function createSocialRouter(db) {
  const router = express.Router();
  const readLimiter = socialLimiter(60_000, 60);
  const writeLimiter = socialLimiter(15 * 60_000, 20);

  router.use(requireAuth);
  router.use(readLimiter);
  router.use(asyncRoute(async (req, res, next) => {
    await ensurePlayerProfile(db, req.user.id, req.user.username);
    next();
  }));

  const searchLimiter = socialLimiter(60_000, 30);

  router.get("/me/profile", asyncRoute(async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.public_player_id AS id, u.username, '07' AS realm,
              COALESCE(g.troops * 5 + g.castle * 20 + g.barracks * 8, 0) AS power,
              COALESCE(g.victories, 0) AS victories,
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online
       FROM users u
       JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN games g ON g.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Player profile not found" });
    res.json(rows[0]);
  }));

  router.get("/players/stats", asyncRoute(async (req, res) => {
    const { rows } = await db.query(
      "SELECT COUNT(*)::INTEGER AS \"registeredPlayers\" FROM users"
    );
    res.json(rows[0]);
  }));

  router.get("/players/search", searchLimiter, asyncRoute(async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const pagination = pageOptions(req.query);
    const publicIdSearch = PUBLIC_PLAYER_ID_PATTERN.test(query);
    if ((!/^[A-Za-z0-9_]{2,20}$/.test(query) && !publicIdSearch) || !pagination) {
      return res.status(400).json({ error: "Invalid search query or pagination" });
    }

    const { rows } = await db.query(
      `SELECT p.public_player_id AS id, u.username, '${REALM_NAME}' AS realm,
              COALESCE(p.display_name, u.username) AS "displayName",
              COALESCE(g.troops * 5 + g.castle * 20 + g.barracks * 8, 0) AS power,
              COALESCE(g.victories, 0) AS victories,
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online
       FROM users u
       JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN games g ON g.user_id = u.id
       WHERE u.id <> $1
         AND (
           ($2::BOOLEAN AND UPPER(p.public_player_id) = UPPER($3))
           OR (NOT $2::BOOLEAN AND LOWER(u.username) LIKE LOWER($4) ESCAPE E'\\\\')
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE b.blocker_id = u.id AND b.blocked_id = $1
         )
       ORDER BY u.username ASC
       LIMIT $5 OFFSET $6`,
      [
        req.user.id,
        publicIdSearch,
        query,
        `${escapeLike(query)}%`,
        pagination.limit,
        pagination.offset
      ]
    );
    res.json({
      players: rows,
      pagination: { page: pagination.page, limit: pagination.limit }
    });
  }));

  router.patch("/players/me", writeLimiter, asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const keys = Object.keys(body);
    if (!keys.length || keys.some(key => !["displayName", "bio"].includes(key))) {
      return res.status(400).json({ error: "Provide displayName and/or bio only" });
    }
    if ("displayName" in body && !validText(body.displayName, 32)) {
      return res.status(400).json({ error: "Display name must be 1-32 characters" });
    }
    if ("bio" in body && !validText(body.bio, 160, true)) {
      return res.status(400).json({ error: "Bio must be at most 160 characters" });
    }

    const { rows } = await db.query(
      `UPDATE player_profiles
       SET display_name = COALESCE($1, display_name),
           bio = COALESCE($2, bio),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3
       RETURNING display_name AS "displayName", bio`,
      [body.displayName?.trim() ?? null, body.bio?.trim() ?? null, req.user.id]
    );
    res.json({ profile: rows[0] });
  }));

  router.get("/players/:id", asyncRoute(async (req, res) => {
    if (!isPlayerReference(req.params.id)) return res.status(400).json({ error: "Invalid player id" });
    const playerId = await resolvePlayerId(db, req.params.id);
    if (playerId === null) return res.status(404).json({ error: "Player not found" });
    if (playerId !== req.user.id && await isBlockedBy(db, playerId, req.user.id)) {
      return res.status(404).json({ error: "Player not found" });
    }

    const { rows } = await db.query(
      `SELECT p.public_player_id AS id, u.username, '${REALM_NAME}' AS realm,
              COALESCE(p.display_name, u.username) AS "displayName",
              COALESCE(p.bio, '') AS bio,
              COALESCE(g.troops * 5 + g.castle * 20 + g.barracks * 8, 0) AS power,
              COALESCE(g.victories, 0) AS victories,
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online
       FROM users u
       JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN games g ON g.user_id = u.id
       WHERE u.id = $1`,
      [playerId]
    );
    if (!rows.length) return res.status(404).json({ error: "Player not found" });
    res.json({ player: rows[0] });
  }));

  router.get("/friends", asyncRoute(async (req, res) => {
    const pagination = pageOptions(req.query);
    if (!pagination) return res.status(400).json({ error: "Invalid pagination" });
    const { rows } = await db.query(
      `SELECT u.id, u.username, '${REALM_NAME}' AS realm,
              COALESCE(p.display_name, u.username) AS "displayName",
              COALESCE(g.troops * 5 + g.castle * 20 + g.barracks * 8, 0) AS power,
              COALESCE(g.victories, 0) AS victories,
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online,
              f.created_at AS "friendsSince"
       FROM friendships f
       JOIN users u ON u.id = CASE
         WHEN f.player_low_id = $1 THEN f.player_high_id
         ELSE f.player_low_id
       END
       LEFT JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN games g ON g.user_id = u.id
       WHERE (f.player_low_id = $1 OR f.player_high_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       ORDER BY u.username ASC
       LIMIT $2 OFFSET $3`,
      [req.user.id, pagination.limit, pagination.offset]
    );
    res.json({
      friends: rows,
      pagination: { page: pagination.page, limit: pagination.limit }
    });
  }));

  router.get("/friends/requests", asyncRoute(async (req, res) => {
    const pagination = pageOptions(req.query);
    if (!pagination) return res.status(400).json({ error: "Invalid pagination" });
    const { rows } = await db.query(
      `SELECT r.id, r.status, r.created_at AS "createdAt",
              CASE WHEN r.sender_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction,
              u.id AS "playerId", u.username, '${REALM_NAME}' AS realm,
              COALESCE(p.display_name, u.username) AS "displayName",
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online
       FROM friend_requests r
       JOIN users u ON u.id = CASE WHEN r.sender_id = $1 THEN r.recipient_id ELSE r.sender_id END
       LEFT JOIN player_profiles p ON p.user_id = u.id
       WHERE (r.sender_id = $1 OR r.recipient_id = $1)
         AND r.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, pagination.limit, pagination.offset]
    );
    res.json({
      requests: rows,
      pagination: { page: pagination.page, limit: pagination.limit }
    });
  }));

  router.post("/friends/requests", writeLimiter, asyncRoute(async (req, res) => {
    if (!isPlayerReference(req.body?.playerId)) {
      return res.status(400).json({ error: "Valid playerId is required" });
    }
    const playerId = await resolvePlayerId(db, req.body.playerId);
    if (playerId === null) return res.status(404).json({ error: "Player not found" });
    if (playerId === req.user.id) return res.status(400).json({ error: "Cannot send a request to yourself" });

    try {
      const request = await withTransaction(db, async client => {
        const target = await client.query("SELECT id FROM users WHERE id = $1", [playerId]);
        if (!target.rowCount) return { error: "Player not found", status: 404 };
        const blocked = await client.query(
          `SELECT 1 FROM blocked_users
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)`,
          [req.user.id, playerId]
        );
        if (blocked.rowCount) return { error: "Cannot send a request to this player", status: 409 };
        const friendship = await client.query(
          "SELECT 1 FROM friendships WHERE player_low_id = LEAST($1::integer, $2::integer) AND player_high_id = GREATEST($1::integer, $2::integer)",
          [req.user.id, playerId]
        );
        if (friendship.rowCount) return { error: "Players are already friends", status: 409 };
        const pending = await client.query(
          `SELECT 1 FROM friend_requests
           WHERE status = 'pending'
             AND LEAST(sender_id, recipient_id) = LEAST($1::integer, $2::integer)
             AND GREATEST(sender_id, recipient_id) = GREATEST($1::integer, $2::integer)`,
          [req.user.id, playerId]
        );
        if (pending.rowCount) return { error: "A pending request already exists", status: 409 };
        const pendingCount = await client.query(
          "SELECT COUNT(*)::INTEGER AS count FROM friend_requests WHERE sender_id = $1 AND status = 'pending'",
          [req.user.id]
        );
        if (pendingCount.rows[0].count >= 20) {
          return { error: "Too many pending friend requests", status: 429 };
        }

        const inserted = await client.query(
          `INSERT INTO friend_requests(sender_id, recipient_id)
           VALUES($1, $2)
           RETURNING id, status, created_at AS "createdAt"`,
          [req.user.id, playerId]
        );
        const created = inserted.rows[0];
        await client.query(
          `INSERT INTO notifications(user_id, actor_id, friend_request_id, type)
           VALUES($1, $2, $3, 'friend_request')
           ON CONFLICT DO NOTHING`,
          [playerId, req.user.id, created.id]
        );
        return { request: created };
      });

      if (request.error) return res.status(request.status).json({ error: request.error });
      res.status(201).json(request);
    } catch (error) {
      if (error.code === "23505" && error.constraint === "friend_requests_one_pending_per_pair") {
        return res.status(409).json({ error: "A pending request already exists" });
      }
      throw error;
    }
  }));

  router.post("/friends/requests/:id/accept", writeLimiter, asyncRoute(async (req, res) => {
    const requestId = parseId(req.params.id);
    if (requestId === null) return res.status(400).json({ error: "Invalid request id" });
    const result = await withTransaction(db, async client => {
      const { rows } = await client.query(
        `SELECT id, sender_id, recipient_id
         FROM friend_requests
         WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
         FOR UPDATE`,
        [requestId, req.user.id]
      );
      if (!rows.length) return { error: "Pending request not found", status: 404 };
      const request = rows[0];
      const blocked = await client.query(
        `SELECT 1 FROM blocked_users
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)`,
        [req.user.id, request.sender_id]
      );
      if (blocked.rowCount) return { error: "Cannot accept a request from this player", status: 409 };

      await client.query(
        `UPDATE friend_requests SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [request.id]
      );
      await client.query(
        `INSERT INTO friendships(player_low_id, player_high_id)
         VALUES(LEAST($1::integer, $2::integer), GREATEST($1::integer, $2::integer))
         ON CONFLICT DO NOTHING`,
        [request.sender_id, request.recipient_id]
      );
      await client.query(
        "DELETE FROM notifications WHERE friend_request_id = $1 AND type = 'friend_request'",
        [request.id]
      );
      await client.query(
        `INSERT INTO notifications(user_id, actor_id, friend_request_id, type)
         VALUES($1, $2, $3, 'friend_request_accepted')
         ON CONFLICT DO NOTHING`,
        [request.sender_id, req.user.id, request.id]
      );
      return { accepted: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }));

  router.post("/friends/requests/:id/reject", writeLimiter, asyncRoute(async (req, res) => {
    const requestId = parseId(req.params.id);
    if (requestId === null) return res.status(400).json({ error: "Invalid request id" });
    const result = await db.query(
      `UPDATE friend_requests SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
       RETURNING id`,
      [requestId, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Pending request not found" });
    await db.query(
      "DELETE FROM notifications WHERE friend_request_id = $1 AND type = 'friend_request'",
      [requestId]
    );
    res.json({ rejected: true });
  }));

  router.delete("/friends/:playerId", writeLimiter, asyncRoute(async (req, res) => {
    if (!isPlayerReference(req.params.playerId)) return res.status(400).json({ error: "Invalid player id" });
    const playerId = await resolvePlayerId(db, req.params.playerId);
    if (playerId === null) return res.status(404).json({ error: "Player not found" });
    if (playerId === req.user.id) return res.status(400).json({ error: "Cannot remove yourself as a friend" });
    await db.query(
      "DELETE FROM friendships WHERE player_low_id = LEAST($1::integer, $2::integer) AND player_high_id = GREATEST($1::integer, $2::integer)",
      [req.user.id, playerId]
    );
    res.status(204).end();
  }));

  router.post("/blocks/:playerId", writeLimiter, asyncRoute(async (req, res) => {
    if (!isPlayerReference(req.params.playerId)) return res.status(400).json({ error: "Invalid player id" });
    const playerId = await resolvePlayerId(db, req.params.playerId);
    if (playerId === null) return res.status(404).json({ error: "Player not found" });
    if (playerId === req.user.id) return res.status(400).json({ error: "Cannot block yourself" });

    const result = await withTransaction(db, async client => {
      const target = await client.query("SELECT id FROM users WHERE id = $1", [playerId]);
      if (!target.rowCount) return { error: "Player not found", status: 404 };
      await client.query(
        "INSERT INTO blocked_users(blocker_id, blocked_id) VALUES($1, $2) ON CONFLICT DO NOTHING",
        [req.user.id, playerId]
      );
      await client.query(
        "DELETE FROM friendships WHERE player_low_id = LEAST($1::integer, $2::integer) AND player_high_id = GREATEST($1::integer, $2::integer)",
        [req.user.id, playerId]
      );
      await client.query(
        `UPDATE friend_requests SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'pending'
           AND ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))`,
        [req.user.id, playerId]
      );
      await client.query(
        `DELETE FROM notifications
         WHERE (user_id = $1 AND actor_id = $2)
            OR (user_id = $2 AND actor_id = $1)`,
        [req.user.id, playerId]
      );
      return { blocked: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }));

  router.delete("/blocks/:playerId", writeLimiter, asyncRoute(async (req, res) => {
    if (!isPlayerReference(req.params.playerId)) return res.status(400).json({ error: "Invalid player id" });
    const playerId = await resolvePlayerId(db, req.params.playerId);
    if (playerId === null) return res.status(404).json({ error: "Player not found" });
    if (playerId === req.user.id) return res.status(400).json({ error: "Cannot unblock yourself" });
    await db.query(
      "DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2",
      [req.user.id, playerId]
    );
    res.status(204).end();
  }));

  router.get("/blocks", asyncRoute(async (req, res) => {
    const pagination = pageOptions(req.query);
    if (!pagination) return res.status(400).json({ error: "Invalid pagination" });
    const { rows } = await db.query(
      `SELECT u.id, u.username, '${REALM_NAME}' AS realm,
              COALESCE(p.display_name, u.username) AS "displayName",
              COALESCE(g.troops * 5 + g.castle * 20 + g.barracks * 8, 0) AS power,
              COALESCE(g.victories, 0) AS victories,
              COALESCE(p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '${ONLINE_WINDOW_MINUTES} minutes', FALSE) AS online,
              b.created_at AS "blockedAt"
       FROM blocked_users b
       JOIN users u ON u.id = b.blocked_id
       LEFT JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN games g ON g.user_id = u.id
       WHERE b.blocker_id = $1
       ORDER BY u.username ASC
       LIMIT $2 OFFSET $3`,
      [req.user.id, pagination.limit, pagination.offset]
    );
    res.json({
      blockedPlayers: rows,
      pagination: { page: pagination.page, limit: pagination.limit }
    });
  }));

  router.get("/notifications", asyncRoute(async (req, res) => {
    const pagination = pageOptions(req.query);
    if (!pagination) return res.status(400).json({ error: "Invalid pagination" });
    const { rows } = await db.query(
      `SELECT n.id, n.type, n.friend_request_id AS "requestId",
              n.created_at AS "createdAt", n.read_at AS "readAt",
              u.id AS "actorId", u.username AS "actorUsername",
              COALESCE(p.display_name, u.username) AS "actorDisplayName",
              '${REALM_NAME}' AS realm
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN player_profiles p ON p.user_id = u.id
       WHERE n.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id)
              OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id)
         )
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, pagination.limit, pagination.offset]
    );
    res.json({
      notifications: rows,
      pagination: { page: pagination.page, limit: pagination.limit }
    });
  }));

  return router;
}
