import { useState } from 'react';
import type { FormEvent } from 'react';

import { loginUser, type LoginResponse } from '../services/authApi';

type LoginPageProps = {
  onLogin: (result: LoginResponse) => void | Promise<void>;
};

export function LoginPage({ onLogin }: LoginPageProps) {
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  /*-------------------------------------------------------------*/
  //  handleSubmit()
  /*-------------------------------------------------------------*/
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      setError('');
      setStatus('Signing in...');

      /* Call authApi.ts::loginuser() */
      const result = await loginUser(username, password);

      await onLogin(result);
      setStatus('Signed in');
    } 
    catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown login error');
      setStatus('');
    }
  }

  const canSubmit = Boolean(username.trim() && password.trim() && !status);

  return (
    <section className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>VNR App Login</h2>
        
        <p className="login-help">
        </p>

        <label className="login-field">
          <span>Username</span>
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="admin"
          />
        </label>

        <label className="login-field">
          <span>Password</span>
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="password"
          />
        </label>

        <button type="submit" disabled={!canSubmit}>
          {status ? status : 'Sign in'}
        </button>

        {error && <p className="login-error">{error}</p>}
      </form>
    </section>
  );
}