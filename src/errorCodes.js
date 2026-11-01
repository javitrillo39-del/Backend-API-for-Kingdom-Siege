const stableCodes = new Map(
  Object.entries({
    "authentication required": "AUTHENTICATION_REQUIRED",
    "invalid or expired token": "INVALID_OR_EXPIRED_TOKEN",
    "invalid credentials": "INVALID_CREDENTIALS",
    "username must be 3-20 letters, numbers or underscores": "USERNAME_INVALID",
    "password must contain at least 8 characters": "PASSWORD_TOO_SHORT",
    "username already exists": "USERNAME_EXISTS",
    "player profile not found": "PLAYER_PROFILE_NOT_FOUND",
    "unknown building": "BUILDING_UNKNOWN",
    "not enough resources": "NOT_ENOUGH_RESOURCES",
    "not enough gold": "NOT_ENOUGH_GOLD",
    "not enough food or gold": "NOT_ENOUGH_FOOD_OR_GOLD",
    "not enough wood": "NOT_ENOUGH_WOOD",
    "unknown enemy": "ENEMY_UNKNOWN",
    "kingdom cannot attack": "KINGDOM_CANNOT_ATTACK",
    "server error": "INTERNAL_SERVER_ERROR",
    "invalid search query or pagination": "INVALID_SEARCH_QUERY_OR_PAGINATION",
    "provide displayname and/or bio only": "INVALID_PROFILE_UPDATE",
    "display name must be 1-32 characters": "DISPLAY_NAME_INVALID",
    "bio must be at most 160 characters": "BIO_TOO_LONG",
    "invalid player id": "INVALID_PLAYER_ID",
    "player not found": "PLAYER_NOT_FOUND",
    "invalid pagination": "INVALID_PAGINATION",
    "valid playerid is required": "PLAYER_ID_REQUIRED",
    "cannot send a request to yourself": "CANNOT_ADD_SELF",
    "cannot send a request to this player": "PLAYER_BLOCKED",
    "players are already friends": "ALREADY_FRIENDS",
    "a pending request already exists": "FRIEND_REQUEST_EXISTS",
    "too many pending friend requests": "FRIEND_REQUEST_LIMIT_REACHED",
    "invalid request id": "INVALID_REQUEST_ID",
    "pending request not found": "FRIEND_REQUEST_NOT_FOUND",
    "cannot accept a request from this player": "PLAYER_BLOCKED",
    "cannot remove yourself as a friend": "CANNOT_REMOVE_SELF",
    "cannot block yourself": "CANNOT_BLOCK_SELF",
    "cannot unblock yourself": "CANNOT_UNBLOCK_SELF",
    "message must be plain text": "MESSAGE_PLAIN_TEXT_REQUIRED",
    "message cannot be empty": "MESSAGE_EMPTY",
    "message must be 300 characters or fewer": "MESSAGE_TOO_LONG",
    "message contains unsupported characters": "MESSAGE_UNSUPPORTED_CHARACTERS",
    "only plain text without html or links is allowed": "MESSAGE_LINKS_NOT_ALLOWED",
    "chat channel not found": "CHAT_CHANNEL_NOT_FOUND",
    "user blocked": "USER_BLOCKED",
    "private chat requires an active friendship": "FRIENDSHIP_REQUIRED",
    "rate limit reached": "CHAT_RATE_LIMITED",
    "repeated message spam is not allowed": "CHAT_REPEATED_MESSAGE_LIMITED",
    "cannot open a chat with yourself": "CANNOT_CHAT_SELF",
    "invalid message id": "INVALID_MESSAGE_ID",
    "invalid report reason or details": "INVALID_REPORT_DATA",
    "message not found": "MESSAGE_NOT_FOUND",
    "cannot mute yourself": "CANNOT_MUTE_SELF",
    "cannot unmute yourself": "CANNOT_UNMUTE_SELF"
  }),
);

export function toStableErrorCode(error) {
  if (typeof error !== "string") return "REQUEST_FAILED";
  const message = error.trim();
  if (/^[A-Z][A-Z0-9_]+$/.test(message)) return message;
  return stableCodes.get(message.toLowerCase()) || "REQUEST_FAILED";
}

export function stableErrorResponse(_req, res, next) {
  const sendJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 400 && typeof body?.error === "string") {
      return sendJson({ ...body, error: toStableErrorCode(body.error) });
    }
    return sendJson(body);
  };
  next();
}
