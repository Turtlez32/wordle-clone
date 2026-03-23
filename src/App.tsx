import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { completeDailyRound, getCurrentSession, signIn, signOut, type SessionUser } from "./auth";
import {
  evaluateGuess,
  getDayIndex,
  MAX_GUESSES,
  mergeLetterStates,
  type LetterState,
  type TileState,
  WORD_LENGTH,
} from "./game";
import { ANSWERS } from "./words";

type SubmittedGuess = {
  word: string;
  evaluation: TileState[];
};

type NoticeTone = "info" | "error" | "success";
type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";
type DefinitionState = {
  status: "idle" | "loading" | "ready" | "error";
  word: string;
  text: string;
};
type HintState = {
  status: "idle" | "loading" | "ready" | "error";
  levels: string[];
  revealed: number;
  text: string;
};
type GameMode = "daily" | "random";

const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
const CONFETTI_COLORS = ["#3dbb73", "#d7a920", "#4c4f6a", "#ff6eb6", "#35e9ff", "#ff8a3d"];
const OLLAMA_URL = "http://ai.turtleware.au:11434";
const OLLAMA_MODEL = "llama3.1:latest";

function ConfettiBurst() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 90 }, (_, index) => ({
        id: index,
        left: `${1 + ((index * 7) % 98)}%`,
        delay: `${(index % 10) * 0.05}s`,
        duration: `${2.4 + (index % 5) * 0.18}s`,
        rotation: `${(index % 2 === 0 ? 1 : -1) * (18 + index * 7)}deg`,
        color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
      })),
    [],
  );

  return (
    <div className="confetti-layer" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          className="confetti-piece"
          key={piece.id}
          style={
            {
              left: piece.left,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
              rotate: piece.rotation,
              background: piece.color,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

function AuthScreen({
  status,
  onSignIn,
}: {
  status: AuthStatus;
  onSignIn: () => void;
}) {
  const copy =
    status === "error"
      ? "The backend auth check failed. Verify the Authentik and server settings, then try again."
      : "Sign in to play the daily puzzle and enforce the per-user 24 hour lock.";

  return (
    <main className="app-shell">
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />
      <section className="auth-card">
        <p className="eyebrow">Protected Daily Puzzle</p>
        <h1>Neon Wordle</h1>
        <p className="auth-copy">{copy}</p>
        <button type="button" className="auth-button" onClick={onSignIn}>
          Sign In With Authentik
        </button>
        <p className="auth-note">
          Expected issuer format: <code>https://auth.turtleware.au/application/o/&lt;slug&gt;/</code>
        </p>
      </section>
    </main>
  );
}

function getDailyAnswer() {
  return ANSWERS[getDayIndex() % ANSWERS.length];
}

function makeRandomAnswer(except?: string) {
  const pool = ANSWERS.filter((word) => word !== except);
  return pool[Math.floor(Math.random() * pool.length)];
}

function fallbackDefinition(word: string) {
  return `${word} is tonight's winning signal.`;
}

function buildHintPrompt(answer: string, guesses: SubmittedGuess[]) {
  const confirmed = Array.from({ length: WORD_LENGTH }, () => "_");

  guesses.forEach((guess) => {
    guess.word.split("").forEach((letter, index) => {
      if (guess.evaluation[index] === "correct") {
        confirmed[index] = letter;
      }
    });
  });

  return [
    "You are helping with a local Wordle-style game.",
    `The actual answer is ${answer}. Do not reveal the answer directly unless the user explicitly asks for it.`,
    "Important: duplicate letters are allowed in Wordle-style answers and guesses.",
    "Give exactly three progressive hints.",
    "Hint 1 should be gentle and pattern-based.",
    "Hint 2 should be a stronger semantic or letter-based clue.",
    "Hint 3 should be quite direct but still must not say the word.",
    "Return valid JSON only, with this exact shape:",
    '{"hint1":"...","hint2":"...","hint3":"..."}',
    "Keep the response concise and friendly.",
    `Current pattern: ${confirmed.join(" ")}`,
    "Here is the exact guess history with tile outcomes:",
    ...guesses.map(
      (guess) =>
        `${guess.word}: ${guess.word
          .split("")
          .map((letter, index) => `${letter}-${guess.evaluation[index]}`)
          .join(", ")}`,
    ),
  ].join("\n");
}

function parseHintJson(content: string) {
  const directParse = (value: string) => JSON.parse(value) as { hint1?: string; hint2?: string; hint3?: string };

  try {
    return directParse(content);
  } catch {
    // Try fenced JSON or a JSON object embedded in surrounding text.
  }

  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try {
      return directParse(fencedMatch[1].trim());
    } catch {
      // Fall through.
    }
  }

  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch?.[0]) {
    try {
      return directParse(objectMatch[0]);
    } catch {
      // Fall through.
    }
  }

  return null;
}

function extractHintLevels(content: string) {
  const parsed = parseHintJson(content);
  if (parsed) {
    const levels = [parsed.hint1, parsed.hint2, parsed.hint3]
      .map((hint) => hint?.trim())
      .filter((hint): hint is string => Boolean(hint));

    if (levels.length === 3) {
      return levels;
    }
  }

  const matches = Array.from(
    content.matchAll(/(?:^|\n)\s*(?:hint\s*[1-3]|[1-3][\).\:\-])\s*(.+?)(?=(?:\n\s*(?:hint\s*[1-3]|[1-3][\).\:\-])\s)|$)/gis),
  )
    .map((match) => match[1]?.trim())
    .filter((hint): hint is string => Boolean(hint));

  if (matches.length >= 3) {
    return matches.slice(0, 3);
  }

  return [content.trim()];
}

