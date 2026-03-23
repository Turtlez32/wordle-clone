export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

export type TileState = "correct" | "present" | "absent" | "empty";

export type LetterState = Record<string, Exclude<TileState, "empty">>;

const TILE_PRIORITY: Record<Exclude<TileState, "empty">, number> = {
  absent: 0,
  present: 1,
  correct: 2,
};

export function evaluateGuess(guess: string, answer: string): TileState[] {
  const result: TileState[] = Array.from({ length: WORD_LENGTH }, () => "absent");
  const answerChars = answer.split("");
  const guessChars = guess.split("");

  guessChars.forEach((char, index) => {
    if (char === answerChars[index]) {
      result[index] = "correct";
      answerChars[index] = "";
      guessChars[index] = "*";
    }
  });

  guessChars.forEach((char, index) => {
    if (char === "*") {
      return;
    }

    const presentIndex = answerChars.indexOf(char);
    if (presentIndex >= 0) {
      result[index] = "present";
      answerChars[presentIndex] = "";
    }
  });

  return result;
}

export function mergeLetterStates(
  current: LetterState,
  guess: string,
  evaluation: TileState[],
): LetterState {
  const next = { ...current };

  guess.split("").forEach((char, index) => {
    const state = evaluation[index];
    if (state === "empty") {
      return;
    }

    const existing = next[char];
    if (!existing || TILE_PRIORITY[state] > TILE_PRIORITY[existing]) {
      next[char] = state;
    }
  });

  return next;
}

export function getDayIndex(date = new Date()): number {
  const utcDate = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const epoch = Date.UTC(2024, 0, 1);
  return Math.floor((utcDate - epoch) / 86_400_000);
}
