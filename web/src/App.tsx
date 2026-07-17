import { useEffect, useState } from 'react';

import './App.css';
import { LoginPage } from './components/LoginPage';
import { UserHomePage } from './components/UserHomePage';
import { renderWorkloadApplicationRoute } from './utils/workloadApplicationRoutes';
import { logoutUser, type LoginResponse } from './services/authApi';
import { getCurrentSession, type SessionData } from './services/amppSessionApi';

function App() {
  
  const [currentSession, setCurrentSession] = useState<SessionData | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentSession() {
      try {
        const session = await getCurrentSession();

        if (!cancelled) {
          setCurrentSession(session);
          setAuthError('');
        }
      } catch (err) {
        if (!cancelled) {
          setCurrentSession(null);
          setAuthError(err instanceof Error ? err.message : 'Unknown auth error');
        }
      } finally {
        if (!cancelled) {
          setAuthChecked(true);
        }
      }
    }

    loadCurrentSession();

    return () => {
      cancelled = true;
    };
  }, []);
  
  /*-------------------------------------------------------------*/
  //  handleLogin()
  /*-------------------------------------------------------------*/
  async function handleLogin(_result: LoginResponse) 
  {
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

  return (
    <main className="app-shell">
      {currentSession ? (
        workloadApplicationRoute ?? <UserHomePage session={currentSession} onLogout={handleLogout} />
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