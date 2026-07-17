export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string;
};

export type LoginResponse = {
  user: AuthenticatedUser;
};

/*-------------------------------------------------------------*/
//  loginUser()
/*-------------------------------------------------------------*/
export async function loginUser(
  username: string,
  password: string,
): Promise<LoginResponse> {
  
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(await parseError(response, `Login failed: ${response.status}`));
  }

  return response.json();
}
/*-------------------------------------------------------------*/
//  getCurrentUser()
/*-------------------------------------------------------------*/
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  
  const response = await fetch('/api/auth/me', {
    credentials: 'include',
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      await parseError(response, `Load current user failed: ${response.status}`),
    );
  }

  const body = (await response.json()) as LoginResponse;
  return body.user;
}
/*-------------------------------------------------------------*/
//  logoutUser()
/*-------------------------------------------------------------*/
export async function logoutUser(): Promise<void> {
  
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await parseError(response, `Logout failed: ${response.status}`));
  }
}
/*-------------------------------------------------------------*/
//  parseError()
/*-------------------------------------------------------------*/
async function parseError(response: Response, fallback: string) {
  let message = fallback;

  try {
    const body = (await response.json()) as { message?: string | string[] };

    if (Array.isArray(body.message)) {
      message = body.message.join(', ');
    } else if (body.message) {
      message = body.message;
    }
  } catch {
    // Keep the default status-based message.
  }

  return message;
}