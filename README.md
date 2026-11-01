# Kingdom Siege API

Backend for the horizontal React game. Includes accounts, bcrypt password hashing, JWT login, PostgreSQL persistence, game actions, ranking and the first social features. The local SQLite database is retained only as a backup.

## Start

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure `PORT`, private `JWT_SECRET`, `SUPABASE_JWT_SECRET`, `FRONTEND_ORIGIN` and the Supabase PostgreSQL `DATABASE_URL`. Keep `.env` private and out of Git.
4. Apply the social schema after the existing PostgreSQL `users` and `games` tables are present:

```powershell
npm run migrate:social
```

This additive migration does not import, delete or recreate the SQLite backup.
After public player IDs are migrated, enable Supabase Realtime and apply its
additive presence policy:

```powershell
npm run migrate:public-ids
npm run migrate:presence
```

`SUPABASE_JWT_SECRET` must be the compatible signing secret for the same
Supabase project. Never put it in the frontend.
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
- `POST /api/presence/session`
- `PATCH /api/presence/session`
- `DELETE /api/presence/session`
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

Social routes require a valid JWT. Blocking cancels pending requests and hides the blocked player from social searches, profiles and related notifications. Live online state comes from Supabase Realtime Presence and is deduplicated by public player ID; `last_seen_at` is updated at connection/section transitions, limited intervals, and logout. If Realtime is unavailable, the frontend reports that state rather than treating registered accounts as online.

Game-changing operations are validated by the server, so a browser cannot simply award itself resources. Run the social integration tests against a running local API and the configured PostgreSQL database:

```powershell
npm run test:social
```

The test script creates two temporary users and removes only those users afterward.
