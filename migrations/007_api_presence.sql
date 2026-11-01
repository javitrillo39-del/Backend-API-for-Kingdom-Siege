ALTER TABLE player_profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_logout_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_player_profiles_last_seen_at
  ON player_profiles (last_seen_at)
  WHERE last_seen_at IS NOT NULL;
