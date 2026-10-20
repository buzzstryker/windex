-- Migration 059: season_standings_final — frozen standings per closed season.
--
-- Same 8 columns and types as the season_standings view (039), plus snapshot
-- metadata. Rows are written only by close_season() and deleted only by
-- reopen_season() (060), both SECURITY DEFINER and super-admin gated. No client
-- role holds a write privilege.
--
-- player_id deliberately has NO foreign key: group_members.player_id has none
-- either (001), so the view can emit a player_id with no players row, and a FK
-- here would make close_season fail on that orphan instead of freezing it.
-- No extra indexes; the PK (season_id, player_id) serves every read in 061.
--
-- Read access matches season_standings after 057: any signed-in user, anon
-- refused outright (Supabase's default ACL grants anon directly, so REVOKE FROM
-- PUBLIC alone would not remove it).

CREATE TABLE IF NOT EXISTS public.season_standings_final (
  season_id     TEXT             NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  group_id      TEXT             NOT NULL REFERENCES public.groups(id)  ON DELETE CASCADE,
  player_id     TEXT             NOT NULL,
  rounds_played BIGINT           NOT NULL,
  total_points  DOUBLE PRECISION NOT NULL,
  wins          BIGINT           NOT NULL,
  losses        BIGINT           NOT NULL,
  ties          BIGINT           NOT NULL,
  snapshot_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  snapshot_by   UUID             NULL,
  PRIMARY KEY (season_id, player_id)
);

COMMENT ON TABLE public.season_standings_final IS
  'Frozen season_standings rows for each closed season (seasons.closed_at NOT NULL). Written by close_season(), deleted by reopen_season(); never written by clients.';

ALTER TABLE public.season_standings_final ENABLE ROW LEVEL SECURITY;

CREATE POLICY season_standings_final_select
  ON public.season_standings_final FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.season_standings_final FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.season_standings_final FROM authenticated, service_role;
GRANT SELECT ON public.season_standings_final TO authenticated, service_role;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.season_standings_final',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '059: anon holds a privilege on season_standings_final';
  END IF;
  IF has_table_privilege('authenticated', 'public.season_standings_final', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.season_standings_final', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '059: a client role can write season_standings_final';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.season_standings_final', 'SELECT') THEN
    RAISE EXCEPTION '059: authenticated cannot read season_standings_final';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.season_standings_final'::regclass) THEN
    RAISE EXCEPTION '059: RLS is not enabled on season_standings_final';
  END IF;
END $$;
