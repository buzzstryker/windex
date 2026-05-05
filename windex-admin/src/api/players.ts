import { apiFetch, ApiError } from './client';
import type { Player } from '../types';

/**
 * List canonical players. GET /players. Optional group_id to restrict to active members of that group.
 * If endpoint missing (404), returns [] so UI remains navigable.
 */
export async function listPlayers(groupId?: string): Promise<Player[]> {
  const path = groupId ? `/players?group_id=${encodeURIComponent(groupId)}` : '/players';
  try {
    const data = await apiFetch<{ players?: Player[]; data?: Player[] }>(path);
    return (data as { players?: Player[] })?.players ?? (data as { data?: Player[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}
