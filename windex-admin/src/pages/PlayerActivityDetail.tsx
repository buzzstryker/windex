import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { isCurrentUserSuperAdmin } from '../api/groups';
import {
  eventTypeLabel,
  formatTimestamp,
  getPlayerActivitySummary,
  getPlayerActivityTimeline,
  relativeTime,
  seasonYearLabel,
  type ActivityTimelineRow,
  type PlayerActivitySummary,
} from '../api/activity';

const PAGE_SIZE = 100;

/**
 * App Activity — per-player detail view.
 *
 * Super-admin-only. Shows a summary block (total events, first/last seen,
 * per-type counts) plus a reverse-chronological timeline of the player's
 * events. Pagination via explicit "Load more" — no auto-infinite-scroll.
 */
export function PlayerActivityDetail() {
  const { playerId: rawPlayerId } = useParams<{ playerId: string }>();
  const playerId = rawPlayerId ?? '';

  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<PlayerActivitySummary | null>(null);
  const [timeline, setTimeline] = useState<ActivityTimelineRow[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState<string>('');
  const [playerEmail, setPlayerEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!playerId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      isCurrentUserSuperAdmin(),
      getPlayerActivitySummary(playerId),
      getPlayerActivityTimeline(playerId, PAGE_SIZE),
    ])
      .then(([admin, sum, tl]) => {
        setIsSuperAdmin(admin);
        setSummary(sum);
        setTimeline(tl);
        // Try to derive the player's display label from any timeline row's
        // metadata (none of our event rows carry it directly). Otherwise fall
        // back to the playerId in the header. The list page already shows
        // the canonical display_name → link came from there.
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [playerId]);

  // Best-effort fetch of player name + email via the same RPC the list page uses
  // (one quick call, fine to do once on mount). If it fails, we degrade gracefully
  // and show the player_id in the header.
  useEffect(() => {
    if (!playerId) return;
    let cancelled = false;
    import('../api/activity').then(({ getPlayersWithLastActivity }) =>
      getPlayersWithLastActivity()
        .then((rows) => {
          if (cancelled) return;
          const me = rows.find((r) => r.player_id === playerId);
          if (me) {
            setPlayerName(me.display_name);
            setPlayerEmail(me.email);
          }
        })
        .catch(() => {/* silent — header degrades to id */})
    );
    return () => { cancelled = true; };
  }, [playerId]);

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

  const headerTitle = playerName || playerId.slice(0, 12);
  const headerSubtitle = playerEmail ?? undefined;

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      const nextLimit = limit + PAGE_SIZE;
      const more = await getPlayerActivityTimeline(playerId, nextLimit);
      setTimeline(more);
      setLimit(nextLimit);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const hasMore = summary !== null && timeline.length < summary.total_events;

  return (
    <>
      <PageHeader title={headerTitle} subtitle={headerSubtitle} />

      <div className="card" style={{ marginBottom: 12 }}>
        <Link to="/activity">← Back to App Activity</Link>
      </div>

      {/* Summary block */}
      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Summary</h2>
        {summary && summary.total_events > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 6, fontSize: 14 }}>
            <div style={{ color: '#666' }}>Total events</div>
            <div style={{ fontWeight: 600 }}>{summary.total_events.toLocaleString()}</div>

            <div style={{ color: '#666' }}>First seen</div>
            <div>{formatTimestamp(summary.first_event_at)}</div>

            <div style={{ color: '#666' }}>Last seen</div>
            <div>
              {formatTimestamp(summary.last_event_at)}
              {summary.last_event_at && (
                <span style={{ color: '#999', marginLeft: 8, fontSize: 12 }}>
                  ({relativeTime(summary.last_event_at)})
                </span>
              )}
            </div>

            <div style={{ color: '#666', alignSelf: 'start' }}>Breakdown</div>
            <div>
              <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
                <tbody>
                  {Object.entries(summary.event_type_counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <tr key={type}>
                        <td style={{ padding: '2px 12px 2px 0', color: '#1a1a1a' }}>{eventTypeLabel(type)}</td>
                        <td style={{ padding: '2px 0', fontWeight: 600, textAlign: 'right' }}>{count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p style={{ color: '#666' }}>No activity recorded for this player yet.</p>
        )}
      </div>

      {/* Timeline */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Timeline</h2>
        {timeline.length === 0 ? (
          <EmptyState message="No activity recorded for this player yet." />
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                  <th style={th}>When</th>
                  <th style={th}>Event</th>
                  <th style={th}>Context</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatTimestamp(row.occurred_at)}</td>
                    <td style={td}>{eventTypeLabel(row.event_type)}</td>
                    <td style={{ ...td, color: '#444' }}>{contextLabel(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMore && (
              <div style={{ marginTop: 12, textAlign: 'center' }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  style={{ padding: '6px 14px', fontSize: 13 }}
                >
                  {loadingMore ? 'Loading…' : `Load more (showing ${timeline.length} of ${summary?.total_events ?? '?'})`}
                </button>
              </div>
            )}
            {!hasMore && summary && (
              <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: '#999' }}>
                Showing all {summary.total_events} events.
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * Per-event-type context column. group_switch shows "from → to"; view_*
 * shows "<Group> / <year>"; login_success / logout have no context.
 */
function contextLabel(row: ActivityTimelineRow): string {
  if (row.event_type === 'group_switch') {
    const from = row.from_group_name ?? row.from_group_id ?? '?';
    const to = row.group_name ?? row.group_id ?? '?';
    return `${from} → ${to}`;
  }
  if (row.event_type === 'view_leaderboard' || row.event_type === 'view_rounds_list') {
    const group = row.group_name ?? row.group_id ?? '';
    const season = seasonYearLabel(row.season_start_date, row.season_end_date);
    if (group && season) return `${group} / ${season}`;
    return group || season || '—';
  }
  return '—';
}

const th: React.CSSProperties = { padding: '8px 10px' };
const td: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'top' };
