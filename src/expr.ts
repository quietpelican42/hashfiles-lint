/**
 * Parses `hashFiles(...)` calls out of raw GitHub Actions expression text.
 *
 * hashFiles is an expression function: https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#hashfiles
 * Expression strings use single quotes, with `''` as an escaped quote
 * (there is no double-quoted string form in the expression grammar). Calls
 * are matched wherever they occur in a file's raw text, not only inside
 * `${{ }}` — `if:` conditions and `run:` steps both get expression
 * substitution without the wrapper.
 */

export interface ParsedArg {
  /** The raw argument text as written, trimmed. */
  raw: string;
  /** The literal string value, if this argument is a plain single-quoted string. `null` otherwise (a context ref, function call, etc. that cannot be evaluated statically). */
  literal: string | null;
}

export interface HashFilesCall {
  /** Offset of the `h` in `hashFiles` within the source text. */
  startIndex: number;
  /** Offset of the closing `)`. */
  endIndex: number;
  raw: string;
  args: ParsedArg[];
}

const CALL_RE = /hashFiles\s*\(/gi;

/** Finds every `hashFiles(...)` call in `text`, skipping ones on a commented-out YAML line. */
export function findHashFilesCalls(text: string): HashFilesCall[] {
  const calls: HashFilesCall[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(text))) {
    const openParenIndex = m.index + m[0].length - 1;
    if (isOnCommentedLine(text, m.index)) {
      CALL_RE.lastIndex = openParenIndex + 1;
      continue;
    }
    const parsed = parseArgs(text, openParenIndex);
    if (!parsed) {
      // Unterminated call (malformed expression) — nothing sensible to report.
      break;
    }
    calls.push({
      startIndex: m.index,
      endIndex: parsed.endIndex,
      raw: text.slice(m.index, parsed.endIndex + 1),
      args: parsed.args,
    });
    CALL_RE.lastIndex = parsed.endIndex + 1;
  }
  return calls;
}

/** True if the line containing `index` has a `#` comment marker before that column. */
function isOnCommentedLine(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const linePrefix = text.slice(lineStart, index);
  // A '#' preceded by start-of-line or whitespace, and not inside a quote,
  // starts a YAML comment. This is a heuristic, not a full YAML tokenizer.
  let inString = false;
  for (let i = 0; i < linePrefix.length; i++) {
    const ch = linePrefix[i];
    if (inString) {
      if (ch === "'" || ch === '"') inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
    } else if (ch === '#' && (i === 0 || /\s/.test(linePrefix[i - 1] as string))) {
      return true;
    }
  }
  return false;
}

function parseArgs(
  text: string,
  openParenIndex: number,
): { args: ParsedArg[]; endIndex: number } | null {
  let i = openParenIndex + 1;
  let depth = 0;
  let inString = false;
  let argStart = i;
  const args: ParsedArg[] = [];

  const pushArg = (end: number) => {
    const raw = text.slice(argStart, end).trim();
    if (raw.length > 0) args.push({ raw, literal: parseLiteral(raw) });
  };

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth === 0) {
        pushArg(i);
        return { args, endIndex: i };
      }
      depth--;
    } else if (ch === ',' && depth === 0) {
      pushArg(i);
      argStart = i + 1;
    }
  }
  return null;
}

function parseLiteral(raw: string): string | null {
  if (raw.length < 2 || raw[0] !== "'" || raw[raw.length - 1] !== "'") return null;
  return raw.slice(1, -1).replace(/''/g, "'");
}
