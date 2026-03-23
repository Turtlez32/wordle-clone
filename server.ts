import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 3003);
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";
const OIDC_ISSUER = process.env.OIDC_ISSUER ?? "";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "";
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "change-me-in-production";
const COOKIE_SECURE = APP_ORIGIN.startsWith("https://");

const db = new Database("wordle.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    email TEXT,
    preferred_username TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_locks (
    user_sub TEXT NOT NULL,
    day_index INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, day_index)
  );
`);

type DiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

type SessionRow = {
  id: string;
  user_sub: string;
  email: string | null;
  preferred_username: string | null;
  expires_at: number;
};

let discoveryCache: DiscoveryDocument | null = null;

function getDayIndex(date = new Date()) {
  const utcDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const epoch = Date.UTC(2024, 0, 1);
  return Math.floor((utcDate - epoch) / 86_400_000);
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function redirect(location: string, headers?: HeadersInit) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const part = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));

  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

function signValue(value: string) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function encodeSignedCookie(payload: unknown) {
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${value}.${signValue(value)}`;
}

function decodeSignedCookie<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  const [payload, signature] = value.split(".");
  if (!payload || !signature || signValue(payload) !== signature) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function buildCookie(name: string, value: string, maxAge?: number) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    COOKIE_SECURE ? "Secure" : "",
    typeof maxAge === "number" ? `Max-Age=${maxAge}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookie(name: string) {
  return buildCookie(name, "", 0);
}

function generatePkceVerifier() {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function getDiscoveryDocument() {
  if (discoveryCache) {
    return discoveryCache;
  }

  const response = await fetch(`${OIDC_ISSUER}.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error("failed to load oidc discovery");
  }

  discoveryCache = (await response.json()) as DiscoveryDocument;
  return discoveryCache;
}

function getCallbackUrl() {
  return `${APP_ORIGIN}/api/auth/callback`;
}

function getLogoutUrl() {
  return `${APP_ORIGIN}/`;
}

async function requireSession(request: Request) {
  const sessionId = getCookieValue(request, "wordle_session");
  if (!sessionId) {
    return null;
  }

  const session = db
    .query("SELECT id, user_sub, email, preferred_username, expires_at FROM sessions WHERE id = ?1")
    .get(sessionId) as SessionRow | null;

  if (!session) {
    return null;
  }

  if (session.expires_at <= Date.now()) {
    db.query("DELETE FROM sessions WHERE id = ?1").run(sessionId);
    return null;
  }

  return session;
}

function getDailyLocked(userSub: string) {
  const today = getDayIndex();
  const row = db
    .query("SELECT user_sub FROM daily_locks WHERE user_sub = ?1 AND day_index = ?2")
    .get(userSub, today);

  return Boolean(row);
}

function lockDaily(userSub: string) {
  db.query(
    "INSERT OR REPLACE INTO daily_locks (user_sub, day_index, completed_at) VALUES (?1, ?2, ?3)",
  ).run(userSub, getDayIndex(), Date.now());
}

async function handleAuthLogin() {
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID) {
    return json({ error: "OIDC is not configured" }, 500);
  }

  const discovery = await getDiscoveryDocument();
  const state = randomUUID();
  const nonce = randomUUID();
  const verifier = generatePkceVerifier();
  const challenge = generateCodeChallenge(verifier);

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("client_id", OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", getCallbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const transactionCookie = buildCookie(
    "wordle_auth_tx",
    encodeSignedCookie({ state, nonce, verifier }),
    600,
  );

  return redirect(url.toString(), {
    "Set-Cookie": transactionCookie,
  });
}

