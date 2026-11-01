ALTER TABLE player_profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

DO $$
BEGIN
  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE EXCEPTION 'Supabase Realtime must be enabled before applying presence migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'realtime'
      AND tablename = 'messages'
      AND policyname = 'kingdom_presence_authenticated_read'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY kingdom_presence_authenticated_read
      ON realtime.messages
      FOR SELECT
      TO authenticated
      USING (
        extension = 'presence'
        AND (SELECT realtime.topic()) = 'kingdom-presence'
      )
    $policy$;
  END IF;
END
$$;
