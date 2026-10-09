/**
 * The single CSV serializer for DanceFlow exports.
 *
 * CONTRACT
 * - Cells are RFC 4180 style: a cell containing `,`, `"`, LF or CR is wrapped in
 *   double quotes and embedded quotes are doubled. Rows are joined with "\n".
 * - null / undefined serialize as an empty cell.
 * - Numbers and booleans are trusted values the caller computed: they are
 *   serialized as-is (so a negative number stays `-5`, never `'-5`).
 * - Everything else is TEXT. Text is untrusted (it may be studio- or
 *   customer-entered) and is spreadsheet-formula neutralized: if the first
 *   meaningful character is `=`, `+`, `-` or `@` the cell is prefixed with an
 *   apostrophe (`'`), the same convention the payroll and accountant exports
 *   already used. "Meaningful" skips leading whitespace, control characters and
 *   invisible format characters, which spreadsheets ignore before evaluating a
 *   formula. A cell that starts with TAB or CR is also neutralized. The original
 *   text is preserved (nothing is trimmed); NUL characters are removed.
 * - The one text exception: a plain decimal literal such as `-12.50` or `3`
 *   (optional leading `-`, digits, optional fraction) is left unchanged. It
 *   cannot execute and this keeps money strings like `(-12).toFixed(2)` numeric.
 *   Anything with an operator, function, `+`, exponent or other text is still
 *   neutralized (`-1+2`, `+1`, `-1e3`).
 */

// Characters spreadsheets skip before a formula marker: whitespace, C0/C1
// controls, soft hyphen, zero-width / bidi marks, line and paragraph
// separators, word joiners and the BOM.
function isIgnoredPrefix(code: number) {
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0xa0) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}
const DECIMAL_LITERAL = /^-?\d+(?:\.\d+)?$/;

function startsWithFormulaTrigger(text: string) {
  const first = text.charCodeAt(0);
  // TAB (9) and CR (13) at the very start are themselves a known injection vector.
  if (first === 9 || first === 13) return true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isIgnoredPrefix(text.charCodeAt(i))) continue;
    return ch === "=" || ch === "+" || ch === "-" || ch === "@";
  }
  return false;
}

/** Neutralize spreadsheet formulas in untrusted text. Does not quote. */
export function neutralizeCsvFormula(text: string) {
  const clean = text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
  if (DECIMAL_LITERAL.test(clean)) return clean;
  return startsWithFormulaTrigger(clean) ? `'${clean}` : clean;
}

/** Serialize one cell (see the contract above). */
export function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const str =
    typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : neutralizeCsvFormula(String(value));
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>) {
  const headerLine = headers.map(csvEscape).join(",");
  const rowLines = rows.map((row) => row.map(csvEscape).join(","));
  return [headerLine, ...rowLines].join("\n");
}
