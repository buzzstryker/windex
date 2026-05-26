import { useState } from 'react';

/**
 * Lightweight recursive JSON tree viewer — no external dependency (keeps
 * windex-admin's minimal dependency footprint). Expand/collapse per node and
 * copy-to-clipboard of any subtree. Inline-styled to match the admin UI.
 */

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function copy(value: unknown) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    void navigator.clipboard?.writeText(text);
  } catch {
    // clipboard unavailable — no-op
  }
}

function Primitive({ value }: { value: string | number | boolean | null }) {
  let color = '#1a1a1a';
  if (typeof value === 'number') color = '#1565c0';
  else if (typeof value === 'boolean') color = '#6a1b9a';
  else if (value === null) color = '#9e9e9e';
  else if (typeof value === 'string') color = '#2e7d32';
  const text = typeof value === 'string' ? `"${value}"` : String(value);
  return <span style={{ color, wordBreak: 'break-word' }}>{text}</span>;
}

interface NodeProps {
  k?: string | number;
  value: unknown;
  depth: number;
  defaultExpandDepth: number;
}

function Node({ k, value, depth, defaultExpandDepth }: NodeProps) {
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < defaultExpandDepth);

  const keyLabel =
    k !== undefined ? <span style={{ color: '#6d4c41' }}>{typeof k === 'number' ? k : `"${k}"`}: </span> : null;

  if (!isObject) {
    return (
      <div style={{ paddingLeft: depth * 16, lineHeight: 1.7, fontFamily: MONO, fontSize: 12.5 }}>
        {keyLabel}
        <Primitive value={value as string | number | boolean | null} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [i, v] as [number, unknown])
    : Object.entries(value as Record<string, unknown>);
  const count = entries.length;
  const open0 = isArray ? '[' : '{';
  const close0 = isArray ? ']' : '}';
  const summary = `${count} ${isArray ? (count === 1 ? 'item' : 'items') : (count === 1 ? 'key' : 'keys')}`;

  return (
    <div style={{ paddingLeft: depth * 16, fontFamily: MONO, fontSize: 12.5 }}>
      <div style={{ lineHeight: 1.7, display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{
            border: 'none', background: 'none', cursor: 'pointer', color: '#555',
            fontFamily: MONO, fontSize: 12.5, padding: 0, width: 14, textAlign: 'left',
          }}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▸'}
        </button>
        <span>
          {keyLabel}
          <span style={{ color: '#888' }}>{open0}</span>
          {!open && <span style={{ color: '#aaa' }}> {summary} {close0}</span>}
        </span>
        <button
          type="button"
          onClick={() => copy(value)}
          title="Copy this node as JSON"
          style={{
            border: '1px solid #e0e0e0', background: '#fafafa', cursor: 'pointer',
            color: '#666', fontSize: 11, borderRadius: 4, padding: '0 6px', marginLeft: 4,
          }}
        >
          copy
        </button>
      </div>
      {open && (
        <>
          {entries.map(([childKey, childVal]) => (
            <Node
              key={String(childKey)}
              k={childKey}
              value={childVal}
              depth={depth + 1}
              defaultExpandDepth={defaultExpandDepth}
            />
          ))}
          <div style={{ paddingLeft: 0, color: '#888', lineHeight: 1.7 }}>{close0}</div>
        </>
      )}
    </div>
  );
}

interface JsonTreeProps {
  data: unknown;
  /** Nodes at depth < this start expanded. Default 1 (root open, children collapsed). */
  defaultExpandDepth?: number;
}

export function JsonTree({ data, defaultExpandDepth = 1 }: JsonTreeProps) {
  return (
    <div style={{ background: '#fcfcfc', border: '1px solid #eee', borderRadius: 6, padding: 12, overflowX: 'auto' }}>
      <Node value={data} depth={0} defaultExpandDepth={defaultExpandDepth} />
    </div>
  );
}
