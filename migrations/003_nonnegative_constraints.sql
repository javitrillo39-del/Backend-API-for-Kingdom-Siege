DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_food_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_food_nonnegative CHECK (food >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_wood_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_wood_nonnegative CHECK (wood >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_gold_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_gold_nonnegative CHECK (gold >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_troops_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_troops_nonnegative CHECK (troops >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_farm_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_farm_nonnegative CHECK (farm >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_lumber_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_lumber_nonnegative CHECK (lumber >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_barracks_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_barracks_nonnegative CHECK (barracks >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_castle_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_castle_nonnegative CHECK (castle >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'games'::regclass AND conname = 'games_victories_nonnegative') THEN
    ALTER TABLE games ADD CONSTRAINT games_victories_nonnegative CHECK (victories >= 0);
  END IF;
END;
$$;
