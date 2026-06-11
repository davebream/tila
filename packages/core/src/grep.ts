/**
 * Pure grep matcher + validator for server-side artifact content grep.
 *
 * Platform-agnostic — no Cloudflare/SQLite imports. Reachable by both
 * the Worker (`@tila/core` is a worker dep) and `backend-local`.
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class GrepQueryError extends Error {
  override name = "GrepQueryError";

  constructor(message: string) {
    super(message);
    // Maintain proper prototype chain in compiled ES targets
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Cap constants
// ---------------------------------------------------------------------------

/** Maximum number of candidate artifacts to scan per request (== SWEEP_BATCH_SIZE). */
export const GREP_CANDIDATE_CAP = 100;

/** Per-blob raw-byte scan ceiling (1 MiB). */
export const GREP_PER_BLOB_BYTE_CAP = 1_048_576;

/** Total raw-byte scan ceiling across the entire request (64 MiB). */
export const GREP_TOTAL_BYTE_CAP = 67_108_864;

/** DO→Worker inline-payload budget (8 MiB). */
export const GREP_INLINE_RESPONSE_BUDGET = 8_388_608;

/** Maximum total match entries across the entire request. */
export const GREP_MAX_MATCHES = 1000;

/** Maximum match entries per individual blob. */
export const GREP_MAX_MATCHES_PER_BLOB = 50;

/** Maximum UTF-16 code-unit length for the `text` field of a match. */
export const GREP_MAX_LINE_TEXT = 512;

/**
 * Maximum number of UTF-16 code units of a line fed to a regex engine.
 * Bounds worst-case backtracking input.
 */
export const GREP_REGEX_LINE_INPUT_CAP = 2048;

/** Request deadline in milliseconds. */
export const GREP_DEADLINE_MS = 20_000;

// ---------------------------------------------------------------------------
// GrepMatcher interface
// ---------------------------------------------------------------------------

/**
 * A compiled, reusable line matcher.
 *
 * `test(line)` returns the 1-based UTF-16 code-unit column of the first match
 * on the line, or `null` if there is no match.
 */
export interface GrepMatcher {
  test(line: string): number | null;
}

// ---------------------------------------------------------------------------
// Pattern validation
// ---------------------------------------------------------------------------

/**
 * Validate a grep pattern, throwing `GrepQueryError` for patterns that are
 * over-length or (in regex mode) would risk catastrophic backtracking.
 *
 * Literal mode (`regex: false`) skips all regex-grammar checks — only the
 * length cap applies.
 */
