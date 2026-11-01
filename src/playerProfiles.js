import { randomInt } from "node:crypto";

const PLAYER_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PLAYER_ID_ATTEMPTS = 10;

function generatePublicPlayerId() {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += PLAYER_ID_ALPHABET[randomInt(PLAYER_ID_ALPHABET.length)];
  }
  return `KS-${suffix}`;
}

export async function ensurePlayerProfile(db, userId, username) {
  for (let attempt = 0; attempt < PLAYER_ID_ATTEMPTS; attempt += 1) {
    const inserted = await db.query(
      `INSERT INTO player_profiles(user_id, display_name, public_player_id)
       VALUES($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING public_player_id`,
      [userId, username, generatePublicPlayerId()]
    );
    if (inserted.rowCount) return inserted.rows[0].public_player_id;

    const existing = await db.query(
      "SELECT public_player_id FROM player_profiles WHERE user_id = $1",
      [userId]
    );
    if (existing.rowCount) return existing.rows[0].public_player_id;
  }

  throw new Error("Unable to allocate a unique public player ID.");
}
