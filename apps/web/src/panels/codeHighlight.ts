/**
 * Tiny regex tokenizer for the code panel. Not a parser — just enough
 * classification (comments, strings, numbers, keywords, calls) to make code
 * scannable from across a room. Unknown languages get the C-like profile.
 */

export type CodeTokenType = "kw" | "str" | "com" | "num" | "fn" | "plain";

export interface CodeToken {
  type: CodeTokenType;
  text: string;
}

interface LangProfile {
  /** Line-comment marker; "//" also enables C-style block comments. */
  lineComment: "#" | "//" | "--";
  tripleQuotes?: boolean;
  keywords: Set<string>;
}

const kw = (s: string) => new Set(s.split(" "));

const PYTHON: LangProfile = {
  lineComment: "#",
  tripleQuotes: true,
  keywords: kw(
    "def return if elif else for while in not and or is None True False " +
      "class import from as with try except finally raise yield lambda " +
      "pass break continue global nonlocal del assert async await match case",
  ),
};

const C_LIKE: LangProfile = {
  lineComment: "//",
  keywords: kw(
    "function return if else for while do switch case break continue " +
      "const let var new class extends implements interface type enum " +
      "import export from default try catch finally throw async await " +
      "yield typeof instanceof in of this super null undefined true false " +
      "void int char float double long short unsigned struct union sizeof " +
      "static public private protected final abstract package go defer " +
      "func chan map range fn mut impl trait match pub use mod crate " +
      "self Self where unsafe println print",
  ),
};

const SHELL: LangProfile = {
  lineComment: "#",
  keywords: kw(
    "if then else elif fi for while do done case esac in function return " +
      "local export echo cd source exit set shift read declare",
  ),
};

const SQL: LangProfile = {
  lineComment: "--",
  keywords: kw(
    "select from where group by order having limit offset join left right " +
      "inner outer on as insert into values update set delete create table " +
      "index view drop alter and or not null is in like between distinct " +
      "count sum avg min max union all exists case when then else end " +
      "SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN LEFT RIGHT " +
      "INNER OUTER ON AS INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE " +
      "INDEX VIEW DROP ALTER AND OR NOT NULL IS IN LIKE BETWEEN DISTINCT " +
      "COUNT SUM AVG MIN MAX UNION ALL EXISTS CASE WHEN THEN ELSE END",
  ),
};

function profileFor(language?: string): LangProfile {
  switch ((language ?? "").toLowerCase()) {
    case "python":
    case "py":
      return PYTHON;
    case "bash":
    case "sh":
    case "shell":
    case "zsh":
      return SHELL;
    case "sql":
      return SQL;
    default:
      return C_LIKE;
  }
}

function buildRegex(p: LangProfile): RegExp {
  const parts: string[] = [];
  if (p.tripleQuotes) parts.push(`"""[\\s\\S]*?(?:"""|$)`, `'''[\\s\\S]*?(?:'''|$)`);
  if (p.lineComment === "//") parts.push(`\\/\\*[\\s\\S]*?(?:\\*\\/|$)`, `\\/\\/[^\\n]*`);
  else if (p.lineComment === "--") parts.push(`--[^\\n]*`);
  else parts.push(`#[^\\n]*`);
  parts.push(
    `"(?:\\\\.|[^"\\\\\\n])*(?:"|$)`,
    `'(?:\\\\.|[^'\\\\\\n])*(?:'|$)`,
    "`(?:\\\\.|[^`\\\\])*(?:`|$)",
    `\\b0[xXbBoO][0-9a-fA-F_]+\\b`,
    `\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b`,
    `\\b[A-Za-z_][A-Za-z0-9_]*\\b`,
  );
  return new RegExp(parts.join("|"), "g");
}

function classify(text: string, p: LangProfile, source: string, end: number): CodeTokenType {
  const c = text[0];
  if (
    (p.lineComment === "#" && c === "#") ||
    (p.lineComment === "--" && text.startsWith("--")) ||
    (p.lineComment === "//" && (text.startsWith("//") || text.startsWith("/*")))
  )
    return "com";
  if (c === '"' || c === "'" || c === "`") return "str";
  if (c >= "0" && c <= "9") return "num";
  if (p.keywords.has(text)) return "kw";
  // A call: identifier directly followed by an open paren.
  if (source[end] === "(") return "fn";
  return "plain";
}

/** Tokenize source into lines of typed tokens (a token never spans lines). */
export function highlightCode(code: string, language?: string): CodeToken[][] {
  const profile = profileFor(language);
  const re = buildRegex(profile);
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) tokens.push({ type: "plain", text: code.slice(last, i) });
    tokens.push({ type: classify(m[0], profile, code, i + m[0].length), text: m[0] });
    last = i + m[0].length;
  }
  if (last < code.length) tokens.push({ type: "plain", text: code.slice(last) });

  // Split multi-line tokens (block comments, triple strings) at newlines.
  const lines: CodeToken[][] = [[]];
  for (const t of tokens) {
    const segs = t.text.split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) lines.push([]);
      if (seg) lines[lines.length - 1].push({ type: t.type, text: seg });
    });
  }
  return lines;
}
