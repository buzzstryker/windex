import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmModal } from '../components/ConfirmModal';
import { JsonTree } from '../components/JsonTree';
import { isCurrentUserSuperAdmin } from '../api/groups';
import { formatTimestamp, relativeTime } from '../api/activity';
import {
  getBroadcastNotesAudit,
  listBroadcastNotesAudits,
  regenerateBroadcastNotes,
  type BroadcastNotesAuditDetail as Detail,
  type FactCheckAnnotation,
  type FactCheckClaim,
} from '../api/broadcastNotesAudit';

type Filter = 'all' | 'wrong' | 'ambiguous' | 'wrong_ambiguous' | 'verified';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'wrong', label: 'Wrong only' },
  { key: 'ambiguous', label: 'Ambiguous only' },
  { key: 'wrong_ambiguous', label: 'Wrong + Ambiguous' },
  { key: 'verified', label: 'Verified only' },
];

const KNOWN_STATUS = new Set(['verified', 'wrong', 'ambiguous', 'unverifiable']);

function StatusChip({ status }: { status: string }) {
  const cls = KNOWN_STATUS.has(status) ? status : 'none';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function ReasoningCell({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span style={{ color: '#bbb' }}>—</span>;
  const long = text.length > 180;
  const shown = long && !open ? text.slice(0, 180) + '…' : text;
  return (
    <span style={{ fontSize: 12, color: '#555' }}>
      {shown}
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ border: 'none', background: 'none', color: '#1565c0', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  );
}

export function BroadcastNotesAuditDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>('wrong_ambiguous');
  const [payloadOpen, setPayloadOpen] = useState(false);

  const [regenOpen, setRegenOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    Promise.all([isCurrentUserSuperAdmin(), getBroadcastNotesAudit(id)])
      .then(([admin, row]) => {
        setIsSuperAdmin(admin);
        setDetail(row);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const doRegenerate = async () => {
    if (!detail) return;
    setRegenerating(true);
    setRegenError(null);
    try {
      await regenerateBroadcastNotes(detail.group_id, detail.player_ids);
      // The generate function doesn't return the new row id; the just-written
      // audit row is the newest, so navigate to the top of the list.
      const rows = await listBroadcastNotesAudits();
      setRegenOpen(false);
      if (rows.length > 0) navigate(`/broadcast-notes-audit/${rows[0].id}`);
      else window.location.reload();
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  };

  if (!id) return <ErrorState message="Missing generation id" />;
  if (loading) return <LoadingSpinner />;

  if (isSuperAdmin === false) {
    return (
      <>
        <PageHeader title="Broadcast Notes Audit" />
        <div className="card">
          <p style={{ color: '#666' }}>This page is restricted to super admins.</p>
        </div>
      </>
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (!detail) return <EmptyState message="Generation not found." />;

  const fca = detail.fact_check_audit;
  const annotations: FactCheckAnnotation[] = fca?.annotations ?? [];
  // New-shape rows persist the original claims; older rows don't. When present,
  // join claim text + source onto each annotation by id; when absent, fall back
  // to id-only display with a gap banner.
  const claims: FactCheckClaim[] = fca?.claims ?? [];
  const hasClaims = claims.length > 0;
  const claimsById = new Map(claims.map((c) => [c.id, c]));
  const filtered = annotations.filter((a) => {
    switch (filter) {
      case 'all': return true;
      case 'wrong': return a.status === 'wrong';
      case 'ambiguous': return a.status === 'ambiguous';
      case 'wrong_ambiguous': return a.status === 'wrong' || a.status === 'ambiguous';
      case 'verified': return a.status === 'verified';
    }
  });

  const claudeModel = fca?.claude_model ?? detail.model ?? null;
  const perplexityModel = fca?.perplexity_model ?? null;

  return (
    <>
      <PageHeader
        title="Broadcast Notes Audit"
        subtitle={`${relativeTime(detail.created_at) ?? ''} / ${formatTimestamp(detail.created_at)}${detail.group_name ? ` · ${detail.group_name}` : ''}`}
        action={
          <>
            <button className="btn btn-primary" onClick={() => { setRegenError(null); setRegenOpen(true); }}>
              Regenerate
            </button>
            <Link to="/broadcast-notes-audit" className="btn btn-secondary" style={{ display: 'inline-block', marginLeft: 8 }}>
              Back to list
            </Link>
          </>
        }
      />

      {/* Header detail */}
      <div className="card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888' }}>Spotlight players</div>
            <div style={{ fontWeight: 600 }}>{detail.spotlight_names.join(', ') || '—'}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888' }}>Group</div>
            <div>{detail.group_name ?? detail.group_id}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888' }}>Models</div>
            <div style={{ fontSize: 13 }}>
              Claude: {claudeModel ?? '—'}
              {perplexityModel ? ` · Perplexity: ${perplexityModel}` : ''}
            </div>
          </div>
        </div>
      </div>

      {/* 1. Generated notes (prose) */}
      <div className="card">
        <h2>Generated notes</h2>
        <p style={{ color: '#888', fontSize: 13, margin: 0 }}>
          Notes prose not stored — see PWA or function response logs. (Only the claims, fact-check
          verdicts, and input payload are persisted on the audit row.)
        </p>
      </div>

      {/* 2. Claims + annotations */}
      <div className="card">
        <h2>Claims &amp; fact-check</h2>
        {fca == null ? (
          <p style={{ color: '#888', fontSize: 13 }}>No fact-check was run for this generation.</p>
        ) : (
          <>
            {fca.error && (
              <div role="alert" style={{ marginBottom: 12, padding: '10px 12px', background: '#ffebee', color: '#c62828', border: '1px solid #f5c6c2', borderRadius: 4, fontSize: 13 }}>
                Fact-check hard-failed: {fca.error}
              </div>
            )}
            {!hasClaims && (
              <p style={{ color: '#888', fontSize: 12, marginTop: 0 }}>
                Claim text and source aren't persisted on this (older) generation — showing the
                fact-checker's claim ID, verdict, correction, and reasoning.
              </p>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`btn ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '5px 10px', fontSize: 12 }}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {annotations.length === 0 ? (
              <p style={{ color: '#888', fontSize: 13 }}>No claims recorded.</p>
            ) : filtered.length === 0 ? (
              <p style={{ color: '#888', fontSize: 13 }}>No claims match this filter.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {hasClaims ? (
                        <>
                          <th>Claim</th>
                          <th style={{ width: 140 }}>Source</th>
                        </>
                      ) : (
                        <th style={{ width: 70 }}>Claim</th>
                      )}
                      <th style={{ width: 110 }}>Status</th>
                      <th>Correction</th>
                      <th>Reasoning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((a, i) => {
                      const claim = a.id ? claimsById.get(a.id) : undefined;
                      return (
                        <tr key={a.id ?? i}>
                          {hasClaims ? (
                            <>
                              <td>
                                {claim?.claim ?? (
                                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#999' }}>
                                    {a.id ?? '—'}
                                  </span>
                                )}
                              </td>
                              <td>
                                {claim?.source ? (
                                  <span className={`badge source-${claim.source}`}>{claim.source}</span>
                                ) : (
                                  <span style={{ color: '#bbb' }}>—</span>
                                )}
                              </td>
                            </>
                          ) : (
                            <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{a.id ?? '—'}</td>
                          )}
                          <td><StatusChip status={String(a.status ?? 'unknown')} /></td>
                          <td style={{ fontStyle: a.correction ? 'italic' : 'normal', color: a.correction ? '#333' : '#bbb' }}>
                            {a.correction || '—'}
                          </td>
                          <td><ReasoningCell text={a.reasoning} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* 3. Input payload */}
      <div className="card">
        <button
          type="button"
          onClick={() => setPayloadOpen((o) => !o)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', display: 'flex', alignItems: 'center', gap: 8, padding: 0 }}
        >
          <span style={{ color: '#555' }}>{payloadOpen ? '▾' : '▸'}</span>
          <h2 style={{ margin: 0 }}>Input payload sent to Claude</h2>
        </button>
        {payloadOpen && (
          <div style={{ marginTop: 12 }}>
            {detail.input_data == null ? (
              <p style={{ color: '#888', fontSize: 13 }}>Input payload not captured for this generation.</p>
            ) : (
              <JsonTree data={detail.input_data} defaultExpandDepth={1} />
            )}
          </div>
        )}
      </div>

      {/* Regenerate modal */}
      <ConfirmModal
        open={regenOpen}
        title="Regenerate broadcast notes"
        confirmLabel="Generate"
        busy={regenerating}
        errorMessage={regenError}
        onCancel={() => { if (!regenerating) { setRegenOpen(false); setRegenError(null); } }}
        onConfirm={doRegenerate}
      >
        <div style={{ fontSize: 14, lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>
            Re-run the generation for these spotlight players in <strong>{detail.group_name ?? detail.group_id}</strong>:
          </p>
          <p style={{ margin: '10px 0 0', fontWeight: 600 }}>{detail.spotlight_names.join(', ') || '—'}</p>
          <p style={{ margin: '12px 0 0', color: '#666', fontSize: 13 }}>
            This calls the same pipeline the PWA uses (Claude → Perplexity → Claude) and writes a new
            audit row. It typically takes 30–60 seconds. On success you'll be taken to the new row.
          </p>
        </div>
      </ConfirmModal>
    </>
  );
}
