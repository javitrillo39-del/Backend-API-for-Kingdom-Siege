import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "./auth.js";

const MAX_LIMIT = 50;
const MAX_PAGE = 10_000;
const PUBLIC_PLAYER_ID_PATTERN = /^KS-[A-Z0-9]{8}$/i;
const REPORT_REASONS = new Set(["spam", "harassment", "inappropriate", "other"]);

const asyncRoute = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const userLimiter = (windowMs, limit) => rateLimit({
  windowMs,
  limit,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => String(req.user.id),
  handler: (_req, res) => res.status(429).json({ error: "CHAT_RATE_LIMITED" })
});

function parsePage(value) {
  if (value === undefined) return 1;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page <= MAX_PAGE ? page : null;
}

function parseLimit(value) {
  if (value === undefined) return MAX_LIMIT;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit <= MAX_LIMIT ? limit : null;
}

function cleanMessage(value) {
  if (typeof value !== "string") return { error: "Message must be plain text" };
  const text = value.trim();
  const length = Array.from(text).length;
  if (!length) return { error: "Message cannot be empty" };
  if (length > 300) return { error: "Message must be 300 characters or fewer" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    return { error: "Message contains unsupported characters" };
  }
  if (/[<>]/u.test(text) ||
      /(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:www|mailto|javascript|data):|\b(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/\S*)?|\]\s*\([^)]*\))/iu.test(text)) {
    return { error: "Only plain text without HTML or links is allowed" };
  }
  return { text };
}

async function transaction(db, operation) {
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
      console.error("Chat transaction rollback failed:", rollbackError.code || "database error");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getPlayerByPublicId(db, publicPlayerId) {
  if (!PUBLIC_PLAYER_ID_PATTERN.test(publicPlayerId)) return null;
  const { rows } = await db.query(
    `SELECT u.id, p.public_player_id AS "publicPlayerId", u.username, p.realm,
            CASE
              WHEN p.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '90 seconds'
                AND (p.last_logout_at IS NULL OR p.last_seen_at > p.last_logout_at)
              THEN TRUE ELSE FALSE
            END AS online
     FROM users u
     JOIN player_profiles p ON p.user_id = u.id
     WHERE UPPER(p.public_player_id) = UPPER($1)`,
    [publicPlayerId]
  );
  return rows[0] ?? null;
}

async function findChannel(db, channelId) {
  if (!/^[1-9]\d*$/.test(String(channelId))) return null;
  const { rows } = await db.query(
    `SELECT id, channel_type AS "channelType", realm, player_low_id AS "playerLowId",
            player_high_id AS "playerHighId"
     FROM chat_channels
     WHERE id = $1`,
    [String(channelId)]
  );
  return rows[0] ?? null;
}

async function canReadChannel(db, channel, userId) {
  if (!channel) return false;
  if (channel.channelType === "global") return true;
  if (channel.channelType === "realm") {
    const { rows } = await db.query(
      "SELECT realm FROM player_profiles WHERE user_id = $1",
      [userId]
    );
    return rows[0]?.realm === channel.realm;
  }
  if (channel.channelType !== "private") return false;

  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM chat_channel_members m
       JOIN friendships f
         ON f.player_low_id = LEAST($1::integer, $2::integer)
        AND f.player_high_id = GREATEST($1::integer, $2::integer)
       WHERE m.channel_id = $3
         AND m.user_id = $1
         AND EXISTS (
           SELECT 1 FROM chat_channel_members other_member
           WHERE other_member.channel_id = m.channel_id
             AND other_member.user_id = $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
              OR (b.blocker_id = $2 AND b.blocked_id = $1)
         )
     ) AS allowed`,
    [userId, channel.playerLowId === userId ? channel.playerHighId : channel.playerLowId, channel.id]
  );
  return rows[0]?.allowed === true;
}

async function checkPrivatePermission(db, userId, targetId) {
  const { rows } = await db.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM friendships
         WHERE player_low_id = LEAST($1::integer, $2::integer)
           AND player_high_id = GREATEST($1::integer, $2::integer)
       ) AS friends,
       EXISTS (
         SELECT 1 FROM blocked_users
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)
       ) AS blocked`,
    [userId, targetId]
  );
  return rows[0];
}

