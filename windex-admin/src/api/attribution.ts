import { apiFetch, ApiError } from './client';
import type { AttributionItem } from '../types';

/**
 * List unresolved attribution items. GET /review/attribution. If missing (404), returns [].
 */
export async function listAttributionQueue(): Promise<AttributionItem[]> {
  try {
    const data = await apiFetch<{ items?: AttributionItem[]; data?: AttributionItem[] }>('/review/attribution');
    return (data as { items?: AttributionItem[] })?.items ?? (data as { data?: AttributionItem[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Resolve attribution: assign event to group/season. Assumes POST /review/attribution/:id/resolve or equivalent.
 */
export async function resolveAttribution(
  itemId: string,
  body: { group_id: string; season_id?: string | null }
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/review/attribution/${itemId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
