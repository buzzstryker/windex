-- Flag rounds as "Signature Events" (special trips / large multi-day buy-ins).
-- These can be excluded from analytics to avoid skewing head-to-head data.
ALTER TABLE league_rounds ADD COLUMN IF NOT EXISTS is_signature_event SMALLINT NOT NULL DEFAULT 0;
