import { apiFetch, ApiError } from './client';
import type { EventSummary, EventDetail, IngestEventRequest } from '../types';

/**
 * List events. GET /events (query: group_id?, season_id?, source_app?, status?, from_date?, to_date?).
 * If endpoint missing (404), returns [] so UI remains navigable.
 */
export async function listEvents(params: {
  group_id?: string;
  season_id?: string;
  source_app?: string;
  status?: string;
  attribution_status?: string;
  from_date?: string;
  to_date?: string;
}): Promise<EventSummary[]> {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== '') q.set(k, v);
  });
  const query = q.toString();
  const path = query ? `/events?${query}` : '/events';
  try {
    const data = await apiFetch<{ events?: EventSummary[]; data?: EventSummary[] }>(path);
    return (data as { events?: EventSummary[] })?.events ?? (data as { data?: EventSummary[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Get single event detail. Assumes GET /events/:eventId.
 */
export async function getEvent(eventId: string): Promise<EventDetail> {
  return apiFetch<EventDetail>(`/events/${eventId}`);
}

/**
 * Ingest event (manual or API). Uses documented POST /ingest-event-results.
 */
export async function ingestEvent(body: IngestEventRequest): Promise<{ id: string; league_round_id: string }> {
  return apiFetch<{ id: string; league_round_id: string }>('/ingest-event-results', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Update event / round override. Assumes PATCH or PUT /events/:eventId if backend supports it.
 * If not implemented, document as backend gap.
 */
export async function updateEvent(
  eventId: string,
  body: Partial<{
    round_date: string;
    season_id: string | null;
    results: { player_id: string; score_value?: number; score_override?: number | null }[];
    override_actor?: string | null;
    override_reason?: string | null;
  }>
): Promise<EventDetail> {
  return apiFetch<EventDetail>(`/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
