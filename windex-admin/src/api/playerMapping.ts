import { apiFetch, ApiError } from './client';
import type { PlayerMappingItem } from '../types';

/**
 * List unresolved player mapping items. GET /review/player-mapping. If missing (404), returns [].
 */
export async function listPlayerMappingQueue(): Promise<PlayerMappingItem[]> {
  try {
    const data = await apiFetch<{ items?: PlayerMappingItem[]; data?: PlayerMappingItem[] }>('/review/player-mapping');
    return (data as { items?: PlayerMappingItem[] })?.items ?? (data as { data?: PlayerMappingItem[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * Resolve player mapping: link source identity to Windex player. Assumes POST /review/player-mapping/:id/resolve.
 */
export async function resolvePlayerMapping(
  itemId: string,
  body: { player_id: string }
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/review/player-mapping/${itemId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
