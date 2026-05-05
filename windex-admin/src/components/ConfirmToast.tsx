import React, { useEffect } from 'react';

interface ConfirmToastProps {
  message: string;
  onClose: () => void;
  duration?: number;
}

export function ConfirmToast({ message, onClose, duration = 3000 }: ConfirmToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, duration);
    return () => clearTimeout(t);
  }, [onClose, duration]);
  return <div className="toast" role="status">{message}</div>;
}
