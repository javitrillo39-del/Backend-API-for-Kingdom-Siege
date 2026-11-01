# Kingdom Siege API

Backend for the horizontal React game. Includes accounts, bcrypt password hashing, JWT login, PostgreSQL persistence, game actions, ranking and the first social features. The local SQLite database is retained only as a backup.

## Start

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure `PORT`, private `JWT_SECRET`, `FRONTEND_ORIGIN` and the PostgreSQL `DATABASE_URL`. Keep `.env` private and out of Git.
4. Apply the social schema after the existing PostgreSQL `users` and `games` tables are present:

```powershell
npm run migrate:social
```

This additive migration does not import, delete or recreate the SQLite backup.
Then apply the public player ID and API presence migrations:

```powershell
npm run migrate:public-ids
npm run migrate:presence
npm run migrate:chat
```

For local development, start the API:

```bash
npm run dev
```

The API starts at `http://localhost:3001`.

## Connect the current React game

Copy `frontend/api.js` into the React project as `src/api.js`. Add this to the frontend `.env`:

```env
VITE_API_URL=http://localhost:3001/api
```

Import it with:

```js
import { api, saveSession } from "./api";
```

After login or registration:

```js
const result = saveSession(await api.login(username, password));
applyGame(result.game);
```

Create an `applyGame` helper in the component:

```js
const applyGame = game => {
  setFood(game.food); setWood(game.wood); setGold(game.gold);
  setTroops(game.troops); setHealth(game.health);
  setBuildings({ farm: game.farm, lumber: game.lumber, barracks: game.barracks, castle: game.castle });
};
```

Replace local actions with API calls, for example:

```js
const train = async () => {
  try { const result = await api.train(); applyGame(result.game); setMessage(result.message); }
  catch (error) { setMessage(error.message); }
};
```

Enemy IDs are `goblin`, `bandit`, and `shadow`.

## Main routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/game`
- `POST /api/game/upgrade`
- `POST /api/game/train`
- `POST /api/game/repair`
- `POST /api/game/attack`
- `POST /api/game/collect`
- `GET /api/ranking`
- `GET /api/health`
- `GET /api/players/search?q=<username>&page=1&limit=20`
- `GET /api/players/:id`
- `POST /api/presence/heartbeat`
- `POST /api/presence/logout`
- `GET /api/presence/online-count`
- `GET /api/chat/channels`
- `GET /api/chat/channels/:channelId/messages?page=1&limit=50`
- `POST /api/chat/channels/:channelId/messages`
- `POST /api/chat/private/:publicPlayerId`
- `POST /api/chat/messages/:messageId/report`
- `POST /api/chat/mute/:publicPlayerId`
- `DELETE /api/chat/mute/:publicPlayerId`
- `PATCH /api/players/me`
- `GET /api/friends`
- `GET /api/friends/requests`
- `POST /api/friends/requests`
- `POST /api/friends/requests/:id/accept`
- `POST /api/friends/requests/:id/reject`
- `DELETE /api/friends/:playerId`
- `POST /api/blocks/:playerId`
- `DELETE /api/blocks/:playerId`
- `GET /api/notifications`

Social routes require a valid JWT. Blocking cancels pending requests and hides the blocked player from social searches, profiles and related notifications. Presence uses authenticated API heartbeats: a player is online for 90 seconds after the last heartbeat, logout immediately marks the player offline, and active counts are deduplicated by user account. Friends include an `online` status and show `lastSeenAt` only while offline.
Error responses use stable uppercase codes in the `error` field so clients can localize them without displaying server-authored English text.
Chat requires a JWT. Global chat is shared by authenticated players; realm
chat uses the realm persisted in the server-side profile; private channels
require an active friendship. Message history is paginated, private messages
are hidden after a block or friendship removal, and user mutes hide messages
from that player only for the muting account. Reports are stored for later
moderation without physically deleting messages. Chat messages accept plain
text only, have a 300-character limit, reject links/markup, and are limited to
five per player every ten seconds.

Game-changing operations are validated by the server, so a browser cannot simply award itself resources. Run the social integration tests against a running local API and the configured PostgreSQL database:

```powershell
npm run test:error-codes
npm run test:social
npm run test:chat
```

The test script creates three temporary users and removes only those users afterward.
