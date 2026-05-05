import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { setAuthToken } from '../api/client';

const SUPABASE_URL = (
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LATE_ADD_API_URL
    ? import.meta.env.VITE_LATE_ADD_API_URL
    : 'https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1'
).replace(/\/functions\/v1\/?$/, '');

const ANON_KEY =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? import.meta.env.VITE_SUPABASE_ANON_KEY
    : null;

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('dev@lateaddgolf.com');
  const [password, setPassword] = useState('testpass123');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'email' | 'jwt'>('email');

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/dashboard';

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ANON_KEY ? { apikey: ANON_KEY } : {}),
        },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.msg || data.error_description || 'Sign in failed');
        return;
      }
      setAuthToken(data.access_token);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const handleJwtSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const t = token.replace(/\s+/g, '');
    if (!t) {
      setError('Paste a JWT to sign in.');
      return;
    }
    setAuthToken(t);
    navigate(from, { replace: true });
  };

  const handleContinueWithoutToken = () => {
    setAuthToken(null);
    setError(null);
    navigate(from, { replace: true });
  };

  return (
    <>
      <PageHeader title="Sign in" subtitle="Sign in with email/password or paste a JWT." />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          className={`btn ${mode === 'email' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => { setMode('email'); setError(null); }}
        >
          Email / Password
        </button>
        <button
          className={`btn ${mode === 'jwt' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => { setMode('jwt'); setError(null); }}
        >
          Paste JWT
        </button>
      </div>

      {mode === 'email' && (
        <div className="card">
          <form onSubmit={handleEmailLogin}>
            <div className="form-section">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="form-section">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            {error && <p style={{ color: '#c62828', marginBottom: 12 }}>{error}</p>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleContinueWithoutToken}>
                Continue without token
              </button>
            </div>
          </form>
        </div>
      )}

      {mode === 'jwt' && (
        <div className="card">
          <form onSubmit={handleJwtSubmit}>
            <div className="form-section">
              <label htmlFor="jwt">JWT (Bearer token)</label>
              <textarea
                id="jwt"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your Supabase Auth JWT here..."
                rows={4}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
            </div>
            {error && <p style={{ color: '#c62828', marginBottom: 12 }}>{error}</p>}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Sign in
              </button>
              <button type="button" className="btn btn-secondary" onClick={handleContinueWithoutToken}>
                Continue without token
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
