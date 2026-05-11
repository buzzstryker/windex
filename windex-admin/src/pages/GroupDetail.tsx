import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { DataTable } from '../components/DataTable';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { ConfirmModal } from '../components/ConfirmModal';
import { ConfirmToast } from '../components/ConfirmToast';
import { CreateSeasonModal } from '../components/CreateSeasonModal';
import {
  listGroups,
  listSeasons,
  isCurrentUserSuperAdmin,
  getGroupDeleteCounts,
  deleteGroup,
  type GroupDeleteCounts,
} from '../api/groups';
import type { Group, Season } from '../types';
import { seasonLabel } from '../types';

export function GroupDetail() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [createSeasonOpen, setCreateSeasonOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reloadSeasons = useCallback(async () => {
    if (!groupId) return;
    try {
      const s = await listSeasons(groupId);
      setSeasons(s);
    } catch (e) {
      // soft-fail — leave existing seasons in place
      console.warn('Failed to reload seasons:', e);
    }
  }, [groupId]);

  useEffect(() => {
    if (!groupId) return;
    setLoading(true);
    setError(null);
    Promise.all([listGroups(), listSeasons(groupId), isCurrentUserSuperAdmin()])
      .then(([groups, seasonsList, superAdmin]) => {
        const g = groups.find((x) => x.id === groupId) ?? null;
        setGroup(g);
        setSeasons(seasonsList);
        setIsSuperAdmin(superAdmin);
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Seasons</h2>
          {isSuperAdmin && group && (
            <button
              className="btn btn-primary"
              onClick={() => setCreateSeasonOpen(true)}
              style={{ padding: '6px 12px', fontSize: 13 }}
            >
              + Create Season
            </button>
          )}
        </div>
        {seasons.length === 0 ? (
          <EmptyState message="No seasons for this group yet." />
        ) : (
          <DataTable columns={columns} data={seasons} getRowKey={(r) => r.id} />
        )}
      </div>

      {isSuperAdmin && group && (
        <CreateSeasonModal
          open={createSeasonOpen}
          group={group}
          existingSeasons={seasons}
          onClose={() => setCreateSeasonOpen(false)}
          onSuccess={(s) => {
            setCreateSeasonOpen(false);
            setToast(`Season ${seasonLabel(s)} created (${s.start_date} → ${s.end_date})`);
            reloadSeasons();
          }}
        />
      )}

      {toast && <ConfirmToast message={toast} onClose={() => setToast(null)} duration={5000} />}

      {isSuperAdmin && group && (
        <DangerZone
          group={group}
          onDeleted={() =>
            navigate('/groups', {
              state: { flash: `Group "${group.name}" deleted` },
            })
          }
        />
      )}
    </>
  );
}

function DangerZone({ group, onDeleted }: { group: Group; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<GroupDeleteCounts | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openModal = async () => {
    setOpen(true);
    setCounts(null);
    setCountError(null);
    setDeleteError(null);
    setCountLoading(true);
    try {
      const c = await getGroupDeleteCounts(group.id);
      setCounts(c);
    } catch (e) {
      setCountError(e instanceof Error ? e.message : 'Failed to compute counts');
    } finally {
      setCountLoading(false);
    }
  };

  const closeModal = () => {
    if (deleting) return;
    setOpen(false);
    setDeleteError(null);
  };

  const onConfirm = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteGroup(group.id);
      onDeleted();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(false);
    }
  };

  return (
    <>
      <div
        className="card"
        style={{
          border: '1px solid #f5c6c2',
          background: '#fffafa',
        }}
      >
        <h2 style={{ color: '#b71c1c', margin: '0 0 8px 0' }}>Danger zone</h2>
        <p style={{ margin: '0 0 12px 0', color: '#555' }}>
          Permanently delete this group and all of its seasons, rounds, scores, and member rows.
          Player records are not removed.
        </p>
        <button
          onClick={openModal}
          className="btn"
          style={{ background: '#c62828', color: '#fff' }}
        >
          Delete Group
        </button>
      </div>

      <ConfirmModal
        open={open}
        title="Delete group"
        destructive
        confirmLabel="Delete Permanently"
        busy={deleting}
        errorMessage={deleteError ?? countError}
        onConfirm={onConfirm}
        onCancel={closeModal}
      >
        <p style={{ marginTop: 0 }}>
          You are about to permanently delete{' '}
          <strong style={{ fontSize: '1.05em' }}>{group.name}</strong>.
        </p>

        {countLoading && <p style={{ color: '#555' }}>Calculating impact…</p>}

        {counts && (
          <>
            <p style={{ margin: '12px 0 4px 0' }}>This will also delete:</p>
            <ul style={{ margin: '0 0 12px 20px', padding: 0 }}>
              <li>{counts.members} group member {counts.members === 1 ? 'row' : 'rows'}</li>
              <li>{counts.seasons} season{counts.seasons === 1 ? '' : 's'}</li>
              <li>{counts.rounds} round{counts.rounds === 1 ? '' : 's'}</li>
              <li>{counts.scores} score{counts.scores === 1 ? '' : 's'} (via rounds)</li>
            </ul>
            <p style={{ margin: '8px 0', color: '#555', fontSize: 13 }}>
              Player records remain in the <code>players</code> table; players whose only
              membership was this group will be left orphaned.
            </p>
          </>
        )}

        <p style={{ margin: '12px 0 0 0', color: '#b71c1c', fontWeight: 600 }}>
          This action cannot be undone.
        </p>
      </ConfirmModal>
    </>
  );
}
