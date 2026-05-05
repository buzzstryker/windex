import React from 'react';
import type { EventStatus } from '../types';

const LABELS: Record<string, string> = {
  processed: 'Processed',
  partial_unresolved_players: 'Partial (unresolved players)',
  pending_attribution: 'Pending attribution',
  pending_player_mapping: 'Pending player mapping',
  validation_error: 'Validation error',
  duplicate_ignored: 'Duplicate / ignored',
  attributed: 'Attributed',
  attribution_resolved: 'Attribution resolved',
};

const KNOWN_KEYS = [
  'processed', 'partial_unresolved_players', 'pending_attribution', 'pending_player_mapping',
  'validation_error', 'duplicate_ignored', 'attributed', 'attribution_resolved',
];

const statusToClass = (s: string): string => {
  const key = (s ?? '').replace(/\s+/g, '_').toLowerCase();
  if (key in LABELS || KNOWN_KEYS.includes(key)) return key;
  return 'processed';
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const cls = statusToClass(status);
  const label = LABELS[cls] ?? status;
  return <span className={`badge ${cls}`}>{label}</span>;
}
