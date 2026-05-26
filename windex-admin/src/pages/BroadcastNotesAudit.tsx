import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { isCurrentUserSuperAdmin } from '../api/groups';
import { formatTimestamp, relativeTime } from '../api/activity';
import { listBroadcastNotesAudits, type BroadcastNotesAuditRow } from '../api/broadcastNotesAudit';

function StatsBadges({ row }: { row: BroadcastNotesAuditRow }) {
  if (row.fact_check_status === 'none') return <span className="badge none">no fact-check</span>;
  if (row.fact_check_status === 'error') return <span className="badge fcerror">fact-check error</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: '#666' }}>{row.total_claims} claims</span>
      {row.wrong_count > 0 && <span className="badge wrong">{row.wrong_count} wrong</span>}
      {row.ambiguous_count > 0 && <span className="badge ambiguous">{row.ambiguous_count} ambiguous</span>}
      {row.wrong_count === 0 && row.ambiguous_count === 0 && (
        <span className="badge verified">all verified</span>
      )}
    </span>
  );
}

export function BroadcastNotesAudit() {
  const navigate = useNavigate();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [rows, setRows] = useState<BroadcastNotesAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([isCurrentUserSuperAdmin(), listBroadcastNotesAudits()])
      .then(([admin, list]) => {
        setIsSuperAdmin(admin);
        setRows(list);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

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

  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <>
      <PageHeader title="Broadcast Notes Audit" subtitle="Last 10 generations" />
      {rows.length === 0 ? (
        <EmptyState message="No broadcast notes generations yet. Generate one from the PWA." />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Spotlight</th>
                  <th>Group</th>
                  <th>Fact-check</th>
                  <th style={{ width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/broadcast-notes-audit/${r.id}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div>{relativeTime(r.created_at) ?? '—'}</div>
                      <div style={{ fontSize: 12, color: '#999' }}>{formatTimestamp(r.created_at)}</div>
                    </td>
                    <td>{r.spotlight_names.join(', ') || '—'}</td>
                    <td>{r.group_name ?? '—'}</td>
                    <td><StatsBadges row={r} /></td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: 13 }}
                        onClick={(e) => { e.stopPropagation(); navigate(`/broadcast-notes-audit/${r.id}`); }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
