import { useCallback, useEffect, useRef, useState } from 'react';

import './App.css';
import { LoginPage } from './components/LoginPage';
import { UserHomePage } from './components/UserHomePage';
import { renderWorkloadApplicationRoute } from './utils/workloadApplicationRoutes';
import { logoutUser } from './services/authApi';
import { getCurrentSession, type SessionData } from './services/amppSessionApi';

function App() {
  
  const sessionGeneration = useRef(0);
  const sessionRequest = useRef<AbortController | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loggingOut = useRef(false);
  const [currentSession, setCurrentSession] = useState<SessionData | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

  const invalidateRequests = useCallback(() => {
    sessionGeneration.current += 1;
    sessionRequest.current?.abort();
    sessionRequest.current = null;
    clearTimeout(expiryTimer.current);
  }, []);

  const loadCurrentSession = useCallback(async (replacePending = false) => {
    if (loggingOut.current) return;
    if (sessionRequest.current && !replacePending) return;
    if (replacePending) invalidateRequests();
    const controller = new AbortController();
    sessionRequest.current = controller;
    const generation = sessionGeneration.current;
    try {
      const session = await getCurrentSession(controller.signal);
      if (generation !== sessionGeneration.current) return;
      if (!session) {
        invalidateRequests();
        setCurrentSession(null);
      } else {
        setCurrentSession((previous) => JSON.stringify(previous) === JSON.stringify(session) ? previous : session);
      }
      setAuthError('');
      setAuthChecked(true);
      return session;
    } catch {
      if (generation !== sessionGeneration.current) return;
      setAuthError('Unable to verify your session. Check your connection and retry.');
      setAuthChecked(true);
    } finally {
      if (sessionRequest.current === controller) sessionRequest.current = null;
    }
  }, [invalidateRequests]);

  useEffect(() => {
    const generation = sessionGeneration.current;
    void Promise.resolve().then(() => {
      if (generation === sessionGeneration.current) return loadCurrentSession();
    });

    const onResume = () => {
      if (!document.hidden) {
        setAuthChecked(false);
        void loadCurrentSession(true);
      }
    };

    // Refresh displayed access when another admin changes permissions.
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadCurrentSession();
    }, 10000);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    document.addEventListener('visibilitychange', onResume);

    return () => {
      invalidateRequests();
      window.clearInterval(timer);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [invalidateRequests, loadCurrentSession]);

  useEffect(() => {
    clearTimeout(expiryTimer.current);
    if (!currentSession || authError) return;
    // Another tab can renew the same session: verify at the known deadline
    // instead of assuming that this tab's last deadline is still authoritative.
    expiryTimer.current = setTimeout(() => {
      setAuthChecked(false);
      if (!document.hidden) void loadCurrentSession(true);
    }, Math.max(0, currentSession.expiresAt - Date.now()));
    return () => clearTimeout(expiryTimer.current);
  }, [currentSession, authError, loadCurrentSession]);
  
  /*-------------------------------------------------------------*/
  //  refreshOwnPermissions()
  /*-------------------------------------------------------------*/
  async function refreshOwnPermissions() {
    await loadCurrentSession(true);
  }

  /*-------------------------------------------------------------*/
  //  handleLogin()
  /*-------------------------------------------------------------*/
  async function handleLogin()
  {
    setAuthChecked(false);
    const session = await loadCurrentSession(true);
    if (!session) throw new Error('Login succeeded, but the session could not be loaded');
  }
  /*-------------------------------------------------------------*/
  //  handleLogout()
  /*-------------------------------------------------------------*/
  async function handleLogout() 
  {
    loggingOut.current = true;
    invalidateRequests();
    setCurrentSession(null);
    setAuthError('');
    setAuthChecked(false);
    try {
      await logoutUser();
    } catch {
      setAuthError('Sign out could not be confirmed. Check your connection and retry.');
    } finally {
      loggingOut.current = false;
      setAuthChecked(true);
    }
  }

  const restricted = !authChecked || Boolean(authError);
  const workloadApplicationRoute = renderWorkloadApplicationRoute(window.location.pathname);
  const routeWorkloadId = new URLSearchParams(window.location.search).get('workloadId');
  const authorizedRoute = !routeWorkloadId || currentSession?.allowedWorkloads.some((workload) =>
    workload.id === routeWorkloadId || workload.child_workloads?.some((child) => child.id === routeWorkloadId),
  );

  return (
    <main className="app-shell" role={authChecked && authError ? 'alert' : undefined}>
      {!authChecked ? <p>Checking session...</p> : authError ? (
        <section>
          <p>{authError}</p>
          <button onClick={() => { setAuthChecked(false); void loadCurrentSession(true); }}>Retry session check</button>
          <button onClick={() => { void handleLogout(); }}>Sign out</button>
        </section>
      ) : null}
      {currentSession ? (
        <div hidden={restricted} inert={restricted}>
          {(authorizedRoute ? workloadApplicationRoute : null) ?? <UserHomePage session={currentSession} onLogout={handleLogout}
            onPermissionsSaved={() => { void refreshOwnPermissions().catch(console.error); }} />}
        </div>
      ) : !restricted && <LoginPage onLogin={handleLogin} />}
    </main>
  );
}

export default App;
