/**
 * DataTable — CSV serialization (issue #256, epic #238).
 *
 * The PURE half of export: scalars in, a CSV string out. Nothing here knows
 * about columns, rows, React or the DOM, which is what makes the escaping rules
 * testable as arithmetic rather than through a rendered table.
 *
 * Three rules, and all three exist because a CSV is not just text — it is a
 * file another program will open:
 *
 *  1. **RFC 4180 quoting.** A field containing a comma, a double quote, a CR or
 *     an LF is wrapped in double quotes with internal quotes doubled. Rows are
 *     separated by CRLF, which is what the RFC specifies and what Excel expects.
 *  2. **Formula-injection neutralization.** A cell whose text starts with `=`,
 *     `+`, `-`, `@` (or a leading tab / CR, which some spreadsheets strip before
 *     parsing) is executable the moment the file is opened in Excel, Sheets or
 *     LibreOffice — `=cmd|'/c calc'!A1` is the classic proof. Those fields get a
 *     leading apostrophe, the one prefix every major spreadsheet treats as
 *     "this is literal text". See OWASP "CSV Injection".
 *  3. **A UTF-8 BOM.** Excel on Windows reads a BOM-less UTF-8 CSV as the local
 *     ANSI code page, so `José` opens as `JosÃ©`. Three bytes fix it, and every
 *     other consumer skips them.
 *
 * ### Why numbers are exempt from rule 2
 *
 * Neutralizing blindly would turn the number `-5` into the text `'-5`, breaking
 * every numeric column that can go negative — a real regression traded for a
 * theoretical attack, since `-5` is not a formula. So the prefix is applied only
 * to text that is not a well-formed number. A genuinely dangerous cell
 * (`-1+cmd|…`) does not parse as a number and is still neutralized.
 */

/**
 * The UTF-8 byte-order mark, as a JS string.
 *
 * Prepended to the *file*, never to a field: `toCsv` deliberately returns
 * BOM-less text so it can be composed, and {@link toCsvFile} is the thing that
 * gets written to disk.
 */
export const CSV_BOM = '\uFEFF';

/** RFC 4180 row separator. Excel is the reason this is CRLF and not `\n`. */
export const CSV_ROW_SEPARATOR = '\r\n';

/** RFC 4180 field separator. */
export const CSV_FIELD_SEPARATOR = ',';

/**
 * The characters that make a leading position dangerous.
 *
 * `=`, `+`, `-` and `@` start a formula in Excel / Sheets / LibreOffice. Tab and
 * CR are here because some spreadsheets strip leading whitespace *before*
 * deciding whether a cell is a formula, so `\t=1+1` is `=1+1`.
 */
export const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/** The prefix that forces a spreadsheet to treat a cell as literal text. */
export const CSV_FORMULA_ESCAPE = "'";

/** Anything a spreadsheet would read as a number, and therefore never a formula. */
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Characters that force a field to be quoted. */
const MUST_QUOTE = /["\r\n,]/;

/**
 * Whether a raw string would be interpreted as a formula by a spreadsheet.
 *
 * Exported because "is this dangerous" is a question worth asserting directly,
 * separately from what the escaper then does about it.
 */
export function isFormulaText(text: string): boolean {
  if (text.length === 0) return false;
  if (!(CSV_FORMULA_PREFIXES as readonly string[]).includes(text[0])) return false;
  // `-5` / `+1.5e3` are numbers, not formulas. Neutralizing them would corrupt
  // every numeric column that can go negative.
  return !NUMERIC_TEXT.test(text);
}

/** Prefix a formula-shaped field so it opens as literal text. */
export function neutralizeFormula(text: string): string {
  return isFormulaText(text) ? `${CSV_FORMULA_ESCAPE}${text}` : text;
}

/**
 * One scalar → one fully escaped CSV field.
 *
 * `null` / `undefined` become an EMPTY field, not `—`: the em dash is a display
 * convention for a human reading a table (`formatColumnValue`), and writing it
 * into a CSV would turn "no value" into the literal three-byte string a
 * downstream import would then have to know about.
 *
 * Numbers are stringified and never neutralized (see the module note).
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'number' ? String(value) : neutralizeFormula(value);

  // Leading/trailing whitespace is quoted too: it is semantically meaningful and
  // several parsers trim unquoted fields.
  const needsQuotes = MUST_QUOTE.test(text) || text !== text.trim();
  if (!needsQuotes) return text;

  return `"${text.replace(/"/g, '""')}"`;
}

/** One record → one CSV line (no trailing separator). */
export function toCsvRow(fields: readonly (string | number | null | undefined)[]): string {
  return fields.map(escapeCsvField).join(CSV_FIELD_SEPARATOR);
}

/**
 * A header row plus body rows → CSV text, WITHOUT the BOM.
 *
 * A trailing CRLF is emitted after the final record (RFC 4180 permits it and
 * POSIX tools expect a final line terminator) whenever there is at least one
 * row of content.
 */
export function toCsv(
  header: readonly string[],
  body: readonly (readonly (string | number | null | undefined)[])[],
): string {
  const lines = [toCsvRow(header), ...body.map((row) => toCsvRow(row))];
  return `${lines.join(CSV_ROW_SEPARATOR)}${CSV_ROW_SEPARATOR}`;
}

/** {@link toCsv} plus the UTF-8 BOM — i.e. the exact bytes written to disk. */
export function toCsvFile(
  header: readonly string[],
  body: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return `${CSV_BOM}${toCsv(header, body)}`;
}
