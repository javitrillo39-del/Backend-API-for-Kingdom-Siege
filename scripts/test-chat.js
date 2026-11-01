import "dotenv/config";
import http from "node:http";
import { createDb } from "../src/db.js";

const port = Number(process.env.PORT) || 3001;
const apiPath = "/api";
const suffix = Math.random().toString(36).slice(2, 10);
const usernames = [`chat_a_${suffix}`, `chat_b_${suffix}`, `chat_c_${suffix}`];
const createdUsers = [];
let temporaryRealmChannelCreated = false;
let passed = 0;

function request(path, { method = "GET", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request({
      hostname: "localhost",
      port,
      method,
      path: `${apiPath}${path}`,
      headers
    }, response => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = raw;
        }
        resolve({ status: response.statusCode, data });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function check(condition, name) {
  if (!condition) throw new Error(`Failed: ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

async function expectStatus(path, expected, options = {}) {
  const response = await request(path, options);
  check(
    response.status === expected,
    `${options.method || "GET"} ${path} expected ${expected}, got ${response.status}${response.data?.error ? `: ${response.data.error}` : ""}`
  );
  return response;
}

async function dbQuery(sql, values = []) {
  const db = await createDb();
  try {
    return await db.query(sql, values);
  } finally {
    await db.end();
  }
}

try {
  await expectStatus("/chat/channels", 401);
  const accountA = await expectStatus("/auth/register", 201, {
    method: "POST",
    body: { username: usernames[0], password: "ChatTestPassword_123" }
  });
  createdUsers.push(usernames[0]);
  const accountB = await expectStatus("/auth/register", 201, {
    method: "POST",
    body: { username: usernames[1], password: "ChatTestPassword_456" }
  });
  createdUsers.push(usernames[1]);
  const accountC = await expectStatus("/auth/register", 201, {
    method: "POST",
    body: { username: usernames[2], password: "ChatTestPassword_789" }
  });
  createdUsers.push(usernames[2]);
  const tokenA = accountA.data.token;
  const tokenB = accountB.data.token;
  const tokenC = accountC.data.token;
  const profileA = await expectStatus("/me/profile", 200, { token: tokenA });
  const profileB = await expectStatus("/me/profile", 200, { token: tokenB });
  const profileC = await expectStatus("/me/profile", 200, { token: tokenC });

  const channelsA = await expectStatus("/chat/channels", 200, { token: tokenA });
  const channelsB = await expectStatus("/chat/channels", 200, { token: tokenB });
  const channelsC = await expectStatus("/chat/channels", 200, { token: tokenC });
  const global = channelsA.data.channels.find(channel => channel.type === "global");
  const realmA = channelsA.data.channels.find(channel => channel.type === "realm");
  const globalPath = `/chat/channels/${global.id}/messages`;
  check(Boolean(global && realmA), "authenticated channels include Global and the server profile realm");

  await expectStatus(globalPath, 401, {
    method: "POST",
    body: { messageText: "unauthenticated message" }
  });
  const globalMessage = await expectStatus(globalPath, 201, {
    method: "POST",
    token: tokenA,
    body: { messageText: "hello global chat", sender_user_id: accountB.data.user.id }
  });
  check(
    globalMessage.data.message.username === usernames[0] &&
      globalMessage.data.message.publicPlayerId === profileA.data.publicPlayerId &&
      !("sender_user_id" in globalMessage.data.message) &&
      !("senderUserId" in globalMessage.data.message),
    "global message exposes public sender identity only"
  );
  const globalHistoryB = await expectStatus(globalPath, 200, { token: tokenB });
  check(globalHistoryB.data.messages.some(message => message.id === globalMessage.data.message.id), "another authenticated account sees the global message");
  const globalHistoryC = await expectStatus(globalPath, 200, { token: tokenC });
  check(globalHistoryC.data.messages.some(message => message.id === globalMessage.data.message.id), "a third authenticated account sees the global message");
  const reloadHistory = await expectStatus(`${globalPath}?page=1&limit=50`, 200, { token: tokenA });
  check(reloadHistory.data.messages.some(message => message.id === globalMessage.data.message.id), "message history persists after reloading");
  await expectStatus(`${globalPath}?page=1&limit=51`, 400, { token: tokenA });

  await expectStatus(globalPath, 400, { method: "POST", token: tokenC, body: { messageText: "   " } });
  await expectStatus(globalPath, 400, { method: "POST", token: tokenC, body: { messageText: "<script>alert(1)</script>" } });
  await expectStatus(globalPath, 400, { method: "POST", token: tokenC, body: { messageText: "visit https://example.com" } });
  await expectStatus(globalPath, 400, { method: "POST", token: tokenA, body: { messageText: "visit 127.0.0.1:8080" } });
  await expectStatus(globalPath, 400, { method: "POST", token: tokenA, body: { messageText: "x".repeat(301) } });
  const maximumLengthMessage = await expectStatus(globalPath, 201, {
    method: "POST",
    token: tokenB,
    body: { messageText: "🛡".repeat(300) }
  });
  check(Array.from(maximumLengthMessage.data.message.messageText).length === 300, "exactly 300 Unicode characters are accepted");

  const sameRealmMessage = await expectStatus(`/chat/channels/${realmA.id}/messages`, 201, {
    method: "POST",
    token: tokenA,
    body: { messageText: "message for realm 07" }
  });
  const sameRealmHistory = await expectStatus(`/chat/channels/${realmA.id}/messages`, 200, { token: tokenB });
  check(sameRealmHistory.data.messages.some(message => message.id === sameRealmMessage.data.message.id), "players in the same profile realm share realm chat");

  await expectStatus("/friends/requests", 201, {
    method: "POST",
    token: tokenA,
    body: { playerId: profileB.data.publicPlayerId }
  });
  const incoming = await expectStatus("/friends/requests", 200, { token: tokenB });
  const requestId = incoming.data.requests.find(item => item.direction === "incoming")?.id;
  check(Boolean(requestId), "friend request is available to recipient");
  await expectStatus(`/friends/requests/${requestId}/accept`, 200, { method: "POST", token: tokenB, body: {} });

  await expectStatus(`/chat/private/${profileB.data.publicPlayerId}`, 200, { method: "POST", token: tokenA, body: {} });
  const conversationsA = await expectStatus("/chat/channels", 200, { token: tokenA });
  const privateChannel = conversationsA.data.conversations.find(item => item.publicPlayerId === profileB.data.publicPlayerId);
  check(Boolean(privateChannel), "friends can open and list a private conversation");
  const privatePath = `/chat/channels/${privateChannel.id}/messages`;
  const privateMessage = await expectStatus(privatePath, 201, {
    method: "POST",
    token: tokenA,
    body: { messageText: "private hello" }
  });
  const privateHistoryB = await expectStatus(privatePath, 200, { token: tokenB });
  check(privateHistoryB.data.messages.some(message => message.id === privateMessage.data.message.id), "private friend receives a private message");
  await expectStatus(`/chat/private/${profileA.data.publicPlayerId}`, 403, { method: "POST", token: tokenC, body: {} });
  await expectStatus(privatePath, 404, { token: tokenC });

  await expectStatus(`/chat/mute/${profileB.data.publicPlayerId}`, 204, { method: "POST", token: tokenA, body: {} });
  const afterMuteChannels = await expectStatus("/chat/channels", 200, { token: tokenA });
  check(afterMuteChannels.data.mutedPlayers.some(player => player.publicPlayerId === profileB.data.publicPlayerId), "mute state persists in the authenticated chat response");
  const mutedMessage = await expectStatus(globalPath, 201, {
    method: "POST",
    token: tokenB,
    body: { messageText: "muted global message" }
  });
  const hiddenMutedMessage = await expectStatus(globalPath, 200, { token: tokenA });
  check(!hiddenMutedMessage.data.messages.some(message => message.id === mutedMessage.data.message.id), "mute hides a sender's public message only for the muting player");
  const friendshipAfterMute = await expectStatus("/friends", 200, { token: tokenA });
  check(friendshipAfterMute.data.friends.some(friend => friend.publicPlayerId === profileB.data.publicPlayerId), "muting does not remove a friendship");
  await expectStatus(`/chat/mute/${profileB.data.publicPlayerId}`, 204, { method: "DELETE", token: tokenA });
  const unmutedMessages = await expectStatus(globalPath, 200, { token: tokenA });
  check(unmutedMessages.data.messages.some(message => message.id === mutedMessage.data.message.id), "unmuting restores visibility of existing messages");

  const reportResponse = await expectStatus(`/chat/messages/${mutedMessage.data.message.id}/report`, 201, {
    method: "POST",
    token: tokenA,
    body: { reason: "spam", details: "Unwanted repeated message" }
  });
  const reportDb = await dbQuery(
    `SELECT r.reason, r.status, m.deleted_at
     FROM message_reports r
     JOIN chat_messages m ON m.id = r.message_id
     JOIN users u ON u.username = $2
     WHERE r.message_id = $1 AND r.reporter_user_id = u.id`,
    [mutedMessage.data.message.id, usernames[0]]
  );
  check(reportResponse.data.report.status === "pending" && reportDb.rows[0]?.reason === "spam" && reportDb.rows[0]?.deleted_at === null, "report is stored for moderation without physically deleting the message");
  check(
    !("reporterUserId" in reportResponse.data.report) &&
      !("reporter_user_id" in reportResponse.data.report),
    "report response omits internal reporter identity"
  );

  await expectStatus(globalPath, 201, {
    method: "POST",
    token: tokenB,
    body: { messageText: "repeated phrase" }
  });
  await expectStatus(globalPath, 201, {
    method: "POST",
    token: tokenB,
    body: { messageText: "repeated phrase" }
  });
  await expectStatus(globalPath, 429, {
    method: "POST",
    token: tokenB,
    body: { messageText: "repeated phrase" }
  });

  await expectStatus(`/blocks/${profileA.data.publicPlayerId}`, 200, { method: "POST", token: tokenB, body: {} });
  await expectStatus(`/chat/private/${profileB.data.publicPlayerId}`, 409, { method: "POST", token: tokenA, body: {} });
  await expectStatus(privatePath, 404, { token: tokenA });
  await expectStatus(privatePath, 404, { token: tokenB });
  await expectStatus(`/blocks/${profileA.data.publicPlayerId}`, 204, { method: "DELETE", token: tokenB });
  const privatePermissionAfterBlock = await dbQuery(
    "SELECT COUNT(*)::INTEGER AS count FROM friendships WHERE player_low_id = LEAST((SELECT id FROM users WHERE username = $1)::integer, (SELECT id FROM users WHERE username = $2)::integer) AND player_high_id = GREATEST((SELECT id FROM users WHERE username = $1)::integer, (SELECT id FROM users WHERE username = $2)::integer)",
    [usernames[0], usernames[1]]
  );
  check(privatePermissionAfterBlock.rows[0].count === 0, "blocking removes private-chat friendship authorization");

  await dbQuery("UPDATE player_profiles SET realm = '08' WHERE user_id = (SELECT id FROM users WHERE username = $1)", [usernames[2]]);
  const realmChannelCheck = await dbQuery("SELECT id FROM chat_channels WHERE channel_type = 'realm' AND realm = '08'");
  if (!realmChannelCheck.rowCount) {
    await dbQuery("INSERT INTO chat_channels(channel_type, channel_key, realm) VALUES('realm', 'realm:08', '08')");
    temporaryRealmChannelCreated = true;
  }
  const realmChannelsC = await expectStatus("/chat/channels", 200, { token: tokenC });
  const realmC = realmChannelsC.data.channels.find(channel => channel.type === "realm" && channel.realm === "08");
  check(Boolean(realmC) && !realmChannelsC.data.channels.some(channel => channel.type === "realm" && channel.realm === "07"), "realm channels are derived from the server-stored player profile");
  await expectStatus(`/chat/channels/${realmA.id}/messages`, 404, { token: tokenC });
  await expectStatus(`/chat/channels/${realmC.id}/messages`, 404, { token: tokenB });
  const realmMessageC = await expectStatus(`/chat/channels/${realmC.id}/messages`, 201, {
    method: "POST",
    token: tokenC,
    body: { messageText: "message for realm 08" }
  });
  check(realmMessageC.data.message.username === usernames[2], "realm message uses authenticated sender identity");

  await new Promise(resolve => setTimeout(resolve, 10_100));
  await dbQuery(
    "DELETE FROM chat_messages WHERE sender_user_id = (SELECT id FROM users WHERE username = $1)",
    [usernames[2]]
  );
  for (let index = 0; index < 5; index += 1) {
    await expectStatus(globalPath, 201, {
      method: "POST",
      token: tokenC,
      body: { messageText: `rate test message ${index + 1}` }
    });
  }
  await expectStatus(globalPath, 429, {
    method: "POST",
    token: tokenC,
    body: { messageText: "sixth message in ten seconds" }
  });

  await expectStatus("/players/search?q=chat_a_", 200, { token: tokenB });
  await expectStatus("/friends", 200, { token: tokenA });
  await expectStatus("/presence/online-count", 200, { token: tokenA });
  console.log(`Chat integration tests passed: ${passed}`);
} finally {
  if (createdUsers.length) {
    await dbQuery("DELETE FROM users WHERE username = ANY($1::text[])", [createdUsers]);
  }
  if (temporaryRealmChannelCreated) {
    await dbQuery(
      "DELETE FROM chat_channels WHERE channel_type = 'realm' AND realm = '08' AND channel_key = 'realm:08'"
    );
  }
  if (createdUsers.length) console.log(`Removed ${createdUsers.length} temporary chat users.`);
}
