import React, { useEffect } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  busy = false,
  errorMessage = null,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 8,
          maxWidth: 520,
          width: '100%',
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            background: destructive ? '#fdecea' : '#f5f5f5',
            borderBottom: `1px solid ${destructive ? '#f5c6c2' : '#e0e0e0'}`,
          }}
        >
          <h2 id="confirm-modal-title" style={{ margin: 0, fontSize: '1.1rem', color: destructive ? '#b71c1c' : '#1a1a1a' }}>
            {title}
          </h2>
        </div>
        <div style={{ padding: 20 }}>
          {children}
          {errorMessage && (
            <div
              role="alert"
              style={{
                marginTop: 16,
                padding: '10px 12px',
                background: '#ffebee',
                color: '#c62828',
                border: '1px solid #f5c6c2',
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              {errorMessage}
            </div>
          )}
        </div>
        <div
          style={{
            padding: '12px 20px',
            background: '#fafafa',
            borderTop: '1px solid #e0e0e0',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="btn"
            style={{
              background: destructive ? '#c62828' : '#0d47a1',
              color: '#fff',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
