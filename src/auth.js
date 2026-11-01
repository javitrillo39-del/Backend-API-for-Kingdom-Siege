import jwt from "jsonwebtoken";

export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

export function requireAuth(req, res, next) {
  const value = req.headers.authorization || "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: Number(payload.sub), username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
