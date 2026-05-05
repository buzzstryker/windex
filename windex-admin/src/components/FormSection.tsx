import React from 'react';

interface FormSectionProps {
  title?: string;
  children: React.ReactNode;
}

export function FormSection({ title, children }: FormSectionProps) {
  return (
    <div className="form-section">
      {title && <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>{title}</h3>}
      {children}
    </div>
  );
}
