import "dotenv/config";
import http from "node:http";
import { createDb } from "../src/db.js";

const port = Number(process.env.PORT) || 3001;
const apiPath = "/api";
const suffix = Math.random().toString(36).slice(2, 10);
const usernames = [`ksa_${suffix}`, `ksb_${suffix}`];
const createdUsers = [];
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
  const detail = response.data?.error ? `: ${response.data.error}` : "";
  check(
    response.status === expected,
    `${options.method || "GET"} ${path} expected ${expected}, got ${response.status}${detail}`
  );
  return response;
}

try {
  await expectStatus("/health", 200);
  const registerA = await expectStatus("/auth/register", 201, {
    method: "POST",
    body: { username: usernames[0], password: "TestPassword_123" }
  });
  createdUsers.push(usernames[0]);
  const registerB = await expectStatus("/auth/register", 201, {
    method: "POST",
    body: { username: usernames[1], password: "TestPassword_456" }
  });
  createdUsers.push(usernames[1]);

  const tokenA = registerA.data.token;
  const tokenB = registerB.data.token;
  const playerA = registerA.data.user.id;
  const playerB = registerB.data.user.id;
  check(Boolean(tokenA && tokenB), "registration returns JWTs");

  const ownProfile = await expectStatus("/me/profile", 200, { token: tokenA });
  const otherProfile = await expectStatus("/me/profile", 200, { token: tokenB });
  const publicIdA = ownProfile.data.id;
  const publicIdB = otherProfile.data.id;
  check(/^KS-[A-Z0-9]{8}$/.test(publicIdA), "registration assigns a permanent public player ID");
  check(publicIdA !== publicIdB, "new player IDs are unique");
  check(
    ownProfile.data.username === usernames[0] &&
    ownProfile.data.realm === "07" &&
    !Object.keys(ownProfile.data).some(key => /password|email|token|secret|database_url|user_id/i.test(key)),
    "own profile contains safe public stats without internal IDs"
  );
  const playerStats = await expectStatus("/players/stats", 200, { token: tokenA });
  check(playerStats.data.registeredPlayers >= 2, "player statistics count registered users");
  await expectStatus("/players/me", 400, {
    method: "PATCH",
    token: tokenA,
    body: { publicPlayerId: "KS-AAAAAAAA" }
  });
  const profileAfterLogin = await expectStatus("/me/profile", 200, { token: tokenA });
  check(profileAfterLogin.data.id === publicIdA, "public player ID remains unchanged");

  const login = await expectStatus("/auth/login", 200, {
    method: "POST",
    body: { username: usernames[0], password: "TestPassword_123" }
  });
  check(Boolean(login.data.token), "login returns JWT");

  const game = await expectStatus("/game", 200, { token: tokenA });
  check(
    game.data.user?.id === playerA &&
    game.data.user?.username === usernames[0] &&
    Object.keys(game.data.user).sort().join(",") === "id,username" &&
    Boolean(game.data.game),
    "authenticated game response includes only public user identity and game"
  );
  await expectStatus("/game/upgrade", 200, {
    method: "POST", token: tokenA, body: { type: "farm" }
  });
  await expectStatus("/game/train", 200, { method: "POST", token: tokenA, body: {} });
  await expectStatus("/game/repair", 200, { method: "POST", token: tokenA, body: {} });
  await expectStatus("/game/attack", 200, {
    method: "POST", token: tokenA, body: { enemyId: "goblin" }
  });
  await expectStatus("/game/collect", 200, {
    method: "POST", token: tokenA, body: { seconds: 1 }
  });
  const ranking = await expectStatus("/ranking", 200);
  check(Array.isArray(ranking.data.ranking), "legacy ranking response");

  const profileUpdate = await expectStatus("/players/me", 200, {
    method: "PATCH",
    token: tokenA,
    body: { displayName: "Public Knight", bio: "Temporary test profile" }
  });
  check(profileUpdate.data.profile.displayName === "Public Knight", "profile update response");
  const search = await expectStatus(
    `/players/search?q=${usernames[1]}&page=1&limit=10`,
    200,
    { token: tokenA }
  );
  check(
    search.data.players.some(player => player.id === publicIdB) &&
    !search.data.players.some(player => player.id === playerB),
    "username search returns public ID instead of internal user ID"
  );
  const caseInsensitiveSearch = await expectStatus(
    `/players/search?q=${usernames[1].toUpperCase()}&page=1&limit=10`,
    200,
    { token: tokenA }
  );
  check(
    caseInsensitiveSearch.data.players.some(player => player.id === publicIdB),
    "username search ignores case"
  );
  const idSearch = await expectStatus(
    `/players/search?q=${publicIdB.toLowerCase()}&page=1&limit=10`,
    200,
    { token: tokenA }
  );
  check(idSearch.data.players.some(player => player.id === publicIdB), "search finds exact public ID case-insensitively");
  const profile = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    profile.data.player.id === publicIdB &&
    profile.data.player.username === usernames[1] &&
    profile.data.player.realm === "Realm 07" &&
    !Object.keys(profile.data.player).some(key => /password|email|secret|token|database_url|user_id/i.test(key)),
    "public profile uses public ID and omits credentials"
  );
  const online = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenB });
  check(online.data.player.online === true, "approximate online status");

  const selfRequest = await expectStatus("/friends/requests", 400, {
    method: "POST", token: tokenA, body: { playerId: publicIdA }
  });
  check(selfRequest.data.error, "self-request validation");
  const sentRequest = await expectStatus("/friends/requests", 201, {
    method: "POST", token: tokenA, body: { playerId: publicIdB }
  });
  const requestId = sentRequest.data.request.id;
  await expectStatus("/friends/requests", 409, {
    method: "POST", token: tokenA, body: { playerId: publicIdB }
  });
  await expectStatus(`/friends/requests/${requestId}/accept`, 404, {
    method: "POST", token: tokenA, body: {}
  });
  const inbox = await expectStatus("/friends/requests?page=1&limit=10", 200, { token: tokenB });
  check(
    inbox.data.requests.some(item => item.id === requestId && item.direction === "incoming"),
    "incoming request list"
  );
  const requestNotices = await expectStatus("/notifications?page=1&limit=10", 200, { token: tokenB });
  check(
    requestNotices.data.notifications.some(item => item.type === "friend_request"),
    "request notification"
  );
  await expectStatus(`/friends/requests/${requestId}/accept`, 200, {
    method: "POST", token: tokenB, body: {}
  });
  const friends = await expectStatus("/friends?page=1&limit=10", 200, { token: tokenA });
  check(friends.data.friends.some(friend => friend.id === playerB), "friends list includes accepted friend");
  const acceptedNotices = await expectStatus("/notifications", 200, { token: tokenA });
  check(
    acceptedNotices.data.notifications.some(item => item.type === "friend_request_accepted"),
    "accepted-request notification"
  );
  await expectStatus(`/friends/${playerB}`, 204, { method: "DELETE", token: tokenA });

  const reverseRequest = await expectStatus("/friends/requests", 201, {
    method: "POST", token: tokenB, body: { playerId: playerA }
  });
  await expectStatus(`/friends/requests/${reverseRequest.data.request.id}/reject`, 200, {
    method: "POST", token: tokenA, body: {}
  });

  const pendingBeforeBlock = await expectStatus("/friends/requests", 201, {
    method: "POST", token: tokenB, body: { playerId: playerA }
  });
  await expectStatus(`/blocks/${playerA}`, 400, {
    method: "POST", token: tokenA, body: {}
  });
  await expectStatus(`/blocks/${publicIdB}`, 200, {
    method: "POST", token: tokenA, body: {}
  });
  const blockList = await expectStatus("/blocks?page=1&limit=20", 200, { token: tokenA });
  check(
    blockList.data.blockedPlayers.some(
      player => player.id === playerB && player.online === true && player.power > 0
    ),
    "blocked-player list includes live status and power"
  );
  const requestsAfterBlock = await expectStatus("/friends/requests", 200, { token: tokenB });
  check(
    !requestsAfterBlock.data.requests.some(item => item.id === pendingBeforeBlock.data.request.id),
    "blocking cancels pending requests"
  );
  const noticesAfterBlock = await expectStatus("/notifications", 200, { token: tokenA });
  check(
    !noticesAfterBlock.data.notifications.some(item => item.actorId === playerB),
    "blocking hides related notifications"
  );
  const blockedSearch = await expectStatus(
    `/players/search?q=${usernames[1]}`,
    200,
    { token: tokenA }
  );
  check(
    blockedSearch.data.players.some(player => player.id === publicIdB),
    "players blocked by the current user remain searchable by public ID"
  );
  const blockedProfile = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    blockedProfile.data.player.id === publicIdB,
    "profile remains visible for a player blocked by the current user"
  );
  await expectStatus("/friends/requests", 409, {
    method: "POST", token: tokenB, body: { playerId: playerA }
  });
  await expectStatus(`/blocks/${playerB}`, 400, {
    method: "DELETE", token: tokenB
  });
  await expectStatus(`/blocks/${playerB}`, 204, {
    method: "DELETE", token: tokenA
  });
  const unblockedSearch = await expectStatus(
    `/players/search?q=${usernames[1]}`,
    200,
    { token: tokenA }
  );
  check(unblockedSearch.data.players.some(player => player.id === publicIdB), "unblocked player visible");

  await expectStatus("/friends", 401);
  await expectStatus("/players/search?q=%25", 400, { token: tokenA });
  console.log(`Social integration tests passed: ${passed}`);
} catch (error) {
  console.error(error.message || "Social integration test failed");
  process.exitCode = 1;
} finally {
  if (createdUsers.length) {
    let db;
    try {
      db = await createDb();
      const { rowCount } = await db.query(
        "DELETE FROM users WHERE username = ANY($1::text[])",
        [createdUsers]
      );
      if (rowCount !== createdUsers.length) {
        throw new Error("Not all temporary test users were removed.");
      }
      console.log(`Removed ${rowCount} temporary test users.`);
    } catch (error) {
      console.error(`Temporary-user cleanup failed: ${error.code || error.message || "database error"}`);
      process.exitCode = 1;
    } finally {
      if (db) await db.end();
    }
  }
}
