/**
 * Generic CSV adapter: parse a CSV of round point totals into external round shape.
 * Data must be awarded point totals per player (not golf scorecard or stroke data).
 * Expected columns (case-insensitive): round_date, player_name, points; optional: event_id, source_player_ref.
 */

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === "," && !inQuotes) || (c === "\n" && !inQuotes)) {
      out.push(current.trim());
      current = "";
      if (c === "\n") break;
    } else {
      current += c;
    }
  }
  out.push(current.trim());
  return out;
}

function findColumnIndex(headers, names) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const i = lower.indexOf(name.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Parse a CSV string into an external round { event_id?, round_date, scores }.
 * Required columns: round_date (or date), player_name (or player), points (awarded point total; column alias "score" or "pts" accepted).
 */
export function parseGenericCsv(csvText) {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV must have header row and at least one data row");
  }
  const headers = parseCsvLine(lines[0]);
  const dateIdx = findColumnIndex(headers, ["round_date", "date", "round date"]);
  const playerNameIdx = findColumnIndex(headers, ["player_name", "player name", "player", "name"]);
  const pointsIdx = findColumnIndex(headers, ["points", "point", "score", "pts"]);
  const eventIdIdx = findColumnIndex(headers, ["event_id", "event id", "external_event_id"]);
  const refIdx = findColumnIndex(headers, ["source_player_ref", "player_ref", "player id", "player_id"]);

  if (dateIdx < 0 || playerNameIdx < 0 || pointsIdx < 0) {
    throw new Error(
      "CSV must include round_date (or date), player_name (or player), and a points column (header may be 'points', 'pts', or 'score' for point total). Found: " +
        headers.join(", ")
    );
  }

  let roundDate = "";
  let eventId = null;
  const scores = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const date = cells[dateIdx] ?? "";
    const name = (cells[playerNameIdx] ?? "").trim();
    const ptsStr = (cells[pointsIdx] ?? "").trim();
    if (!date || !name) continue;
    if (!roundDate) roundDate = date;
    const points = Number(ptsStr);
    if (Number.isNaN(points)) continue;
    if (eventId == null && eventIdIdx >= 0 && cells[eventIdIdx]) {
      eventId = cells[eventIdIdx].trim();
    }
    const score = { points, source_player_name: name };
    if (refIdx >= 0 && cells[refIdx]) {
      score.source_player_ref = cells[refIdx].trim();
    }
    scores.push(score);
  }

  if (!roundDate || scores.length === 0) {
    throw new Error("CSV did not produce a round_date or any point rows");
  }

  return {
    ...(eventId && { event_id: eventId }),
    round_date: roundDate,
    scores,
  };
}