function App() {
  const [dayIndex, setDayIndex] = useState(getDayIndex);
  const [answer, setAnswer] = useState(getDailyAnswer);
  const [gameMode, setGameMode] = useState<GameMode>("daily");
  const [guesses, setGuesses] = useState<SubmittedGuess[]>([]);
  const [currentGuess, setCurrentGuess] = useState("");
  const [confettiBurst, setConfettiBurst] = useState(0);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [dailyLocked, setDailyLocked] = useState(false);
  const [hint, setHint] = useState<HintState>({
    status: "idle",
    levels: [],
    revealed: 1,
    text: "",
  });
  const [definition, setDefinition] = useState<DefinitionState>({
    status: "idle",
    word: "",
    text: "",
  });
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>({
    text: "Decode today’s neon signal.",
    tone: "info",
  });

  const userId = currentUser?.sub ?? null;
  const isSolved = guesses.some((guess) => guess.word === answer);
  const isGameOver = isSolved || guesses.length === MAX_GUESSES;
  const isDailyMode = gameMode === "daily";
  const isDailyUnavailable = isDailyMode && dailyLocked;
  const isHintAvailable = guesses.length === MAX_GUESSES - 1 && !isGameOver && !isDailyUnavailable;

  const letterStates = useMemo(
    () =>
      guesses.reduce<LetterState>(
        (states, guess) => mergeLetterStates(states, guess.word, guess.evaluation),
        {},
      ),
    [guesses],
  );

  const boardRows = useMemo(() => {
    const rows = guesses.map((guess) =>
      guess.word.split("").map((letter, index) => ({
        letter,
        state: guess.evaluation[index],
      })),
    );

    if (!isGameOver) {
      rows.push(
        Array.from({ length: WORD_LENGTH }, (_, index) => ({
          letter: currentGuess[index] ?? "",
          state: "empty" as TileState,
        })),
      );
    }

    while (rows.length < MAX_GUESSES) {
      rows.push(
        Array.from({ length: WORD_LENGTH }, () => ({
          letter: "",
          state: "empty" as TileState,
        })),
      );
    }

    return rows;
  }, [currentGuess, guesses, isGameOver]);

  useEffect(() => {
    if (!notice || notice.tone === "error") {
      const timer = window.setTimeout(() => setNotice(null), 1600);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  useEffect(() => {
    if (!confettiBurst) {
      return;
    }

    const timer = window.setTimeout(() => setConfettiBurst(0), 3200);
    return () => window.clearTimeout(timer);
  }, [confettiBurst]);

  async function refreshSessionState() {
    const nextDayIndex = getDayIndex();
    const dayChanged = nextDayIndex !== dayIndex;

    if (dayChanged) {
      setDayIndex(nextDayIndex);
      setDailyLocked(false);

      if (gameMode === "daily") {
        setAnswer(getDailyAnswer());
        setGuesses([]);
        setCurrentGuess("");
        setHint({ status: "idle", levels: [], revealed: 1, text: "" });
        setDefinition({ status: "idle", word: "", text: "" });
        setNotice({
          text: "A new daily puzzle is live.",
          tone: "info",
        });
      }
    }

    const session = await getCurrentSession();

    if (session.authenticated && session.user) {
      setCurrentUser(session.user);
      setDailyLocked(session.dailyLocked);
      setAuthStatus("authenticated");
      return;
    }

    setCurrentUser(null);
    setDailyLocked(false);
    setAuthStatus("anonymous");
  }

  useEffect(() => {
    let cancelled = false;

    async function syncSessionState() {
      try {
        await refreshSessionState();
      } catch {
        if (cancelled) {
          return;
        }

        setCurrentUser(null);
        setDailyLocked(false);
        setAuthStatus("error");
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void syncSessionState();
      }
    }

    function handleFocus() {
      void syncSessionState();
    }

    void syncSessionState();

    const interval = window.setInterval(() => {
      void syncSessionState();
    }, 60_000);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [dayIndex, gameMode]);

  useEffect(() => {
    if (!isSolved) {
      setDefinition({ status: "idle", word: "", text: "" });
      return;
    }

    const controller = new AbortController();
    const lookupWord = answer.toLowerCase();

    setDefinition({
      status: "loading",
      word: answer,
      text: "",
    });

    async function loadDefinition() {
      try {
        const response = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${lookupWord}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          throw new Error("definition lookup failed");
        }

        const payload = (await response.json()) as Array<{
          meanings?: Array<{
            definitions?: Array<{
              definition?: string;
            }>;
          }>;
        }>;

        const firstDefinition = payload
          .flatMap((entry) => entry.meanings ?? [])
          .flatMap((meaning) => meaning.definitions ?? [])
          .map((entry) => entry.definition?.trim())
          .find(Boolean);

        setDefinition({
          status: "ready",
          word: answer,
          text: firstDefinition ?? fallbackDefinition(answer),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setDefinition({
          status: "error",
          word: answer,
          text: fallbackDefinition(answer),
        });
      }
    }

    loadDefinition();

    return () => controller.abort();
  }, [answer, isSolved]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        handleBackspace();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        handleSubmit();
        return;
      }

      if (/^[a-z]$/i.test(event.key)) {
        event.preventDefault();
        handleLetter(event.key);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function resetGame(mode: "daily" | "random") {
    setGameMode(mode);
    setAnswer((current) => (mode === "daily" ? getDailyAnswer() : makeRandomAnswer(current)));
    setGuesses([]);
    setCurrentGuess("");
    setConfettiBurst(0);
    setHint({ status: "idle", levels: [], revealed: 1, text: "" });
    setDefinition({ status: "idle", word: "", text: "" });
    setNotice({
      text:
        mode === "daily"
          ? dailyLocked
            ? "Daily puzzle already completed for today."
            : "Daily signal reloaded."
          : "Fresh random transmission.",
      tone: "info",
    });
  }

  function triggerConfetti() {
    setConfettiBurst(Date.now());
  }

  async function completeRound() {
    if (isDailyMode && userId) {
      await completeDailyRound();
      await refreshSessionState();
    }
  }

  async function requestHint() {
    if (!isHintAvailable) {
      return;
    }

    setHint({ status: "loading", levels: [], revealed: 1, text: "" });

    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          messages: [
            {
              role: "user",
              content: buildHintPrompt(answer, guesses),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error("hint lookup failed");
      }

      const payload = (await response.json()) as {
        message?: {
          content?: string;
        };
      };

      const content = payload.message?.content?.trim() || "No hint returned from Ollama.";
      const levels = extractHintLevels(content);

      setHint({
        status: "ready",
        levels,
        revealed: 1,
        text: content,
      });
    } catch (error) {
      setHint({
        status: "error",
        levels: [],
        revealed: 1,
        text: "Hint request failed. Check that Ollama is reachable and allows browser requests.",
      });
    }
  }

  function revealNextHint() {
    setHint((current) => ({
      ...current,
      revealed: Math.min(current.revealed + 1, current.levels.length),
    }));
  }

  function handleSignIn() {
    signIn();
  }

  function handleSignOut() {
    signOut();
  }

  function handleLetter(letter: string) {
    if (isGameOver || isDailyUnavailable || currentGuess.length >= WORD_LENGTH) {
      return;
    }

    setCurrentGuess((guess) => `${guess}${letter.toUpperCase()}`);
  }

  function handleBackspace() {
    if (isGameOver || isDailyUnavailable) {
      return;
    }

    setCurrentGuess((guess) => guess.slice(0, -1));
  }

  async function handleSubmit() {
    if (isGameOver || isDailyUnavailable) {
      return;
    }

    if (currentGuess.length < WORD_LENGTH) {
      setNotice({ text: "Need five letters.", tone: "error" });
      return;
    }

    if (!/^[A-Z]{5}$/.test(currentGuess)) {
      setNotice({ text: "Use a real five-letter word.", tone: "error" });
      return;
    }

    const evaluation = evaluateGuess(currentGuess, answer);
    const nextGuess = { word: currentGuess, evaluation };
    const nextGuesses = [...guesses, nextGuess];

    setGuesses(nextGuesses);
    setCurrentGuess("");

    if (currentGuess === answer) {
      await completeRound();
      triggerConfetti();
      setNotice({ text: "Lock opened. Perfect hit.", tone: "success" });
      return;
    }

    if (nextGuesses.length === MAX_GUESSES) {
      await completeRound();
      setNotice({ text: `Transmission lost. Answer: ${answer}.`, tone: "info" });
      return;
    }

    setNotice({ text: `${MAX_GUESSES - nextGuesses.length} attempts remaining.`, tone: "info" });
  }

  if (authStatus === "loading") {
    return <AuthScreen status="loading" onSignIn={handleSignIn} />;
  }

  if (authStatus !== "authenticated") {
    return <AuthScreen status={authStatus} onSignIn={handleSignIn} />;
  }

  return (
    <main className={`app-shell ${isSolved ? "is-solved" : ""}`}>
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />
      {confettiBurst ? <ConfettiBurst key={confettiBurst} /> : null}
      {isSolved ? (
        <section className="win-overlay" aria-live="polite">
          <div className="win-panel">
            <p className="win-kicker">Congratulations</p>
            <h2>{answer}</h2>
            <p className="win-copy">You cracked the signal.</p>
            <div className="definition-card">
              <span className="definition-label">Definition</span>
              <p>
                {definition.status === "loading"
                  ? "Looking up the word..."
                  : definition.text}
              </p>
            </div>
            <div className="win-actions">
              <button type="button" onClick={() => resetGame("random")}>
                Play Random
              </button>
              <button type="button" onClick={() => resetGame("daily")}>
                Reload Daily
              </button>
            </div>
          </div>
        </section>
      ) : null}
      <section className="game-card">
        <header className="hero">
          <div>
            <p className="eyebrow">Daily Neon Puzzle</p>
            <h1>Neon Wordle</h1>
          </div>
          <div className="hero-meta">
            <p className="hero-copy">
              Familiar rules, less restraint. Green, yellow, and gray still run the grid, but the
              rest of the board leans loud.
            </p>
            <div className="session-row">
              <span>{currentUser?.email ?? currentUser?.preferred_username ?? userId}</span>
              <button type="button" onClick={handleSignOut}>
                Sign Out
              </button>
            </div>
          </div>
        </header>

        <section className="status-bar">
          <div className={`notice notice-${notice?.tone ?? "info"}`}>
            {notice?.text ?? " "}
          </div>
          <div className="actions">
            <button type="button" onClick={() => resetGame("daily")}>
              Daily
            </button>
            <button type="button" onClick={() => resetGame("random")}>
              Random
            </button>
            {isHintAvailable ? (
              <button type="button" className="button-hint" onClick={requestHint}>
                {hint.status === "loading" ? "Asking AI..." : "Get Hint"}
              </button>
            ) : null}
          </div>
        </section>

        {isHintAvailable || hint.status === "ready" || hint.status === "error" ? (
          <section className={`hint-panel hint-${hint.status}`}>
            <div className="hint-header">
              <span>Last Chance Hint</span>
              <span>{OLLAMA_MODEL}</span>
            </div>
            {hint.status === "idle" ? <p>One attempt left. Ask the local model for a nudge.</p> : null}
            {hint.status === "loading" ? (
              <p>Generating layered hints from your local Ollama model...</p>
            ) : null}
            {hint.status === "error" ? <p>{hint.text}</p> : null}
            {hint.status === "ready" ? (
              <>
                <div className="hint-levels">
                  {hint.levels.slice(0, hint.revealed).map((level, index) => (
                    <article className="hint-level" key={`${index}-${level}`}>
                      <span className="hint-level-label">Hint {index + 1}</span>
                      <p>{level}</p>
                    </article>
                  ))}
                </div>
                {hint.revealed < hint.levels.length ? (
                  <button type="button" className="hint-expand" onClick={revealNextHint}>
                    Show Hint {hint.revealed + 1}
                  </button>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {isDailyUnavailable ? (
          <section className="daily-lock-panel">
            <span className="definition-label">Daily Complete</span>
            <p>You have already used today’s daily run. Come back after the next daily reset or switch to Random mode.</p>
          </section>
        ) : null}

        <section className="board" aria-label="Word grid">
          {boardRows.map((row, rowIndex) => (
            <div className="board-row" key={rowIndex}>
              {row.map((tile, tileIndex) => (
                <div
                  className={`tile tile-${tile.state} ${tile.letter ? "tile-filled" : ""}`}
                  key={`${rowIndex}-${tileIndex}`}
                >
                  {tile.letter}
                </div>
              ))}
            </div>
          ))}
        </section>

        <section className="keyboard" aria-label="On-screen keyboard">
          {KEYBOARD_ROWS.map((row) => (
            <div className="keyboard-row" key={row}>
              {row.split("").map((key) => (
                <button
                  className={`key key-${letterStates[key] ?? "empty"}`}
                  key={key}
                  type="button"
                  onClick={() => handleLetter(key)}
                >
                  {key}
                </button>
              ))}
              {row === "ZXCVBNM" && (
                <>
                  <button className="key key-wide" type="button" onClick={handleBackspace}>
                    Delete
                  </button>
                  <button className="key key-wide key-enter" type="button" onClick={handleSubmit}>
                    Enter
                  </button>
                </>
              )}
            </div>
          ))}
        </section>

        <footer className="game-footer">
          <span>5 letters</span>
          <span>6 tries</span>
          <span>{isGameOver ? "Round complete" : "Live"}</span>
        </footer>
      </section>
    </main>
  );
}

export default App;
