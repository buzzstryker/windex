import { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { getAuthToken, setAuthToken } from '../api/client';
import { isCurrentUserSuperAdmin } from '../api/groups';

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const hasToken = !!getAuthToken();

  // Super-admin-only nav items (e.g. Broadcast Notes Audit) follow the same
  // conditional-render pattern used for super-admin affordances elsewhere.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!hasToken) { setIsSuperAdmin(false); return; }
    isCurrentUserSuperAdmin().then((v) => { if (!cancelled) setIsSuperAdmin(v); });
    return () => { cancelled = true; };
  }, [hasToken]);

  const nav = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/events', label: 'Rounds' },
    { path: '/events/new', label: 'Round Entry' },
    { path: '/standings', label: 'Standings' },
    { path: '/groups', label: 'Groups' },
    { path: '/cup-champions', label: 'Cup Champions' },
    { path: '/players', label: 'Players' },
    ...(isSuperAdmin ? [{ path: '/activity', label: 'App Activity' }] : []),
    { path: '/analytics/points', label: 'Points Analysis' },
    { path: '/review/attribution', label: 'Attribution review' },
    { path: '/review/player-mapping', label: 'Player Mapping' },
    ...(isSuperAdmin ? [{ path: '/broadcast-notes-audit', label: 'Broadcast Notes Audit' }] : []),
  ];

  const handleSignOut = () => {
    setAuthToken(null);
    navigate('/dashboard', { replace: true });
  };

  return (
    <div className="app">
      <nav className="nav">
        {nav.map(({ path, label }) => (
          <Link key={path} to={path} style={{ fontWeight: location.pathname === path ? 600 : 400 }}>
            {label}
          </Link>
        ))}
        <span style={{ marginLeft: 'auto' }}>
          {hasToken ? (
            <button type="button" className="btn btn-secondary" onClick={handleSignOut} style={{ padding: '6px 10px', fontSize: 13 }}>
              Sign out
            </button>
          ) : (
            <Link to="/login" className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: 13, display: 'inline-block' }}>
              Sign in
            </Link>
          )}
        </span>
      </nav>
      <Outlet />
    </div>
  );
}
