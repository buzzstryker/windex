import { apiFetch, ApiError } from './client';
import type { Group, Season } from '../types';

/**
 * List groups. GET /groups. If missing (404), returns [] so UI remains navigable.
 */
export async function listGroups(): Promise<Group[]> {
  try {
    const data = await apiFetch<{ groups?: Group[]; data?: Group[] }>('/groups');
    return (data as { groups?: Group[] })?.groups ?? (data as { data?: Group[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * List seasons. GET /seasons?group_id=. If missing (404), returns [].
 */
export async function listSeasons(groupId?: string): Promise<Season[]> {
  const path = groupId ? `/seasons?group_id=${encodeURIComponent(groupId)}` : '/seasons';
  try {
    const data = await apiFetch<{ seasons?: Season[]; data?: Season[] }>(path);
    return (data as { seasons?: Season[] })?.seasons ?? (data as { data?: Season[] })?.data ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}
