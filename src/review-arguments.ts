export interface ReviewArguments {
  modelIds: string[];
  paths: string[];
}

export const REVIEW_USAGE =
  "Usage: /review [reviewer-provider/model] [adversary-provider/model] [--path <repository-path>]...";

function argumentError(message: string): Error {
  return new Error(`${message}\n${REVIEW_USAGE}`);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;

  const finish = () => {
    if (!started) return;
    tokens.push(current);
    current = "";
    started = false;
  };

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (quote === '"' && character === "\\") {
        escaping = true;
      } else {
        current += character;
      }
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      finish();
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\") {
      escaping = true;
      started = true;
    } else {
      current += character;
      started = true;
    }
  }

  if (escaping) throw argumentError("Trailing escape in /review arguments.");
  if (quote) throw argumentError("Unterminated quote in /review arguments.");
  finish();
  return tokens;
}

export function parseReviewArguments(input: string): ReviewArguments {
  const modelIds: string[] = [];
  const paths: string[] = [];
  const tokens = tokenize(input);
  let optionsEnded = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && token === "--path") {
      const path = tokens[index + 1];
      if (path === undefined || path.length === 0) throw argumentError("--path requires a non-empty value.");
      paths.push(path);
      index += 1;
      continue;
    }

    if (!optionsEnded && token.startsWith("--path=")) {
      const path = token.slice("--path=".length);
      if (!path) throw argumentError("--path requires a non-empty value.");
      paths.push(path);
      continue;
    }

    if (!optionsEnded && token.startsWith("--")) {
      throw argumentError(`Unknown /review option: ${JSON.stringify(token)}.`);
    }

    modelIds.push(token);
  }

  if (modelIds.length > 2) throw argumentError("At most two reviewer models may be supplied.");
  return { modelIds, paths };
}
