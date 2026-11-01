import "dotenv/config";
import http from "node:http";
import jwt from "jsonwebtoken";
import { createDb } from "../src/db.js";

const port = Number(process.env.PORT) || 3001;
const apiPath = "/api";
const suffix = Math.random().toString(36).slice(2, 10);
const usernames = [`ksa_${suffix}`, `ksb_${suffix}`];
const createdUsers = [];
let passed = 0;
let originalRegisteredPlayers;

async function getAccountCounts() {
  const db = await createDb();
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::INTEGER AS "registeredPlayers",
              COUNT(DISTINCT p.public_player_id)::INTEGER AS "uniquePublicIds"
       FROM users u
       LEFT JOIN player_profiles p ON p.user_id = u.id`
    );
    return rows[0];
  } finally {
    await db.end();
  }
}

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
  originalRegisteredPlayers = (await getAccountCounts()).registeredPlayers;
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
  const publicIdA = ownProfile.data.publicPlayerId;
  const publicIdB = otherProfile.data.publicPlayerId;
  const presenceSession = await expectStatus("/presence/session", 200, {
    method: "POST",
    token: tokenA,
    body: { activeSection: "City" }
  });
  const presenceClaims = jwt.decode(presenceSession.data.accessToken);
  check(
    presenceSession.data.presence.publicPlayerId === publicIdA &&
    presenceSession.data.presence.username === usernames[0] &&
    presenceSession.data.presence.realm === "07" &&
    presenceSession.data.presence.activeSection === "City" &&
    Object.keys(presenceSession.data.presence).sort().join(",") ===
      "activeSection,publicPlayerId,realm,username" &&
    presenceClaims?.sub === publicIdA &&
    presenceClaims?.role === "authenticated",
    "Realtime identity contains only public fields and a token subject based on public player ID"
  );
  await expectStatus("/presence/session", 400, {
    method: "POST",
    token: tokenA,
    body: { activeSection: "Secret", userId: playerA }
  });
  const lastSeenBeforeSectionUpdate = await expectStatus(`/players/${publicIdA}`, 200, {
    token: tokenA
  });
  const sectionUpdate = await expectStatus("/presence/session", 200, {
    method: "PATCH",
    token: tokenA,
    body: { activeSection: "Social" }
  });
  check(
    sectionUpdate.data.lastSeenAt === lastSeenBeforeSectionUpdate.data.player.lastSeenAt,
    "last-seen writes are throttled to at most once per minute"
  );
  await expectStatus("/presence/session", 200, {
    method: "POST",
    token: tokenB,
    body: { activeSection: "Army" }
  });
  const presenceProfile = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    Boolean(presenceProfile.data.player.lastSeenAt) &&
      !Object.hasOwn(presenceProfile.data.player, "online"),
    "offline profiles expose last-seen time instead of a time-based online guess"
  );
  await expectStatus("/presence/session", 204, {
    method: "DELETE",
    token: tokenB
  });
  const profileAfterLogout = await expectStatus(`/players/${publicIdB}`, 200, {
    token: tokenA
  });
  check(
    Boolean(profileAfterLogout.data.player.lastSeenAt) &&
      Date.parse(profileAfterLogout.data.player.lastSeenAt) >=
        Date.parse(presenceProfile.data.player.lastSeenAt),
    "explicit logout updates last-seen before a player disconnects"
  );
  check(/^KS-[A-Z0-9]{8}$/.test(publicIdA), "registration assigns a permanent public player ID");
  check(publicIdA !== publicIdB, "new player IDs are unique");
  check(
    ownProfile.data.username === usernames[0] &&
    ownProfile.data.realm === "07" &&
    !Object.keys(ownProfile.data).some(key => /password|email|token|secret|database_url|user_id/i.test(key)),
    "own profile contains safe public stats without internal IDs"
  );
  const playerStats = await expectStatus("/players/stats", 200, { token: tokenA });
  const liveCounts = await getAccountCounts();
  check(
    liveCounts.uniquePublicIds === liveCounts.registeredPlayers,
    "every registered user has a unique public player ID"
  );
  check(
    playerStats.data.registeredPlayers === liveCounts.registeredPlayers &&
    liveCounts.registeredPlayers === originalRegisteredPlayers + 2,
    "registeredPlayers equals the users table count, including the two temporary test accounts"
  );
  await expectStatus("/presence/session", 401);
  await expectStatus("/players/me", 400, {
    method: "PATCH",
    token: tokenA,
    body: { publicPlayerId: "KS-AAAAAAAA" }
  });
  const profileAfterLogin = await expectStatus("/me/profile", 200, { token: tokenA });
  check(profileAfterLogin.data.publicPlayerId === publicIdA, "public player ID remains unchanged");

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
  const usernameMatch = search.data.players.find(player => player.publicPlayerId === publicIdB);
  check(
    usernameMatch?.username === usernames[1] &&
    !Object.keys(usernameMatch || {}).some(key => /password|email|token|secret|database_url|user_id/i.test(key)),
    "username search returns the real username and a safe public profile"
  );
  const profileBeforeRequest = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    profileBeforeRequest.data.player.friendshipStatus === "none",
    "public profile friendship status is evaluated for the authenticated viewer"
  );
  const caseInsensitiveSearch = await expectStatus(
    `/players/search?q=${usernames[1].toUpperCase()}&page=1&limit=10`,
    200,
    { token: tokenA }
  );
  check(
    caseInsensitiveSearch.data.players.some(
      player => player.publicPlayerId === publicIdB && player.username === usernames[1]
    ),
    "username search ignores case"
  );
  const idSearch = await expectStatus(
    `/players/search?q=${publicIdB.toLowerCase()}&page=1&limit=10`,
    200,
    { token: tokenA }
  );
  const publicIdMatch = idSearch.data.players.find(player => player.publicPlayerId === publicIdB);
  check(
    publicIdMatch?.username === usernames[1] &&
    publicIdMatch.friendshipStatus === "none" &&
    JSON.stringify(Object.keys(publicIdMatch).sort()) ===
      JSON.stringify(["friendshipStatus", "power", "publicPlayerId", "realm", "username", "victories"]),
    "exact public-ID search returns the same real username and safe response shape"
  );
  check(
    usernameMatch?.publicPlayerId === publicIdMatch?.publicPlayerId,
    "username and public-ID searches find the same player"
  );
  const profile = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    profile.data.player.publicPlayerId === publicIdB &&
    profile.data.player.username === usernames[1] &&
    profile.data.player.realm === "Realm 07" &&
    !Object.keys(profile.data.player).some(key => /password|email|secret|token|database_url|user_id/i.test(key)),
    "public profile uses public ID and omits credentials"
  );
  const online = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenB });
  check(Boolean(online.data.player.lastSeenAt), "profile returns last-seen timestamp");

  const selfRequest = await expectStatus("/friends/requests", 400, {
    method: "POST", token: tokenA, body: { playerId: publicIdA }
  });
  check(selfRequest.data.error, "self-request validation");
  const sentRequest = await expectStatus("/friends/requests", 201, {
    method: "POST", token: tokenA, body: { playerId: publicIdB }
  });
  const requestId = sentRequest.data.request.id;
  const profileAfterRequest = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    profileAfterRequest.data.player.friendshipStatus === "pending",
    "public profile reflects the pending friendship status"
  );
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
  const profileAfterAccept = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    profileAfterAccept.data.player.friendshipStatus === "friends",
    "public profile reflects accepted friendship"
  );
  const friends = await expectStatus("/friends?page=1&limit=10", 200, { token: tokenA });
  check(friends.data.friends.some(friend => friend.id === playerB), "friends list includes accepted friend");
  const listedFriend = friends.data.friends.find(friend => friend.id === playerB);
  check(
    listedFriend.publicPlayerId === publicIdB &&
      Boolean(listedFriend.lastSeenAt) &&
      !Object.hasOwn(listedFriend, "online"),
    "friends list exposes public ID and last-seen data without a guessed online flag"
  );
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
      player => player.id === playerB &&
        player.publicPlayerId === publicIdB &&
        Boolean(player.lastSeenAt) &&
        player.power > 0 &&
        !Object.hasOwn(player, "online")
    ),
    "blocked-player list includes public identity and last-seen data, not guessed online status"
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
    blockedSearch.data.players.some(
      player => player.publicPlayerId === publicIdB && player.friendshipStatus === "blocked"
    ),
    "players blocked by the current user remain searchable by public ID"
  );
  const blockedProfile = await expectStatus(`/players/${publicIdB}`, 200, { token: tokenA });
  check(
    blockedProfile.data.player.publicPlayerId === publicIdB &&
    blockedProfile.data.player.friendshipStatus === "blocked",
    "profile remains visible and reports blocked status"
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
  check(
    unblockedSearch.data.players.some(
      player => player.publicPlayerId === publicIdB && player.friendshipStatus === "none"
    ),
    "unblocked player visible"
  );

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
      const finalCounts = await getAccountCounts();
      if (finalCounts.registeredPlayers !== originalRegisteredPlayers) {
        throw new Error("The registered-user count did not return to its original value after cleanup.");
      }
      console.log("Verified temporary accounts were removed and registeredPlayers returned to its original count.");
    } catch (error) {
      console.error(`Temporary-user cleanup failed: ${error.code || error.message || "database error"}`);
      process.exitCode = 1;
    } finally {
      if (db) await db.end();
    }
  }
}
