import React from 'react';

interface EmptyStateProps {
  message: string;
  action?: React.ReactNode;
  /** Optional extra line (e.g. when items would appear). */
  detail?: string;
}

export function EmptyState({ message, action, detail }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <p>{message}</p>
      {detail && <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>{detail}</p>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
