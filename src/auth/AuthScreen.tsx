import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthProvider';
import { Btn } from '../ui/atoms';

type Mode = 'signup' | 'signin';

/** Editorial 2-column auth (art panel + form), wired to real Supabase auth. */
export function AuthScreen() {
  const { signUp, signInWithPassword, signInWithGoogle } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'signup') {
        await signUp(email, password);
        setNotice('Check your email to confirm your account, then sign in.');
        setMode('signin');
      } else {
        await signInWithPassword(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed.');
    }
  }

  return (
    <div className="auth-stage">
      <div className="auth-art">
        <div className="aa-mark" lang="ja">学択</div>
        <div className="aa-quote" lang="ja">
          吾輩は<br />読者である。
          <span className="en">
            “I am a reader.” Read native Japanese, tap any word, and turn the words you don't know
            into memory.
          </span>
        </div>
        <div className="aa-foot">GAKUTAKU · IMMERSION READER + FSRS · OFFLINE-FIRST PWA</div>
      </div>

      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
          <div className="sub">
            {mode === 'signup'
              ? 'Your library, decks, and progress sync across every device.'
              : 'Sign in to pick up where you left off.'}
          </div>

          <div className="oauth">
            <Btn type="button" className="ob" onClick={google}>Google</Btn>
            <Btn type="button" className="ob" disabled title="Coming soon">Apple</Btn>
          </div>
          <div className="auth-or">or</div>

          <div className="field">
            <label>Email</label>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              required
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="auth-err">{error}</div>}
          {notice && <div className="auth-note">{notice}</div>}

          <Btn type="submit" variant="primary" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
            {busy ? '…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Btn>

          <div className="auth-switch">
            {mode === 'signup' ? (
              <>Already reading? <a onClick={() => setMode('signin')}>Sign in</a></>
            ) : (
              <>New here? <a onClick={() => setMode('signup')}>Create an account</a></>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
