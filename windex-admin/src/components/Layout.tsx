import React from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { getAuthToken, setAuthToken } from '../api/client';

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const hasToken = !!getAuthToken();

  const nav = [
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/events', label: 'Rounds' },
    { path: '/events/new', label: 'Round Entry' },
    { path: '/standings', label: 'Standings' },
    { path: '/groups', label: 'Groups' },
    { path: '/players', label: 'Players' },
    { path: '/analytics/points', label: 'Points Analysis' },
    { path: '/review/attribution', label: 'Attribution review' },
    { path: '/review/player-mapping', label: 'Player Mapping' },
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
