import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmToast } from '../components/ConfirmToast';
import { listGroups } from '../api/groups';
import type { Group } from '../types';

interface FlashState { flash?: string }

export function Groups() {
  const navigate = useNavigate();
  const location = useLocation();
  const flash = (location.state as FlashState | null)?.flash ?? null;
  const [toast, setToast] = useState<string | null>(flash);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Consume the flash state once so the message doesn't reappear on back/forward.
  useEffect(() => {
    if (flash) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [flash, navigate, location.pathname]);

  const load = () => {
    setLoading(true);
    setError(null);
    listGroups()
      .then(setGroups)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load groups'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const columns = [
    { key: 'name', label: 'Group name' },
    {
      key: 'id',
      label: '',
      render: (r: Group) => (
        <Link to={`/groups/${r.id}`}>View seasons</Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Groups" subtitle="League units; select a group to view seasons and standings." />
      <div className="card">
        {groups.length === 0 ? (
          <EmptyState message="No groups yet. Create groups in the backend or via Supabase." />
        ) : (
          <DataTable
            columns={columns}
            data={groups}
            getRowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/groups/${r.id}`)}
          />
        )}
      </div>
      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} />}
    </>
  );
}
