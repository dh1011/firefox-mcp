/**
 * Parses the `browser` tool's command lines: one command per line, blank lines and `#` comments ignored, arguments with
 * spaces in double quotes with JSON escaping (single quotes work too), except for `eval`'s code and file paths, which
 * keep their backslashes. Locators, CSS attribute selectors and the like are single tokens even with spaces inside, since
 * brackets and quotes nest. Errors give a column, never the text, which may be something secret the agent types.
 */

export type Token = { text: string; quoted: boolean };

export type CommandLine = { step: number; source: string };

export class ParseError extends Error {}

export function parseCommands(input: string): CommandLine[] {
  const commands: CommandLine[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const source = raw.trim();
    if (!source || source.startsWith("#")) continue;
    commands.push({ step: commands.length + 1, source });
  }
  return commands;
}

export function commandName(source: string): string {
  return source.split(/\s/, 1)[0] ?? "";
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Their quoted arguments keep backslashes: JavaScript in `eval`, and Windows paths in the two that take a file */
const VERBATIM_COMMANDS = new Set(["eval", "upload", "screenshot"]);

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const verbatim = VERBATIM_COMMANDS.has(commandName(line));
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanQuoted(line, i, ch);
      tokens.push({ text: unquote(line, i, end, verbatim), quoted: true });
      i = end;
      continue;
    }
    const start = i;
    const stack: string[] = [];
    while (i < line.length) {
      const c = line[i]!;
      if (stack.length === 0 && /\s/.test(c)) break;
      if (c in CLOSERS) {
        stack.push(CLOSERS[c]!);
        i++;
      } else if (stack.length > 0 && c === stack.at(-1)) {
        stack.pop();
        i++;
      } else if (stack.length > 0 && (c === "'" || c === '"' || c === "`")) {
        i = scanQuoted(line, i, c);
      } else if (stack.length > 0 && c === "/" && isRegexStart(line, i)) {
        i = scanQuoted(line, i, "/");
        while (/[a-z]/.test(line[i] ?? "")) i++;
      } else {
        i++;
      }
    }
    if (stack.length > 0) {
      throw new ParseError(
        `Unbalanced brackets in the argument at column ${start + 1}: missing ${stack.reverse().join("")}`,
      );
    }
    tokens.push({ text: line.slice(start, i), quoted: false });
  }
  return tokens;
}

function scanQuoted(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") i += 2;
    else if (line[i] === quote) return i + 1;
    else i++;
  }
  throw new ParseError(`Missing closing ${quote} for the quote at column ${start + 1}`);
}

function unquote(line: string, start: number, end: number, verbatim: boolean): string {
  const quote = line[start]!;
  if (verbatim) {
    // Only the quote's own escape is decoded
    return line
      .slice(start + 1, end - 1)
      .replace(/\\([^])/g, (match, next: string) => (next === quote ? quote : match));
  }
  let literal = line.slice(start, end);
  if (quote === "'") {
    literal = `"${literal
      .slice(1, -1)
      .replace(/\\(.)|"/g, (match, escaped: string | undefined) =>
        escaped === "'" ? "'" : escaped === undefined ? '\\"' : match,
      )}"`;
  }
  try {
    return JSON.parse(literal) as string;
  } catch {
    throw new ParseError(
      `Bad escaping in the quoted argument at column ${start + 1}. Escape like JSON (\\" and \\\\)`,
    );
  }
}

function isRegexStart(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd().at(-1);
  return before === "(" || before === "," || before === ":";
}

export type ParsedArgs = {
  positional: Token[];
  flags: Record<string, string | true>;
};

/** Which flags a command takes: `true` for a flag with a value, `false` for a switch */
export type FlagSpec = Record<string, boolean>;

/** Quoted tokens are always positional, so text like "--submit" can be typed */
export function parseArgs(command: string, tokens: Token[], spec: FlagSpec): ParsedArgs {
  const positional: Token[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.quoted || !/^(--[a-z][a-z-]*|-[a-z])$/.test(token.text)) {
      positional.push(token);
      continue;
    }
    const name = token.text.replace(/^-+/, "");
    if (!Object.hasOwn(spec, name)) {
      throw new ParseError(`${command} has no ${token.text} flag. Run \`help ${command}\``);
    }
    if (spec[name]) {
      const value = tokens[i + 1];
      if (!value) throw new ParseError(`${token.text} needs a value`);
      flags[name] = value.text;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}
