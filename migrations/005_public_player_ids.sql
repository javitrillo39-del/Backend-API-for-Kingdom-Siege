ALTER TABLE player_profiles
  ADD COLUMN IF NOT EXISTS public_player_id TEXT;

DO $$
DECLARE
  profile_user_id INTEGER;
  candidate TEXT;
BEGIN
  FOR profile_user_id IN
    SELECT user_id
    FROM player_profiles
    WHERE public_player_id IS NULL
    ORDER BY user_id
  LOOP
    LOOP
      candidate := 'KS-' || SUBSTRING(
        REPLACE(UPPER(gen_random_uuid()::TEXT), '-', '')
        FROM 1 FOR 8
      );
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM player_profiles
        WHERE public_player_id = candidate
      );
    END LOOP;

    UPDATE player_profiles
    SET public_player_id = candidate
    WHERE user_id = profile_user_id;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS player_profiles_public_player_id_unique
  ON player_profiles (public_player_id);

ALTER TABLE player_profiles
  ALTER COLUMN public_player_id SET NOT NULL,
  ALTER COLUMN public_player_id SET DEFAULT (
    'KS-' || SUBSTRING(
      REPLACE(UPPER(gen_random_uuid()::TEXT), '-', '')
      FROM 1 FOR 8
    )
  );

CREATE INDEX IF NOT EXISTS users_username_lower_prefix_idx
  ON users (LOWER(username) text_pattern_ops);
