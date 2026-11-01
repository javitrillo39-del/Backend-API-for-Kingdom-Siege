const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001/api";

async function request(path, options = {}) {
  const token = localStorage.getItem("ks_token");
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "API request failed");
  return data;
}

export const api = {
  register: (username, password) => request("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username, password) => request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  game: () => request("/game"),
  upgrade: type => request("/game/upgrade", { method: "POST", body: JSON.stringify({ type }) }),
  train: () => request("/game/train", { method: "POST", body: "{}" }),
  repair: () => request("/game/repair", { method: "POST", body: "{}" }),
  attack: enemyId => request("/game/attack", { method: "POST", body: JSON.stringify({ enemyId }) }),
  collect: seconds => request("/game/collect", { method: "POST", body: JSON.stringify({ seconds }) }),
  ranking: () => request("/ranking")
};

export function saveSession(result) {
  localStorage.setItem("ks_token", result.token);
  return result;
}
export function logout() { localStorage.removeItem("ks_token"); }
