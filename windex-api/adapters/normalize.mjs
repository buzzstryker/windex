/**
 * Normalize an external round into the ingest-event-results request body.
 * Input must be final awarded point totals per player (not golf scorecard data).
 * Maps event_id, round_date, players, and point totals into the API format.
 * Player identity: use source_player_ref when available, else source_player_name;
 * unresolved identities will flow to player_mapping_queue when sent to the API.
 *
 * @param {Object} external - { event_id?, round_date, scores: [{ source_player_ref?, source_player_name?, player_id?, points }] }
 * @param {Object} options - { group_id, season_id?, source_app }
 * @returns {Object} Body for POST /ingest-event-results
 */
export function normalizeToIngest(external, options) {
  const { group_id, season_id, source_app } = options;
  const scores = external.scores.map((s) => {
    const score = { score_value: s.points };
    if (s.player_id != null && s.player_id !== "") {
      score.player_id = s.player_id;
    } else {
      if (s.source_player_ref != null && s.source_player_ref !== "") {
        score.source_player_ref = s.source_player_ref;
      }
      if (s.source_player_name != null && s.source_player_name !== "") {
        score.source_player_name = String(s.source_player_name).trim();
      }
    }
    return score;
  });

  return {
    group_id,
    ...(season_id != null && season_id !== "" && { season_id }),
    round_date: external.round_date,
    source_app,
    ...(external.event_id != null && external.event_id !== "" && { external_event_id: external.event_id }),
    scores,
  };
}
