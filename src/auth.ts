export type SessionUser = {
  sub: string;
  email?: string;
  preferred_username?: string;
};

export type SessionResponse = {
  authenticated: boolean;
  user: SessionUser | null;
  dailyLocked: boolean;
};

export async function getCurrentSession(): Promise<SessionResponse> {
  const response = await fetch("/api/auth/session", {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("session lookup failed");
  }

  return response.json() as Promise<SessionResponse>;
}

export function signIn() {
  window.location.href = "/api/auth/login";
}

export function signOut() {
  window.location.href = "/api/auth/logout";
}

export async function completeDailyRound() {
  const response = await fetch("/api/daily/complete", {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error("failed to lock daily round");
  }

  return response.json() as Promise<{ locked: boolean }>;
}
