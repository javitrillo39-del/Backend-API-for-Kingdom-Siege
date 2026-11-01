import assert from "node:assert/strict";
import test from "node:test";
import { stableErrorResponse, toStableErrorCode } from "../src/errorCodes.js";

test("maps public API errors to stable codes", () => {
  const cases = [
    ["Not enough resources", "NOT_ENOUGH_RESOURCES"],
    ["Player not found", "PLAYER_NOT_FOUND"],
    ["A pending request already exists", "FRIEND_REQUEST_EXISTS"],
    ["Rate limit reached", "CHAT_RATE_LIMITED"],
    ["Invalid credentials", "INVALID_CREDENTIALS"],
    ["Server error", "INTERNAL_SERVER_ERROR"],
  ];

  for (const [message, code] of cases) {
    assert.equal(toStableErrorCode(message), code);
  }
});

test("preserves stable codes and hides unmapped English errors", () => {
  assert.equal(toStableErrorCode("CHAT_RATE_LIMITED"), "CHAT_RATE_LIMITED");
  assert.equal(toStableErrorCode("Unmapped internal detail"), "REQUEST_FAILED");
  assert.equal(toStableErrorCode(null), "REQUEST_FAILED");
});

test("normalizes error response bodies without changing status or metadata", () => {
  const response = {
    statusCode: 409,
    json(body) {
      return body;
    },
  };
  stableErrorResponse({}, response, () => {});

  assert.deepEqual(
    response.json({ error: "Not enough resources", required: { gold: 4 } }),
    { error: "NOT_ENOUGH_RESOURCES", required: { gold: 4 } },
  );
  response.statusCode = 200;
  assert.equal(response.json({ error: "success metadata" }).error, "success metadata");
});
