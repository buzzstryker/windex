import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { listGroups, listSeasons } from '../api/groups';
import type { Group, Season } from '../types';
import { seasonLabel } from '../types';

export function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const [group, setGroup] = useState<Group | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    Promise.all([listGroups(), listSeasons(groupId)])
      .then(([groups, seasonsList]) => {
        const g = groups.find((x) => x.id === groupId) ?? null;
        setGroup(g);
        setSeasons(seasonsList);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [groupId]);

  if (!groupId) return <ErrorState message="Missing group ID" onRetry={() => window.history.back()} />;
  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={() => window.location.reload()} />;

  const columns = [
    {
      key: 'name',
      label: 'Season',
      render: (s: Season) => seasonLabel(s),
    },
    {
      key: 'id',
      label: '',
      render: (s: Season) => (
        <Link to={`/standings?group_id=${groupId}&season_id=${s.id}`}>Standings</Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={group?.name ?? groupId.slice(0, 8)}
        subtitle="Seasons for this group"
      />
      <div className="card">
        <p style={{ marginBottom: 12 }}>
          <Link to="/groups">← Back to groups</Link>
        </p>
        <h2>Seasons</h2>
        {seasons.length === 0 ? (
          <EmptyState message="No seasons for this group yet." />
        ) : (
          <DataTable columns={columns} data={seasons} getRowKey={(r) => r.id} />
        )}
      </div>
    </>
  );
}
