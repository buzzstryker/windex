import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createGroup,
  DuplicateGroupNameError,
  type CreateGroupResult,
} from '../api/groups';
import { listAllPlayers, type PlayerDetail } from '../api/playerAdmin';
import { AddPlayerModal } from './AddPlayerModal';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB — matches bucket config
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (group: CreateGroupResult) => void;
}

/**
 * Super-admin-only modal for creating a new group.
 *
 * The form captures: name, optional logo image, season_start_month, and one
 * or more initial admin players. An inline "+ Add new player" affordance
 * opens the existing AddPlayerModal with no group assignments — the new
 * player is created via invite-player and then auto-selected as an admin in
 * this form. If group creation later fails, inline-created players are NOT
 * rolled back (they're valid standalone records).
 */
export function CreateGroupModal({ open, onClose, onSuccess }: CreateGroupModalProps) {
  const [name, setName] = useState('');
  const [seasonStartMonth, setSeasonStartMonth] = useState(1);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [allPlayers, setAllPlayers] = useState<PlayerDetail[]>([]);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [selectedAdminIds, setSelectedAdminIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateExistingId, setDuplicateExistingId] = useState<string | null>(null);
  const [addPlayerOpen, setAddPlayerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset state when the modal closes so reopening yields a clean form.
  useEffect(() => {
    if (!open) {
      setName('');
      setSeasonStartMonth(1);
      setImage(null);
      setImagePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setImageError(null);
      setSelectedAdminIds(new Set());
      setSearch('');
      setBusy(false);
      setError(null);
      setDuplicateExistingId(null);
      setAddPlayerOpen(false);
      setPlayersError(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [open]);

  // Load players when opened.
  useEffect(() => {
    if (!open) return;
    setPlayersError(null);
    listAllPlayers()
      .then(setAllPlayers)
      .catch((e) => setPlayersError(e instanceof Error ? e.message : 'Failed to load players'));
  }, [open]);

  // Esc-to-cancel — but ignore if the AddPlayer sub-modal is open (it owns Esc).
  useEffect(() => {
    if (!open || addPlayerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, addPlayerOpen, busy, onClose]);

  // Revoke the object URL when the preview changes.
  useEffect(() => {
    return () => { if (imagePreview) URL.revokeObjectURL(imagePreview); };
  }, [imagePreview]);

  const trimmedName = name.trim();
  const canSubmit = !busy
    && trimmedName.length > 0
    && selectedAdminIds.size > 0
    && !imageError;

  const filteredPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allPlayers;
    return allPlayers.filter((p) =>
      p.display_name.toLowerCase().includes(q)
      || (p.full_name ?? '').toLowerCase().includes(q)
      || (p.email ?? '').toLowerCase().includes(q)
    );
  }, [allPlayers, search]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImageError(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setImage(null);
      setImagePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      return;
    }
    if (!ALLOWED_MIME.has(file.type)) {
      setImageError('Use jpg, png, or webp.');
      setImage(null);
      setImagePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(`Image is ${(file.size / 1024 / 1024).toFixed(1)} MB — limit is 10 MB.`);
      setImage(null);
      setImagePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImage(file);
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  };

  const clearImage = () => {
    setImage(null);
    setImageError(null);
    setImagePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const toggleAdmin = (playerId: string) => {
    setSelectedAdminIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const handleAddPlayerSuccess = (result: { player: { id: string; display_name: string; email: string | null; user_id: string | null; is_active: number } }) => {
    setAddPlayerOpen(false);
    // Refresh and auto-select the new player. Optimistically inject into the
    // list so the user sees them immediately; the refetch is the source of
    // truth afterward.
    const newPlayer: PlayerDetail = {
      id: result.player.id,
      display_name: result.player.display_name,
      full_name: null,
      email: result.player.email,
      venmo_handle: null,
      photo_url: null,
      is_active: result.player.is_active,
      user_id: result.player.user_id,
    };
    setAllPlayers((prev) => {
      if (prev.some((p) => p.id === newPlayer.id)) return prev;
      const next = [...prev, newPlayer];
      next.sort((a, b) => a.display_name.localeCompare(b.display_name));
      return next;
    });
    setSelectedAdminIds((prev) => new Set(prev).add(newPlayer.id));
    // Background refresh.
    listAllPlayers().then(setAllPlayers).catch(() => { /* keep optimistic state */ });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setDuplicateExistingId(null);
    try {
      const group = await createGroup({
        name: trimmedName,
        season_start_month: seasonStartMonth,
        admin_player_ids: Array.from(selectedAdminIds),
        image,
      });
      onSuccess(group);
    } catch (e) {
      if (e instanceof DuplicateGroupNameError) {
        setDuplicateExistingId(e.existingGroupId);
        setError(`A group named "${trimmedName}" already exists.`);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to create group');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-modal-title"
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1900, padding: 16,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy && !addPlayerOpen) onClose();
        }}
      >
        <div
          style={{
            background: '#fff', borderRadius: 8, maxWidth: 640, width: '100%',
            maxHeight: '90vh', display: 'flex', flexDirection: 'column',
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)', overflow: 'hidden',
          }}
        >
          <div style={{ padding: '14px 20px', background: '#f5f5f5', borderBottom: '1px solid #e0e0e0' }}>
            <h2 id="create-group-modal-title" style={{ margin: 0, fontSize: '1.1rem', color: '#1a1a1a' }}>
              Create Group
            </h2>
          </div>

          <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
            {/* Name */}
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="cg-name" style={labelStyle}>Group name *</label>
              <input
                id="cg-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                style={inputStyle}
                disabled={busy}
                autoFocus
              />
            </div>

            {/* Image */}
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="cg-image" style={labelStyle}>Group image (optional)</label>
              <input
                id="cg-image"
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleImageChange}
                disabled={busy}
                style={{ fontSize: 13 }}
              />
              {imageError && (
                <div style={{ color: '#c62828', fontSize: 12, marginTop: 4 }}>{imageError}</div>
              )}
              {imagePreview && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                  <img
                    src={imagePreview}
                    alt="Selected logo preview"
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, border: '1px solid #ccc' }}
                  />
                  <button type="button" className="btn btn-secondary" onClick={clearImage} disabled={busy}>
                    Remove image
                  </button>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                jpg, png, or webp — up to 10 MB. If omitted, the group uses no logo.
              </div>
            </div>

            {/* Season start month */}
            <div style={{ marginBottom: 18 }}>
              <label htmlFor="cg-month" style={labelStyle}>Season starts in *</label>
              <select
                id="cg-month"
                value={seasonStartMonth}
                onChange={(e) => setSeasonStartMonth(parseInt(e.target.value, 10))}
                disabled={busy}
                style={inputStyle}
              >
                {MONTHS.map((label, i) => (
                  <option key={i + 1} value={i + 1}>{label}</option>
                ))}
              </select>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                Used for automatic season rollover.
              </div>
            </div>

            {/* Admin picker */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={labelStyle}>Initial admins *</div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setAddPlayerOpen(true)}
                  disabled={busy}
                  style={{ padding: '4px 10px', fontSize: 13 }}
                >
                  + Add new player
                </button>
              </div>
              <input
                type="text"
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                disabled={busy}
                style={{ ...inputStyle, marginBottom: 6 }}
              />
              {playersError ? (
                <div style={{ color: '#c62828', fontSize: 13, padding: 8 }}>{playersError}</div>
              ) : (
                <div
                  style={{
                    border: '1px solid #ddd', borderRadius: 4,
                    maxHeight: 220, overflowY: 'auto',
                  }}
                >
                  {filteredPlayers.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 13, color: '#666' }}>
                      {allPlayers.length === 0 ? 'No players yet — use "+ Add new player".' : 'No matches.'}
                    </div>
                  ) : (
                    filteredPlayers.map((p) => {
                      const selected = selectedAdminIds.has(p.id);
                      return (
                        <label
                          key={p.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 10px', borderBottom: '1px solid #eee',
                            background: selected ? '#f0f7ff' : 'transparent',
                            cursor: busy ? 'default' : 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleAdmin(p.id)}
                            disabled={busy}
                          />
                          <span style={{ flex: 1 }}>
                            {p.display_name}
                            {p.email && <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>{p.email}</span>}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
              <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                {selectedAdminIds.size} admin{selectedAdminIds.size === 1 ? '' : 's'} selected.
                At least one is required.
              </div>
            </div>

            {error && (
              <div
                role="alert"
                style={{
                  marginTop: 16, padding: '10px 12px',
                  background: '#ffebee', color: '#c62828',
                  border: '1px solid #f5c6c2', borderRadius: 4, fontSize: 13,
                }}
              >
                {error}
                {duplicateExistingId && (
                  <div style={{ marginTop: 6 }}>
                    Existing group id: <code>{duplicateExistingId}</code>
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            style={{
              padding: '12px 20px', background: '#fafafa',
              borderTop: '1px solid #e0e0e0',
              display: 'flex', justifyContent: 'flex-end', gap: 8,
            }}
          >
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="btn"
              style={{
                background: '#0d47a1', color: '#fff',
                opacity: canSubmit ? 1 : 0.6,
              }}
            >
              {busy ? 'Creating…' : 'Create Group'}
            </button>
          </div>
        </div>
      </div>

      <AddPlayerModal
        open={addPlayerOpen}
        groups={[]}
        onClose={() => setAddPlayerOpen(false)}
        onSuccess={handleAddPlayerSuccess}
      />
    </>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 13, fontWeight: 600,
  marginBottom: 6, color: '#1a1a1a',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 4,
  border: '1px solid #ccc', fontSize: 14,
};
