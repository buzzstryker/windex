import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { isCurrentUserSuperAdmin } from '../api/groups';
import {
  eventTypeLabel,
  formatTimestamp,
  getPlayersWithLastActivity,
  type PlayerWithLastActivity,
} from '../api/activity';

/**
 * App Activity — list view.
 *
 * Super-admin-only. Renders every player from the players table, with
 * their most-recent activity event timestamp + a human-readable summary
 * of the event. Players who have never produced an event sort to the
 * bottom alphabetically (per migration 024's RPC).
 *
 * Token refresh events are filtered out at the view layer (migration 024,
 * `activity_events` WHERE event_type <> 'token_refresh'). They remain in
 * `login_events` for security audit purposes but never appear here.
 */
export function Activity() {
  const [rows, setRows] = useState<PlayerWithLastActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([isCurrentUserSuperAdmin(), getPlayersWithLastActivity()])
      .then(([admin, list]) => {
        setIsSuperAdmin(admin);
        setRows(list);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;
  if (isSuperAdmin === false) {
    return (
      <>
        <PageHeader title="App Activity" />
        <div className="card">
          <p style={{ color: '#666' }}>This page is restricted to super admins.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="App Activity"
        subtitle="Per-player audit of logins, group switches, and tab views. Token refresh events are excluded."
      />

      <div className="card">
        {rows.length === 0 ? (
          <EmptyState message="No players in the database." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                <th style={th}>Player</th>
                <th style={th}>Email</th>
                <th style={th}>Last activity</th>
                <th style={th}>Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasActivity = r.last_event_at !== null;
                return (
                  <tr key={r.player_id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={td}>
                      <Link to={`/activity/${encodeURIComponent(r.player_id)}`} style={{ fontWeight: 600 }}>
                        {r.display_name}
                      </Link>
                    </td>
                    <td style={{ ...td, color: '#666' }}>{r.email ?? '—'}</td>
                    <td style={{ ...td, color: hasActivity ? '#1a1a1a' : '#999' }}>
                      {hasActivity ? formatTimestamp(r.last_event_at) : 'NA'}
                    </td>
                    <td style={{ ...td, color: hasActivity ? '#1a1a1a' : '#999' }}>
                      {hasActivity ? eventTypeLabel(r.last_event_type) : 'NA'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const th: React.CSSProperties = { padding: '8px 10px' };
const td: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };
