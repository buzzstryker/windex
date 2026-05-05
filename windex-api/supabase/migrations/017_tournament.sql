-- Tournament round support: flag + buy-in amount on league_rounds.
ALTER TABLE league_rounds ADD COLUMN IF NOT EXISTS is_tournament SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE league_rounds ADD COLUMN IF NOT EXISTS tournament_buyin DOUBLE PRECISION;