async function handleAuthCallback(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const txCookie = decodeSignedCookie<{ state: string; nonce: string; verifier: string }>(
    getCookieValue(request, "wordle_auth_tx"),
  );

  if (!code || !state || !txCookie || txCookie.state !== state) {
    return redirect(`${APP_ORIGIN}/?authError=callback`);
  }

  const discovery = await getDiscoveryDocument();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OIDC_CLIENT_ID,
    code,
    redirect_uri: getCallbackUrl(),
    code_verifier: txCookie.verifier,
  });

  if (OIDC_CLIENT_SECRET) {
    body.set("client_secret", OIDC_CLIENT_SECRET);
  }

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!tokenResponse.ok) {
    return redirect(`${APP_ORIGIN}/?authError=token`);
  }

  const tokenPayload = (await tokenResponse.json()) as {
    access_token: string;
    expires_in?: number;
  };

  const userInfoResponse = await fetch(discovery.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });

  if (!userInfoResponse.ok) {
    return redirect(`${APP_ORIGIN}/?authError=userinfo`);
  }

  const userInfo = (await userInfoResponse.json()) as {
    sub: string;
    email?: string;
    preferred_username?: string;
  };

  const sessionId = randomUUID();
  const expiresAt = Date.now() + (tokenPayload.expires_in ?? 3600) * 1000;

  db.query(
    "INSERT INTO sessions (id, user_sub, email, preferred_username, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(sessionId, userInfo.sub, userInfo.email ?? null, userInfo.preferred_username ?? null, expiresAt);

  const headers = new Headers({
    Location: APP_ORIGIN,
  });
  headers.append("Set-Cookie", buildCookie("wordle_session", sessionId, tokenPayload.expires_in ?? 3600));
  headers.append("Set-Cookie", clearCookie("wordle_auth_tx"));

  return new Response(null, {
    status: 302,
    headers,
  });
}

async function handleLogout(request: Request) {
  const sessionId = getCookieValue(request, "wordle_session");
  if (sessionId) {
    db.query("DELETE FROM sessions WHERE id = ?1").run(sessionId);
  }

  let logoutTarget = getLogoutUrl();
  if (OIDC_ISSUER) {
    try {
      const discovery = await getDiscoveryDocument();
      if (discovery.end_session_endpoint) {
        const logoutUrl = new URL(discovery.end_session_endpoint);
        logoutUrl.searchParams.set("post_logout_redirect_uri", getLogoutUrl());
        logoutTarget = logoutUrl.toString();
      }
    } catch {
      // Fall back to app origin.
    }
  }

  const headers = new Headers({
    Location: logoutTarget,
  });
  headers.append("Set-Cookie", clearCookie("wordle_session"));

  return new Response(null, {
    status: 302,
    headers,
  });
}

async function handleSession(request: Request) {
  const session = await requireSession(request);
  if (!session) {
    return json({
      authenticated: false,
      user: null,
      dailyLocked: false,
    });
  }

  return json({
    authenticated: true,
    user: {
      sub: session.user_sub,
      email: session.email ?? undefined,
      preferred_username: session.preferred_username ?? undefined,
    },
    dailyLocked: getDailyLocked(session.user_sub),
  });
}

async function handleDailyComplete(request: Request) {
  const session = await requireSession(request);
  if (!session) {
    return json({ error: "unauthorized" }, 401);
  }

  lockDaily(session.user_sub);
  return json({ locked: true });
}

function serveStatic(pathname: string) {
  const distPath = `./dist${pathname === "/" ? "/index.html" : pathname}`;
  if (!existsSync(distPath)) {
    return null;
  }

  return new Response(Bun.file(distPath));
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/auth/login" && request.method === "GET") {
      return handleAuthLogin();
    }

    if (url.pathname === "/api/auth/callback" && request.method === "GET") {
      return handleAuthCallback(request);
    }

    if (url.pathname === "/api/auth/logout" && request.method === "GET") {
      return handleLogout(request);
    }

    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      return handleSession(request);
    }

    if (url.pathname === "/api/daily/complete" && request.method === "POST") {
      return handleDailyComplete(request);
    }

    const staticResponse = serveStatic(url.pathname);
    if (staticResponse) {
      return staticResponse;
    }

    if (existsSync("./dist/index.html")) {
      return new Response(Bun.file("./dist/index.html"));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Wordle auth proxy listening on http://localhost:${PORT}`);