export function validateGrepPattern(
  pattern: string,
  opts: { regex: boolean },
): void {
  if (pattern.length > 200) {
    throw new GrepQueryError("Pattern must be 200 characters or fewer.");
  }

  if (!opts.regex) {
    // Literal mode — no further grammar checks.
    return;
  }

  // --- Regex mode checks ---

  // 1. Backreferences: \1 through \9
  if (/\\[1-9]/.test(pattern)) {
    throw new GrepQueryError(
      "Backreferences are not permitted in regex patterns.",
    );
  }

  // 2. Lookahead / lookbehind
  if (/\(\?[=!]/.test(pattern) || /\(\?<[=!]/.test(pattern)) {
    throw new GrepQueryError(
      "Lookahead and lookbehind assertions are not permitted.",
    );
  }

  // 3. Nested unbounded quantifiers — a quantifier (*|+|{n,}) applied to a
  //    group that itself contains an unbounded quantifier (*|+|{n,}).
  //    Heuristic: scan for patterns of the form (…[*+]…)[*+] or (…[*+]…){n,}
  //    We look for: a closing ) followed by a quantifier, where the group
  //    body contained an unbounded quantifier.
  //
  //    Strategy: find each top-level group boundary and check if:
  //    - the group body has an unbounded quantifier inside it, AND
  //    - the group itself has an unbounded outer quantifier.
  //
  //    We use a simple bracket-depth scan rather than a full parser.
  //
  //    Known uncaught catastrophic classes (Phase-1 backstop is the per-line
  //    input cap GREP_REGEX_LINE_INPUT_CAP + the GREP_DEADLINE_MS deadline):
  //    - Alternation-based exponential:  (a|a)+  — two identical alternatives
  //      inside an unbounded group; the outer quantifier is caught here, but
  //      polynomial backtracking from ambiguous alternation is not detected.
  //    - Nested grouping without explicit inner quantifier:  (.*)*  — caught
  //      when the inner group contains `.*` (unbounded `*` on `.`), but more
  //      complex variants may slip through the heuristic scanner.
  //    These cases are mitigated in practice by the line-input cap, which
  //    limits worst-case backtracking input to GREP_REGEX_LINE_INPUT_CAP
  //    UTF-16 code units, and the per-request deadline.
  detectNestedUnboundedQuantifiers(pattern);
  detectAmbiguousAlternation(pattern);
}

/**
 * Heuristic detection of nested unbounded quantifiers.
 * Throws `GrepQueryError` if found.
 *
 * Checks: (inner_unbounded_quantifier)outer_unbounded_quantifier
 * where outer is *, +, or {n,} (with no upper bound).
 */
function detectNestedUnboundedQuantifiers(pattern: string): void {
  // Walk the pattern character by character, tracking bracket depth.
  // When we close a group (depth decreases to 0 of the group's start), check
  // if the group body had an unbounded quantifier.

  const len = pattern.length;
  let i = 0;

  while (i < len) {
    if (pattern[i] === "\\") {
      // Skip escaped character
      i += 2;
      continue;
    }

    if (pattern[i] === "[") {
      // Skip character class content
      i++;
      while (i < len && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++; // skip escape
        i++;
      }
      i++; // skip closing ]
      continue;
    }

    if (pattern[i] === "(") {
      // Find the matching closing paren, tracking the body
      const groupStart = i;
      let depth = 1;
      i++;
      const bodyStart = i;

      let bodyHasUnbounded = false;

      while (i < len && depth > 0) {
        if (pattern[i] === "\\") {
          i += 2;
          continue;
        }
        if (pattern[i] === "[") {
          i++;
          while (i < len && pattern[i] !== "]") {
            if (pattern[i] === "\\") i++;
            i++;
          }
          i++;
          continue;
        }
        if (pattern[i] === "(") {
          depth++;
        } else if (pattern[i] === ")") {
          depth--;
          if (depth === 0) {
            // We found the matching close paren
            break;
          }
        } else if (depth === 1) {
          // Check for unbounded quantifiers only at depth==1 (direct body)
          // to catch simple cases like (a+)
          // But we also need to catch nested groups with unbounded quantifiers.
          // The approach: scan body content for * or + not inside a nested group.
          // We track unbounded quantifiers at any depth inside the body.
          if (pattern[i] === "*" || pattern[i] === "+") {
            bodyHasUnbounded = true;
          } else if (pattern[i] === "{") {
            // Check for {n,} — unbounded repetition
            const braceContent = extractBraceContent(pattern, i);
            if (braceContent !== null && isUnboundedBrace(braceContent)) {
              bodyHasUnbounded = true;
            }
          }
        } else {
          // depth > 1: inside nested group — also track unbounded quantifiers
          if (pattern[i] === "*" || pattern[i] === "+") {
            bodyHasUnbounded = true;
          } else if (pattern[i] === "{") {
            const braceContent = extractBraceContent(pattern, i);
            if (braceContent !== null && isUnboundedBrace(braceContent)) {
              bodyHasUnbounded = true;
            }
          }
        }
        i++;
      }
      // i is now at the closing )
      const _bodyEnd = i;
      i++; // move past )

      if (bodyHasUnbounded) {
        // Check if the group itself has an outer unbounded quantifier
        if (i < len) {
          if (pattern[i] === "*" || pattern[i] === "+") {
            throw new GrepQueryError(
              "Nested unbounded quantifiers (e.g. (a+)+) are not permitted in regex patterns.",
            );
          }
          if (pattern[i] === "{") {
            const braceContent = extractBraceContent(pattern, i);
            if (braceContent !== null && isUnboundedBrace(braceContent)) {
              throw new GrepQueryError(
                "Nested unbounded quantifiers (e.g. (a+){n,}) are not permitted in regex patterns.",
              );
            }
          }
        }
      }
      // Don't advance i — it already points to next char after )
      continue;
    }

    i++;
  }
}

/** Extract the content between { and } starting at `pos`. Returns null if not a valid brace. */
function extractBraceContent(pattern: string, pos: number): string | null {
  if (pattern[pos] !== "{") return null;
  const end = pattern.indexOf("}", pos + 1);
  if (end === -1) return null;
  return pattern.slice(pos + 1, end);
}

/** Returns true for {n,} where no upper bound is specified. */
function isUnboundedBrace(content: string): boolean {
  // Match {n,} but not {n,m}
  return /^\d+,$/.test(content);
}

function detectAmbiguousAlternation(pattern: string): void {
  const len = pattern.length;
  let i = 0;

  while (i < len) {
    if (pattern[i] === "\\") {
      i += 2;
      continue;
    }
    if (pattern[i] === "[") {
      i++;
      while (i < len && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (pattern[i] !== "(") {
      i++;
      continue;
    }

    let depth = 1;
    i++;
    const bodyStart = i;
    while (i < len && depth > 0) {
      if (pattern[i] === "\\") {
        i += 2;
        continue;
      }
      if (pattern[i] === "[") {
        i++;
        while (i < len && pattern[i] !== "]") {
          if (pattern[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (pattern[i] === "(") depth++;
      if (pattern[i] === ")") depth--;
      i++;
    }
    const body = pattern.slice(bodyStart, i - 1);
    const quantifier = pattern[i] ?? "";
    const braceContent =
      quantifier === "{" ? extractBraceContent(pattern, i) : null;
    const hasOuterUnbounded =
      quantifier === "*" ||
      quantifier === "+" ||
      (braceContent !== null && isUnboundedBrace(braceContent));
    if (!hasOuterUnbounded || !body.includes("|")) {
      continue;
    }

    const alternatives = splitTopLevelAlternatives(body)
      .map(normalizeSimpleLiteralAlternative)
      .filter((value): value is string => value !== null);
    for (let left = 0; left < alternatives.length; left++) {
      for (let right = left + 1; right < alternatives.length; right++) {
        const a = alternatives[left];
        const b = alternatives[right];
        if (a === b || a.startsWith(b) || b.startsWith(a)) {
          throw new GrepQueryError(
            "Ambiguous alternation inside an unbounded group is not permitted in regex patterns.",
          );
        }
      }
    }
  }
}

function splitTopLevelAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === "[") {
      i++;
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (body[i] === "(") depth++;
    if (body[i] === ")") depth--;
    if (body[i] === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function normalizeSimpleLiteralAlternative(value: string): string | null {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\") {
      i++;
      if (i >= value.length) return null;
      result += value[i];
      continue;
    }
    if ("()[]{}*+?.^$|".includes(char)) {
      return null;
    }
    result += char;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile a grep pattern into a reusable `GrepMatcher`.
 *
 * Does NOT call `validateGrepPattern` — callers are expected to validate
 * before compiling, or catch `GrepQueryError` from this function.
 */
export function compileGrepMatcher(
  pattern: string,
  opts: { regex: boolean },
): GrepMatcher {
  if (!opts.regex) {
    // Literal mode: use indexOf — zero regex engine, zero ReDoS surface.
    return {
      test(line: string): number | null {
        const idx = line.indexOf(pattern);
        return idx === -1 ? null : idx + 1;
      },
    };
  }

  // Regex mode: compile once, no `g` flag (first-match col via exec.index).
  const re = new RegExp(pattern);
  return {
    test(line: string): number | null {
      // Cap the input to avoid worst-case backtracking on very long lines.
      const input =
        line.length > GREP_REGEX_LINE_INPUT_CAP
          ? line.slice(0, GREP_REGEX_LINE_INPUT_CAP)
          : line;
      const m = re.exec(input);
      return m === null ? null : m.index + 1;
    },
  };
}

// ---------------------------------------------------------------------------
// matchLine
// ---------------------------------------------------------------------------

/**
 * Test a single line against a compiled matcher.
 *
 * Returns `null` if there is no match. Otherwise returns
 * `{ line, text, col }` where:
 * - `line` is the 1-based line number passed in.
 * - `text` is the line text truncated to `GREP_MAX_LINE_TEXT` UTF-16 code units.
 * - `col` is the 1-based UTF-16 code-unit offset of the first match on the line.
 *
 * Note (Phase 1 limitation): for non-ASCII lines `col` is a character offset,
 * not a raw-byte offset. Byte-accurate offsets are deferred.
 */
export function matchLine(
  m: GrepMatcher,
  text: string,
  line: number,
): { line: number; text: string; col: number } | null {
  const col = m.test(text);
  if (col === null) return null;
  return {
    line,
    text:
      text.length > GREP_MAX_LINE_TEXT
        ? text.slice(0, GREP_MAX_LINE_TEXT)
        : text,
    col,
  };
}

// ---------------------------------------------------------------------------
// Line splitter
// ---------------------------------------------------------------------------

/**
 * Split a decoded text chunk into completed lines, carrying the trailing
 * partial line into `pending` for the next chunk.
 *
 * - Splits on `\n`.
 * - Strips a single trailing `\r` from each **completed** line (`\r\n` support).
 * - `pending` from the previous chunk is prepended to the new chunk before
 *   splitting.
 * - Caller is responsible for flushing a non-empty final `pending` at EOF
 *   as the last line.
 */
export function splitChunkIntoLines(
  pending: string,
  chunk: string,
): { lines: string[]; pending: string } {
  const combined = pending + chunk;
  const parts = combined.split("\n");

  // All parts except the last are complete lines (they had a \n after them).
  // The last part is the new pending (may be empty if chunk ended with \n).
  const newPending = parts[parts.length - 1] ?? "";
  const completedParts = parts.slice(0, -1);

  // Strip a single trailing \r from each completed line (\r\n → \n handling).
  const lines = completedParts.map((l) => l.replace(/\r$/, ""));

  return { lines, pending: newPending };
}
