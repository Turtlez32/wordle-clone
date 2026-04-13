import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createClient, type RedisClientType } from "redis";

const PORT = Number(process.env.PORT ?? 3003);
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";
const OIDC_ISSUER = process.env.OIDC_ISSUER ?? "";
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "";
const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? "";
const REDIS_URL = process.env.REDIS_URL ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "change-me-in-production";
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 24);
const COOKIE_SECURE = APP_ORIGIN.startsWith("https://");

type DiscoveryDocument = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
};

type StoredSession = {
  id: string;
  user_sub: string;
  email: string | null;
  preferred_username: string | null;
  expires_at: number;
};

type DailyCompletion = {
  user: string;
  dayIndex: number;
  date: string;
  word: string;
  solved: boolean;
  completedAt: string;
};

type UserStats = {
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

let discoveryCache: DiscoveryDocument | null = null;
let redisClient: RedisClientType | null = null;
let redisConnectPromise: Promise<RedisClientType> | null = null;

function getDayIndex(date = new Date()) {
  const utcDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const epoch = Date.UTC(2024, 0, 1);
  return Math.floor((utcDate - epoch) / 86_400_000);
}

function getUtcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getPreviousUtcDateString(date = new Date()) {
  const previous = new Date(date);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return getUtcDateString(previous);
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

function getCallbackUrl() {
  return `${APP_ORIGIN}/api/auth/callback`;
}

function getLogoutUrl() {
  return `${APP_ORIGIN}/`;
}

function getSessionKey(sessionId: string) {
  return `session:${sessionId}`;
}

function getDailyCompletionKey(userSub: string, dayIndex: number) {
  return `user:${userSub}:daily:${dayIndex}`;
}

function getStatsKey(userSub: string) {
  return `${userSub}:stats`;
}

async function getRedis() {
  if (redisClient?.isReady) {
    return redisClient;
  }

  if (!REDIS_URL) {
    throw new Error("REDIS_URL is not configured");
  }

  if (!redisConnectPromise) {
    const client = createClient({
      url: REDIS_URL,
    });

    client.on("error", (error) => {
      console.error("Redis error", error);
    });

    redisConnectPromise = client
      .connect()
      .then(() => {
        redisClient = client;
        return client;
      })
      .catch((error) => {
        redisConnectPromise = null;
        redisClient = null;
        client.destroy();
        throw error;
      });
  }

  return redisConnectPromise;
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

async function readJson<T>(key: string) {
  const redis = await getRedis();
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

async function writeJson(key: string, value: unknown, ttlSeconds?: number) {
  const redis = await getRedis();
  const payload = JSON.stringify(value);

  if (typeof ttlSeconds === "number") {
    await redis.set(key, payload, {
      EX: ttlSeconds,
    });
    return;
  }

  await redis.set(key, payload);
}

async function deleteKey(key: string) {
  const redis = await getRedis();
  await redis.del(key);
}

async function requireSession(request: Request) {
  const sessionId = getCookieValue(request, "wordle_session");
  if (!sessionId) {
    return null;
  }

  const session = await readJson<StoredSession>(getSessionKey(sessionId));
  if (!session) {
    return null;
  }

  if (session.expires_at <= Date.now()) {
    await deleteKey(getSessionKey(sessionId));
    return null;
  }

  return session;
}

async function getDailyCompletion(userSub: string, dayIndex = getDayIndex()) {
  return readJson<DailyCompletion>(getDailyCompletionKey(userSub, dayIndex));
}

async function getDailyLocked(userSub: string) {
  return Boolean(await getDailyCompletion(userSub));
}

async function getUserStats(userSub: string) {
  return readJson<UserStats>(getStatsKey(userSub));
}

async function updateUserStats(userSub: string, word: string, completedAt: Date) {
  const current = (await getUserStats(userSub)) ?? {
    user: userSub,
    streak: 0,
    totalSolved: 0,
    updatedAt: null,
    lastSolvedDate: null,
    lastSolvedWord: null,
    solvedWords: [],
  };

  const solvedDate = getUtcDateString(completedAt);
  const alreadyTrackedToday = current.solvedWords.some((entry) => entry.date === solvedDate);

  if (!alreadyTrackedToday) {
    current.solvedWords.push({
      date: solvedDate,
      word,
    });
    current.totalSolved += 1;
  }

  const previousDate = getPreviousUtcDateString(completedAt);
  if (current.lastSolvedDate === solvedDate) {
    // Keep the existing streak if the same day is replayed or retried.
  } else if (current.lastSolvedDate === previousDate) {
    current.streak += 1;
  } else {
    current.streak = 1;
  }

  current.updatedAt = completedAt.toISOString();
  current.lastSolvedDate = solvedDate;
  current.lastSolvedWord = word;

  await writeJson(getStatsKey(userSub), current);
  return current;
}

async function recordDailyCompletion(userSub: string, word: string, solved: boolean) {
  const completedAt = new Date();
  const completion: DailyCompletion = {
    user: userSub,
    dayIndex: getDayIndex(completedAt),
    date: getUtcDateString(completedAt),
    word,
    solved,
    completedAt: completedAt.toISOString(),
  };

  await writeJson(getDailyCompletionKey(userSub, completion.dayIndex), completion);

  let stats: UserStats | null = null;
  if (solved) {
    stats = await updateUserStats(userSub, word, completedAt);
  }

  return { completion, stats };
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

  return redirect(url.toString(), {
    "Set-Cookie": buildCookie(
      "wordle_auth_tx",
      encodeSignedCookie({ state, nonce, verifier }),
      600,
    ),
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
  const expiresIn = Math.max(tokenPayload.expires_in ?? 3600, SESSION_TTL_HOURS * 3600);
  const session: StoredSession = {
    id: sessionId,
    user_sub: userInfo.sub,
    email: userInfo.email ?? null,
    preferred_username: userInfo.preferred_username ?? null,
    expires_at: Date.now() + expiresIn * 1000,
  };

  await writeJson(getSessionKey(sessionId), session, expiresIn);

  const headers = new Headers({
    Location: APP_ORIGIN,
  });
  headers.append("Set-Cookie", buildCookie("wordle_session", sessionId, expiresIn));
  headers.append("Set-Cookie", clearCookie("wordle_auth_tx"));

  return new Response(null, {
    status: 302,
    headers,
  });
}

async function handleLogout(request: Request) {
  const sessionId = getCookieValue(request, "wordle_session");
  if (sessionId) {
    await deleteKey(getSessionKey(sessionId));
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
    dailyLocked: await getDailyLocked(session.user_sub),
  });
}

async function handleStats(request: Request) {
  const session = await requireSession(request);
  if (!session) {
    return json({ error: "unauthorized" }, 401);
  }

  return json({
    stats: await getUserStats(session.user_sub),
  });
}

async function handleDailyComplete(request: Request) {
  const session = await requireSession(request);
  if (!session) {
    return json({ error: "unauthorized" }, 401);
  }

  const body = (await request.json().catch(() => null)) as { solved?: boolean; word?: string } | null;
  const word = body?.word?.trim().toUpperCase();

  if (!word) {
    return json({ error: "word is required" }, 400);
  }

  const { stats } = await recordDailyCompletion(session.user_sub, word, Boolean(body?.solved));
  return json({
    locked: true,
    stats,
  });
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

    try {
      if (url.pathname === "/api/auth/login" && request.method === "GET") {
        return await handleAuthLogin();
      }

      if (url.pathname === "/api/auth/callback" && request.method === "GET") {
        return await handleAuthCallback(request);
      }

      if (url.pathname === "/api/auth/logout" && request.method === "GET") {
        return await handleLogout(request);
      }

      if (url.pathname === "/api/auth/session" && request.method === "GET") {
        return await handleSession(request);
      }

      if (url.pathname === "/api/stats" && request.method === "GET") {
        return await handleStats(request);
      }

      if (url.pathname === "/api/daily/complete" && request.method === "POST") {
        return await handleDailyComplete(request);
      }
    } catch (error) {
      console.error("Server request failed", error);
      return json({ error: "server request failed" }, 500);
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
