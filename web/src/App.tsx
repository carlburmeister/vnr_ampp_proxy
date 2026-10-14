import { useEffect, useRef, useState } from 'react';

import './App.css';
import { LoginPage } from './components/LoginPage';
import { UserHomePage } from './components/UserHomePage';
import { renderWorkloadApplicationRoute } from './utils/workloadApplicationRoutes';
import { logoutUser, type LoginResponse } from './services/authApi';
import { getCurrentSession, type SessionData } from './services/amppSessionApi';

function App() {
  
  const sessionGeneration = useRef(0);
  const [currentSession, setCurrentSession] = useState<SessionData | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let initialCheckDone = false;

    async function loadCurrentSession() {
      if (pending) return;
      pending = true;
      const generation = sessionGeneration.current;
      try {
        const session = await getCurrentSession();

        if (!cancelled && generation === sessionGeneration.current) {
          setCurrentSession((previous) => JSON.stringify(previous) === JSON.stringify(session) ? previous : session);
          setAuthError('');
        }
      } catch (err) {
        if (!cancelled && !initialCheckDone && generation === sessionGeneration.current) {
          setAuthError(err instanceof Error ? err.message : 'Unknown auth error');
        }
      } finally {
        pending = false;
        initialCheckDone = true;
        if (!cancelled) {
          setAuthChecked(true);
        }
      }
    }

    void loadCurrentSession();

    // Refresh displayed access when another admin changes permissions.
    const timer = window.setInterval(() => {
      if (!cancelled && !document.hidden) void loadCurrentSession();
    }, 10000);
    const onFocus = () => { if (!cancelled && !pending) void loadCurrentSession(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  
  /*-------------------------------------------------------------*/
  //  refreshOwnPermissions()
  /*-------------------------------------------------------------*/
  async function refreshOwnPermissions() {
    const session = await getCurrentSession();
    setCurrentSession((previous) => JSON.stringify(previous) === JSON.stringify(session) ? previous : session);
  }

  /*-------------------------------------------------------------*/
  //  handleLogin()
  /*-------------------------------------------------------------*/
  async function handleLogin(_result: LoginResponse) 
  {
    sessionGeneration.current += 1;
    const session = await getCurrentSession();

    if (!session) {
      throw new Error('Login succeeded, but the session could not be loaded');
    }

    setCurrentSession(session);
    setAuthError('');
  }
  /*-------------------------------------------------------------*/
  //  handleLogout()
  /*-------------------------------------------------------------*/
  async function handleLogout() 
  {
    sessionGeneration.current += 1;
    try {
      await logoutUser();
    } finally {
      setCurrentSession(null);
    }
  }


  if (!authChecked) {
    return (
      <main className="app-shell">
        <p>Checking session...</p>
      </main>
    );
  }

  const workloadApplicationRoute = renderWorkloadApplicationRoute(window.location.pathname);
  const routeWorkloadId = new URLSearchParams(window.location.search).get('workloadId');
  const authorizedRoute = !routeWorkloadId || currentSession?.allowedWorkloads.some((workload) =>
    workload.id === routeWorkloadId || workload.child_workloads?.some((child) => child.id === routeWorkloadId),
  );

  return (
    <main className="app-shell">
      {currentSession ? (
        (authorizedRoute ? workloadApplicationRoute : null) ?? <UserHomePage session={currentSession} onLogout={handleLogout}
          onPermissionsSaved={() => { void refreshOwnPermissions().catch(console.error); }} />
      ) : (
        <>
          {authError && <p style={{ color: 'red' }}>{authError}</p>}
          <LoginPage onLogin={handleLogin} />
        </>
      )}
    </main>
  );
}

export default App;