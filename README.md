# Kingdom Siege API

Backend for the horizontal React game prototype. Includes accounts, JWT login, SQLite persistence, upgrades, training, repairs, attacks, collection and ranking.

## Start

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and change `JWT_SECRET`.
3. Run:

```bash
npm install
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

Game-changing operations are validated by the server, so a browser cannot simply award itself resources.