export function createChatRouter(db) {
  const router = express.Router();
  const readLimiter = userLimiter(60_000, 90);
  const writeLimiter = userLimiter(60_000, 30);
  const privateLimiter = userLimiter(60_000, 20);
  const messageLimiter = userLimiter(10_000, 5);
  const reportLimiter = userLimiter(60_000, 10);

  router.use(requireAuth, readLimiter);

  router.get("/chat/channels", asyncRoute(async (req, res) => {
    const { rows: profileRows } = await db.query(
      `SELECT realm FROM player_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    if (!profileRows.length) return res.status(404).json({ error: "Player profile not found" });
    const realm = profileRows[0].realm;
    const { rows: channels } = await db.query(
      `SELECT id, channel_type AS "channelType", realm
       FROM chat_channels
       WHERE channel_type = 'global'
          OR (channel_type = 'realm' AND realm = $1)
       ORDER BY CASE channel_type WHEN 'global' THEN 0 ELSE 1 END`,
      [realm]
    );
    const { rows: privatePlayers } = await db.query(
      `SELECT p.public_player_id AS "publicPlayerId", u.username, p.realm,
              CASE
                WHEN p.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '90 seconds'
                  AND (p.last_logout_at IS NULL OR p.last_seen_at > p.last_logout_at)
                THEN TRUE ELSE FALSE
              END AS online,
              c.id AS "channelId"
       FROM friendships f
       JOIN users u ON u.id = CASE
         WHEN f.player_low_id = $1 THEN f.player_high_id ELSE f.player_low_id
       END
       JOIN player_profiles p ON p.user_id = u.id
       LEFT JOIN chat_channels c
         ON c.channel_type = 'private'
        AND c.player_low_id = LEAST($1::integer, u.id)
        AND c.player_high_id = GREATEST($1::integer, u.id)
       WHERE (f.player_low_id = $1 OR f.player_high_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       ORDER BY u.username ASC
       LIMIT 100`,
      [req.user.id]
    );
    const { rows: conversations } = await db.query(
      `SELECT c.id, c.channel_type AS type, peer.public_player_id AS "publicPlayerId",
              peer_user.username,
              CASE
                WHEN peer.last_seen_at > CURRENT_TIMESTAMP - INTERVAL '90 seconds'
                  AND (peer.last_logout_at IS NULL OR peer.last_seen_at > peer.last_logout_at)
                THEN TRUE ELSE FALSE
              END AS online
       FROM chat_channel_members m
       JOIN chat_channels c ON c.id = m.channel_id AND c.channel_type = 'private'
       JOIN users peer_user ON peer_user.id = CASE
         WHEN c.player_low_id = $1 THEN c.player_high_id ELSE c.player_low_id
       END
       JOIN player_profiles peer ON peer.user_id = peer_user.id
       WHERE m.user_id = $1
         AND (c.player_low_id = $1 OR c.player_high_id = $1)
         AND EXISTS (
           SELECT 1 FROM friendships f
           WHERE f.player_low_id = c.player_low_id AND f.player_high_id = c.player_high_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = peer_user.id)
              OR (b.blocker_id = peer_user.id AND b.blocked_id = $1)
         )
       ORDER BY c.created_at DESC
       LIMIT 100`,
      [req.user.id]
    );
    const { rows: mutedPlayers } = await db.query(
      `SELECT p.public_player_id AS "publicPlayerId", u.username
       FROM muted_users m
       JOIN users u ON u.id = m.muted_user_id
       JOIN player_profiles p ON p.user_id = u.id
       WHERE m.muter_user_id = $1
       ORDER BY u.username ASC
       LIMIT 100`,
      [req.user.id]
    );
    res.json({
      channels: channels.map(channel => ({
        id: channel.id,
        type: channel.channelType,
        name: channel.channelType === "global" ? "Global" : `Realm ${channel.realm}`,
        realm: channel.realm
      })),
      privatePlayers,
      conversations,
      mutedPlayers
    });
  }));

  router.get("/chat/channels/:channelId/messages", asyncRoute(async (req, res) => {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    if (page === null || limit === null) return res.status(400).json({ error: "Invalid pagination" });
    const channel = await findChannel(db, req.params.channelId);
    if (!await canReadChannel(db, channel, req.user.id)) {
      return res.status(404).json({ error: "Chat channel not found" });
    }
    const { rows } = await db.query(
      `SELECT m.id, m.message_text AS "messageText", m.created_at AS "createdAt",
              m.edited_at AS "editedAt", m.moderation_status AS "moderationStatus",
              p.public_player_id AS "publicPlayerId", u.username
       FROM chat_messages m
       JOIN users u ON u.id = m.sender_user_id
       JOIN player_profiles p ON p.user_id = u.id
       WHERE m.channel_id = $1
         AND m.deleted_at IS NULL
         AND m.moderation_status <> 'removed'
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $2 AND b.blocked_id = m.sender_user_id)
              OR (b.blocker_id = m.sender_user_id AND b.blocked_id = $2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM muted_users mu
           WHERE mu.muter_user_id = $2 AND mu.muted_user_id = m.sender_user_id
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3 OFFSET $4`,
      [channel.id, req.user.id, limit, (page - 1) * limit]
    );
    res.json({
      messages: rows.reverse(),
      pagination: { page, limit }
    });
  }));

  router.post("/chat/channels/:channelId/messages", messageLimiter, writeLimiter, asyncRoute(async (req, res) => {
    const validated = cleanMessage(req.body?.messageText);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const channel = await findChannel(db, req.params.channelId);
    if (!await canReadChannel(db, channel, req.user.id)) {
      return res.status(404).json({ error: "Chat channel not found" });
    }

    const outcome = await transaction(db, async client => {
      await client.query("SELECT pg_advisory_xact_lock(74621, $1::integer)", [req.user.id]);
      if (channel.channelType === "private") {
        const peerId = channel.playerLowId === req.user.id ? channel.playerHighId : channel.playerLowId;
        const permission = await checkPrivatePermission(client, req.user.id, peerId);
        if (permission.blocked) return { status: 409, error: "User blocked" };
        if (!permission.friends) return { status: 403, error: "Private chat requires an active friendship" };
      }

      const { rows: rateRows } = await client.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM chat_messages
         WHERE sender_user_id = $1
           AND created_at > CURRENT_TIMESTAMP - INTERVAL '10 seconds'`,
        [req.user.id]
      );
      if (rateRows[0].count >= 5) return { status: 429, error: "Rate limit reached" };

      const { rows: repeatRows } = await client.query(
        `SELECT COUNT(*)::INTEGER AS count
         FROM chat_messages
         WHERE sender_user_id = $1
           AND message_text = $2
           AND created_at > CURRENT_TIMESTAMP - INTERVAL '60 seconds'`,
        [req.user.id, validated.text]
      );
      if (repeatRows[0].count >= 2) return { status: 429, error: "Repeated message spam is not allowed" };

      const { rows } = await client.query(
        `INSERT INTO chat_messages(channel_id, sender_user_id, message_text)
         VALUES($1, $2, $3)
         RETURNING id, message_text AS "messageText", created_at AS "createdAt",
                   edited_at AS "editedAt", moderation_status AS "moderationStatus"`,
        [channel.id, req.user.id, validated.text]
      );
      return { message: rows[0] };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    const { rows: senderRows } = await db.query(
      `SELECT p.public_player_id AS "publicPlayerId", u.username
       FROM users u JOIN player_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [req.user.id]
    );
    res.status(201).json({ message: { ...outcome.message, ...senderRows[0] } });
  }));

  router.post("/chat/private/:publicPlayerId", privateLimiter, asyncRoute(async (req, res) => {
    const target = await getPlayerByPublicId(db, req.params.publicPlayerId);
    if (!target) return res.status(404).json({ error: "Player not found" });
    if (target.id === req.user.id) return res.status(400).json({ error: "Cannot open a chat with yourself" });

    const outcome = await transaction(db, async client => {
      await client.query(
        "SELECT pg_advisory_xact_lock(74622, LEAST($1::integer, $2::integer))",
        [req.user.id, target.id]
      );
      const permission = await checkPrivatePermission(client, req.user.id, target.id);
      if (permission.blocked) return { status: 409, error: "User blocked" };
      if (!permission.friends) return { status: 403, error: "Private chat requires an active friendship" };

      let { rows } = await client.query(
        `SELECT id FROM chat_channels
         WHERE channel_type = 'private'
           AND player_low_id = LEAST($1::integer, $2::integer)
           AND player_high_id = GREATEST($1::integer, $2::integer)`,
        [req.user.id, target.id]
      );
      let channelId = rows[0]?.id;
      if (!channelId) {
        ({ rows } = await client.query(
          `INSERT INTO chat_channels(channel_type, player_low_id, player_high_id)
           VALUES('private', LEAST($1::integer, $2::integer), GREATEST($1::integer, $2::integer))
           ON CONFLICT (player_low_id, player_high_id) WHERE channel_type = 'private' DO NOTHING
           RETURNING id`,
          [req.user.id, target.id]
        ));
        channelId = rows[0]?.id;
      }
      if (!channelId) {
        ({ rows } = await client.query(
          `SELECT id FROM chat_channels
           WHERE channel_type = 'private'
             AND player_low_id = LEAST($1::integer, $2::integer)
             AND player_high_id = GREATEST($1::integer, $2::integer)`,
          [req.user.id, target.id]
        ));
        channelId = rows[0]?.id;
      }
      await client.query(
        `INSERT INTO chat_channel_members(channel_id, user_id)
         VALUES($1, $2), ($1, $3)
         ON CONFLICT DO NOTHING`,
        [channelId, req.user.id, target.id]
      );
      return { channelId };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    res.json({
      channel: {
        id: outcome.channelId,
        type: "private",
        publicPlayerId: target.publicPlayerId,
        username: target.username,
        online: target.online
      }
    });
  }));

  router.post("/chat/messages/:messageId/report", reportLimiter, asyncRoute(async (req, res) => {
    const messageId = req.params.messageId;
    if (!/^[1-9]\d*$/.test(messageId)) return res.status(400).json({ error: "Invalid message id" });
    const reason = req.body?.reason;
    const rawDetails = req.body?.details;
    if (rawDetails !== undefined && typeof rawDetails !== "string") {
      return res.status(400).json({ error: "Invalid report reason or details" });
    }
    const details = rawDetails?.trim() ?? "";
    if (!REPORT_REASONS.has(reason) || Array.from(details).length > 300) {
      return res.status(400).json({ error: "Invalid report reason or details" });
    }
    const { rows: messageRows } = await db.query(
      `SELECT m.id, m.channel_id AS "channelId"
       FROM chat_messages m
       WHERE m.id = $1
         AND m.deleted_at IS NULL
         AND m.moderation_status <> 'removed'
         AND NOT EXISTS (
           SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $2 AND b.blocked_id = m.sender_user_id)
              OR (b.blocker_id = m.sender_user_id AND b.blocked_id = $2)
         )
         AND NOT EXISTS (
           SELECT 1 FROM muted_users mu
           WHERE mu.muter_user_id = $2 AND mu.muted_user_id = m.sender_user_id
         )`,
      [messageId, req.user.id]
    );
    if (!messageRows.length) return res.status(404).json({ error: "Message not found" });
    const channel = await findChannel(db, messageRows[0].channelId);
    if (!await canReadChannel(db, channel, req.user.id)) {
      return res.status(404).json({ error: "Message not found" });
    }
    const { rows } = await db.query(
      `INSERT INTO message_reports(message_id, reporter_user_id, reason, details)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (message_id, reporter_user_id)
       DO UPDATE SET reason = EXCLUDED.reason, details = EXCLUDED.details
       RETURNING id, status, created_at AS "createdAt"`,
      [messageId, req.user.id, reason, details]
    );
    await db.query(
      `UPDATE chat_messages
       SET moderation_status = 'reported'
       WHERE id = $1 AND moderation_status = 'visible'`,
      [messageId]
    );
    res.status(201).json({ report: rows[0] });
  }));

  router.post("/chat/mute/:publicPlayerId", writeLimiter, asyncRoute(async (req, res) => {
    const target = await getPlayerByPublicId(db, req.params.publicPlayerId);
    if (!target) return res.status(404).json({ error: "Player not found" });
    if (target.id === req.user.id) return res.status(400).json({ error: "Cannot mute yourself" });
    await db.query(
      `INSERT INTO muted_users(muter_user_id, muted_user_id)
       VALUES($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, target.id]
    );
    res.status(204).end();
  }));

  router.delete("/chat/mute/:publicPlayerId", writeLimiter, asyncRoute(async (req, res) => {
    const target = await getPlayerByPublicId(db, req.params.publicPlayerId);
    if (!target) return res.status(404).json({ error: "Player not found" });
    if (target.id === req.user.id) return res.status(400).json({ error: "Cannot unmute yourself" });
    await db.query(
      "DELETE FROM muted_users WHERE muter_user_id = $1 AND muted_user_id = $2",
      [req.user.id, target.id]
    );
    res.status(204).end();
  }));

  return router;
}
