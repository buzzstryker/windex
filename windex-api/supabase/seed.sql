-- Deterministic local seed: one section, one group, one season, two players (members), one test user.
-- Run with: supabase db reset (after migrations).
-- Test user: test@lateadd.local / testpass123

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Fixed IDs for reproducible tests
DO $$
DECLARE
  v_user_id     UUID := 'a0000000-0000-0000-0000-000000000001';
  v_encrypted_pw TEXT := crypt('testpass123', gen_salt('bf'));
  v_section_id  TEXT := 'section-seed-001';
  v_group_id    TEXT := 'group-seed-001';
  v_season_id   TEXT := 'season-seed-001';
BEGIN
  -- Token columns must be '' not NULL or GoTrue fails with "Database error querying schema"
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    confirmation_token, email_change, email_change_token_new, recovery_token,
    created_at, updated_at
  )
  VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'test@lateadd.local',
    v_encrypted_pw,
    NOW(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    '',
    '',
    '',
    '',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  )
  VALUES (
    'b0000000-0000-0000-0000-000000000001',
    v_user_id,
    format('{"sub": "%s", "email": "test@lateadd.local"}', v_user_id)::jsonb,
    'email',
    v_user_id::text,
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO sections (id, user_id, name, created_at, updated_at)
  VALUES (v_section_id, v_user_id, 'Seed Section', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO groups (id, user_id, name, section_id, season_start_month, scoring_mode, created_at, updated_at)
  VALUES (v_group_id, v_user_id, 'Seed Group', v_section_id, 1, 'points', NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET scoring_mode = 'points';

  INSERT INTO players (id, user_id, display_name, is_active, created_at, updated_at)
  VALUES
    ('player-1', v_user_id, 'Player 1', 1, NOW(), NOW()),
    ('player-2', v_user_id, 'Player 2', 1, NOW(), NOW())
  ON CONFLICT (id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW();

  INSERT INTO group_members (id, group_id, player_id, role, is_active, joined_at)
  VALUES
    ('gm-1', v_group_id, 'player-1', 'member', 1, NOW()),
    ('gm-2', v_group_id, 'player-2', 'member', 1, NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO seasons (id, group_id, start_date, end_date, created_at, updated_at)
  VALUES (v_season_id, v_group_id, '2025-01-01', '2025-12-31', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  -- Second group (win_loss_override) + season; same two players (multi-group)
  INSERT INTO groups (id, user_id, name, section_id, season_start_month, scoring_mode, created_at, updated_at)
  VALUES ('group-seed-002', v_user_id, 'Seed Group Win/Loss', v_section_id, 1, 'win_loss_override', NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET scoring_mode = 'win_loss_override';

  INSERT INTO group_members (id, group_id, player_id, role, is_active, joined_at)
  VALUES
    ('gm-3', 'group-seed-002', 'player-1', 'member', 1, NOW()),
    ('gm-4', 'group-seed-002', 'player-2', 'member', 1, NOW())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO seasons (id, group_id, start_date, end_date, created_at, updated_at)
  VALUES ('season-seed-002', 'group-seed-002', '2025-01-01', '2025-12-31', NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  -- One pending player-mapping queue item for testing review flow
  INSERT INTO player_mapping_queue (id, user_id, source_app, source_player_name, source_player_ref, related_league_round_id, status, created_at, updated_at)
  VALUES (
    'a1000000-0000-0000-0000-000000000001',
    v_user_id,
    'test_app',
    'Unknown Golfer',
    NULL,
    NULL,
    'pending',
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
END $$;
