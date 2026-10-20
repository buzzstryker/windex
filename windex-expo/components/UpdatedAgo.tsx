import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

/**
 * "Updated 6 min ago" under the season pill. Rendered by the Standings screen
 * only while the current season's rows on screen came from the device cache and
 * no fetch has succeeded since; it ticks every 30 s so the age keeps up while
 * offline.
 */
export function UpdatedAgo({ updatedAt, color }: { updatedAt: number; color: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return <Text style={[styles.text, { color }]}>Updated {formatAge(now - updatedAt)}</Text>;
}

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const styles = StyleSheet.create({
  text: { fontSize: 12, marginHorizontal: 16, marginTop: -6, marginBottom: 8 },
});
