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

export type UserStats = {
  user: string;
  streak: number;
  totalSolved: number;
  updatedAt: string | null;
  lastSolvedDate: string | null;
  lastSolvedWord: string | null;
  solvedWords: Array<{
    date: string;
    word: string;
  }>;
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

export async function completeDailyRound(payload: { solved: boolean; word: string }) {
  const response = await fetch("/api/daily/complete", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("failed to lock daily round");
  }

  return response.json() as Promise<{ locked: boolean; stats: UserStats | null }>;
}
