/**
 * Reading structured output back from a model that returns text.
 *
 * The seam is text-in, text-out on purpose (#89) — a model with tools would be
 * an executor with extra steps — so a proposer that wants structure has to
 * parse it. This is that parser, and it is deliberately strict.
 *
 * ## Why it throws rather than salvaging
 *
 * A proposer whose output cannot be parsed has failed, and the invocation
 * records `partial` with the proposer named. The alternative — salvaging what
 * can be read and proposing on the remainder — writes a decision-log entry that
 * looks like a considered proposal and is actually half of one. #90's approval
 * rate averages over these rows, and a half-parsed proposal rejected by a
 * reviewer would count against the class rather than against the parse.
 */

/**
 * Extract the first JSON object or array from a model's answer.
 *
 * Models fence code and add prose around it however they were trained to. This
 * takes the first fenced block if there is one, and otherwise the span from
 * the first brace or bracket to its matching close.
 */
export function parseModelJson<T = unknown>(text: string): T {
  const candidate = extractJson(text);
  if (candidate === null) {
    throw new Error('The model returned no JSON object or array.');
  }

  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    throw new Error(
      `The model returned unparseable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  const start = firstIndexOfEither(body, '{', '[');
  if (start === -1) return null;

  const open = body[start];
  const close = open === '{' ? '}' : ']';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;

  return body.slice(start, end + 1);
}

function firstIndexOfEither(text: string, a: string, b: string): number {
  const first = text.indexOf(a);
  const second = text.indexOf(b);
  if (first === -1) return second;
  if (second === -1) return first;
  return Math.min(first, second);
}

/**
 * A non-empty string, or throw naming the field.
 *
 * Named rather than generic, because "invalid proposal" in a log is a message
 * nobody can act on and `children[1].title is missing` is.
 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is missing or not a non-empty string.`);
  }
  return value.trim();
}

/** A non-empty array of non-empty strings, or throw naming the field. */
export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} is missing or empty.`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}
