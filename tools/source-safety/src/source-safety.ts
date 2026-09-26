/**
 * Source safety for the public repository. A tracked path must not name credential, backup,
 * or database material, or embed a credential or personal data. Dotenv files must hold only
 * placeholders or reviewed test sentinels, and SQL must not carry literal personal or secret
 * data. Other textual files must be valid UTF-8. The rules are heuristics; reviewed exceptions
 * are exact paths or exact file digests, each with a recorded reason.
 */
import { createHash } from "node:crypto";

export type SourceSafetyReason = "INVALID_UTF8" | "UNSAFE_SOURCE";

const unsafePathSegmentPattern =
  /(?:^|\/)(?:credentials?(?:$|[._-]|\/)|secrets?(?:$|[._-]|\/)|private[-_]?keys?(?:$|[._-]|\/)|(?:raw[-_]?payloads?|payloads?|backups?|dumps?|databases?|database|db)(?:$|[._-]|\/))/i;

const unsafePathExtensionPattern =
  /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|dump|bak|backup)$/i;

// Source code, migrations, and the module guides of the database package. Its other files are
// judged by their path class, which `database` in the path makes unsafe.
const databaseSourceCodePathPattern =
  /^packages\/database\/(?:package\.json|tsconfig\.json|(?:src\/[^/]+\/)?(?:AGENTS|CLAUDE)\.md|(?:src|runtime|test|examples)\/(?:[^/]+\/)*[^/]+\.ts|migrations\/(?:[^/]+\/)*[^/]+\.sql)$/;

/**
 * Reviewed tracked source whose path resembles a blocked class. Each entry records why the
 * file is source code rather than credential, backup, or database material.
 */
const REVIEWED_SOURCE_PATHS = {
  "apps/backend/test/database.ts":
    "Backend test Layer that provisions private disposable PostgreSQL databases; it holds no data.",
  "tools/verification/credential-race.ts":
    "Credential-race proof driver; callers supply synthetic credentials and it uses reserved example.invalid addresses.",
} as const;

const isReviewedSourcePath = (path: string): path is keyof typeof REVIEWED_SOURCE_PATHS =>
  Object.hasOwn(REVIEWED_SOURCE_PATHS, path);

/** Bun `patchedDependencies` files are named `<package>@<semver>.patch`, which resembles an email address. */
const packagePatchPathPattern =
  /^patches\/[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.patch$/;

/** Returns the review reason for tracked source that is safe despite its path class, or null. */
const reviewedSourcePathReason = (path: string): string | null => {
  const normalized = path.replaceAll("\\", "/");

  if (packagePatchPathPattern.test(normalized))
    return "Dependency patch named by the package manager's `<package>@<version>.patch` convention.";

  return isReviewedSourcePath(normalized) ? REVIEWED_SOURCE_PATHS[normalized] : null;
};

const canonicalKeyTokens = (value: string): readonly string[] => {
  const words = value
    .normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2")
    .replace(/([A-Za-z])([0-9])/gu, "$1_$2")
    .replace(/([0-9])([A-Za-z])/gu, "$1_$2")
    .replace(/[.\-/:]+/gu, "_")
    .split(/[_\s]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  const forms = [...words];

  for (let index = 0; index + 1 < words.length; index += 1) {
    forms.push(`${words[index]}_${words[index + 1]}`);
  }

  return forms;
};

const SENSITIVE_KEY_TOKENS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "passphrase",
  "secret",
  "secrets",
  "token",
  "tokens",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "private_key",
  "api_key",
  "client_secret",
  "database_url",
  "dsn",
  "payload",
  "raw_payload",
  "user_id",
  "account_id",
  "customer_id",
  "member_id",
  "identity_id",
  "email",
  "phone",
]);

const isSensitiveKeyName = (value: string): boolean =>
  canonicalKeyTokens(value).some((token) => SENSITIVE_KEY_TOKENS.has(token));

const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i;

const emailCandidatePattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;

const sourcePhonePattern = /\+[0-9][0-9().\-\s]{6,}[0-9]/;

const knownCredentialTokenPattern =
  /(?:^|[^A-Za-z0-9])(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pous]_[A-Za-z0-9]{8,}|github[_-]?token(?:[_-][A-Za-z0-9]+)+|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+={0,})(?![A-Za-z0-9\-._~+/=])/i;

const credentialAssignmentPattern =
  /(?:^|[\s?&#,/[{])(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*[:=]\s*[^\s,}\]]+/i;

const colonCredentialAssignmentPattern =
  /:(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*=\s*[^\s,}\]]+/i;

/** Blocks path classes that name credential, backup, or database material. */
const isUnsafeSourcePath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);

  if (reviewedSourcePathReason(normalized) !== null) return false;

  if (databaseSourceCodePathPattern.test(normalized)) {
    return unsafePathExtensionPattern.test(basename);
  }

  return unsafePathSegmentPattern.test(normalized) || unsafePathExtensionPattern.test(basename);
};

/** Returns a failure for a path that names sensitive material or embeds a credential or personal data. */
export const sourcePathSafetyReason = (path: string): "UNSAFE_SOURCE" | null => {
  const normalized = path.replaceAll("\\", "/").trim().normalize("NFC");

  if (reviewedSourcePathReason(normalized) !== null) return null;

  return isUnsafeSourcePath(path) ||
    sourcePhonePattern.test(normalized) ||
    knownCredentialTokenPattern.test(normalized) ||
    credentialAssignmentPattern.test(normalized) ||
    colonCredentialAssignmentPattern.test(normalized) ||
    hasUnreservedEmail(normalized)
    ? "UNSAFE_SOURCE"
    : null;
};

const approvedSqlSourceDigests = new Map<string, string>([
  [
    "packages/database/migrations/0005-public-applicant-effect-lifecycle.sql",
    "sha256:3728699013aec802cfa255efe6ffdf80a3801e764b34713512d480a968ebd96f",
  ],
  [
    "packages/database/migrations/0027-native-oauth-provider.sql",
    "sha256:e2047339c68ae6c31a7d04deefadf48082af1ed2c7b95a06af0ad31b90362fde",
  ],
  [
    "packages/database/migrations/0029-native-http-semantics.sql",
    "sha256:42038dac2a5bf15ad1579b4c44e96d257d80057a6cc87abb36765073fb0139f5",
  ],
  [
    "packages/database/migrations/0006-public-applicant-delivered-payload-cleanup.sql",
    "sha256:7b6275c8c90d483d6aae071e2f741508bc79d45e2d2003ea826c9e0b9a9e856a",
  ],
  [
    "packages/database/migrations/0007-public-applicant-activation-snapshot.sql",
    "sha256:427d104599900ac5e6d01ed18121e2b32b9dfc5187c82c0159f9be757db11062",
  ],
  [
    "packages/database/migrations/0048-expense-settlement-evidence.sql",
    "sha256:2d2ec64a021058f98018f79a144577209fdc6afc47b4a2caacd8ed1f67d5a1ef",
  ],
  [
    "packages/database/migrations/0049-native-person-reconciliation.sql",
    "sha256:9d745f36ba78492494862beff82795009360047faa28737f9f3d5a84b428bb47",
  ],
  [
    "packages/database/migrations/0050-reconciled-account-import.sql",
    "sha256:57fef8dcfed7d432357a13be4e001eba521a6ea4de2c5c42c0e239619e2337d7",
  ],
  [
    "packages/database/migrations/0051-reconciled-historical-service-import.sql",
    "sha256:6873dfc22187de74de48a14c1dfafbeda0293a79a41db85712f59b991fa89083",
  ],
  [
    "packages/database/migrations/0052-current-assignment-reconciliation.sql",
    "sha256:54bd164f136ff477e332374f9b80bda36162d7248f8c058b3e2899ec1df25bec",
  ],
  [
    "packages/database/migrations/0059-school-service-person-intervals.sql",
    "sha256:0aed5692b8fd33c5080accdf408eb061ed8a8b4f7a1c4ed6fb4df587874258cd",
  ],
  // Reviewed: the INSERT ... SELECT only backfills accepted mappings from existing rows; no literal data.
  [
    "packages/database/migrations/0065-person-cohort-accepted-mappings.sql",
    "sha256:019627c25f2ac1a6699421e8c4d5bdeaea65454773dbcc3425670d6af4772b72",
  ],
  // Reviewed: the only literals are date_trunc's 'milliseconds' unit and 'UTC' zone; the flagged
  // targets are timestamp columns such as "accessTokenExpiresAt" and secret_expires_at.
  [
    "packages/database/migrations/0072-instant-millisecond-precision.sql",
    "sha256:a852bc336490c1d51df9931b3c7886acf80b521bf21b527410669b9d2d56cd67",
  ],
  // Reviewed: each INSERT ... SELECT backfills coverage records or reservations from existing
  // rows, the UPDATE rewrites a stored identifier prefix, and the trigger inserts NEW's values.
  // The only literals are identifier prefixes, kinds, outcomes, and audit action names.
  [
    "packages/database/migrations/0075-substitute-admission-outcome-coverage-records.sql",
    "sha256:2d0b969239fcd4a93f92cada0e458a95695a7a357f5cffb027662c8a2b98a173",
  ],
]);

const envSourcePathPattern = /(?:^|\/)\.env(?:$|[.-])/i;

const sqlSourcePathPattern = /\.sql$/i;

const textualSourceExtensionPattern =
  /\.(?:php|inc|phtml|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|xml|twig|md|markdown|lock|ini|conf|config|toml|css|scss|graphql|gql|sh|bash|py|rb|go|rs|java|kt|swift|vue|html|htm|txt)$/i;

const envFrameworkPlaceholderPattern =
  /^(?:\$\{[^{}\r\n]+\}|%\w+\([^()\r\n]+\)%|\{\{[^{}\r\n]+\}\}|<[^<>\r\n]+>|__[^_\r\n]+__|env\([^()\r\n]+\)|\$\([^()\r\n]+\))$/;

const envAtPlaceholderPattern = /^@[^@\r\n]+@$/;

const envExplicitSentinel = (path: string, key: string, value: string): boolean => {
  const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
  const normalizedKey = key.trim().toUpperCase();
  const normalizedValue = value.trim().normalize("NFC");

  if (!(normalizedPath === ".env.test" || normalizedPath.endsWith("/.env.test"))) return false;

  return (
    (normalizedKey === "APP_SECRET" && normalizedValue === "test_app_secret_for_testing_only") ||
    (normalizedKey === "DATABASE_URL" && normalizedValue === "sqlite:///:memory:") ||
    (normalizedKey === "GOOGLE_API_CLIENT_ID" && normalizedValue === "test")
  );
};

/** Returns true for paths whose bytes must decode as UTF-8 text. */
export const isTextualSourcePath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);

  return (
    envSourcePathPattern.test(normalized) ||
    sqlSourcePathPattern.test(basename) ||
    textualSourceExtensionPattern.test(basename)
  );
};

const unquoteEnvValue = (value: string): string => {
  const trimmed = value.trim();

  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  )
    return trimmed.slice(1, -1);
  const comment = trimmed.search(/\s+#/u);

  return comment >= 0 ? trimmed.slice(0, comment).trimEnd() : trimmed;
};

type SqlToken = {
  readonly kind: "identifier" | "string" | "operator" | "punctuation";
  readonly value: string;
  readonly depth: number;
};

const SQL_SAFE_LITERAL =
  /^(?:null|default|true|false|current_timestamp|current_date|current_time|test|testing|fixture|dummy|placeholder|example|changeme|change[-_]me|do[-_]not[-_]use|not[-_]a[-_]secret|local(?:host)?|development|dev|0|1|\*)$/iu;

type SqlLexResult = {
  readonly tokens: SqlToken[];
  readonly depth: number;
  readonly malformed: boolean;
};

const sqlNestedBlockCommentOutsideQuotes = (text: string, start: number, end: number): boolean => {
  let index = start;
  let quote: "'" | '"' | "`" | "[" | null = null;

  while (index < end) {
    const character = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (quote !== null) {
      const closing = quote === "[" ? "]" : quote;

      if (character === closing && next === closing) {
        index += 2;
        continue;
      }

      if (character === "\\" && next !== "") {
        index += 2;
        continue;
      }

      if (character === closing) quote = null;
      index += 1;
      continue;
    }

    if (character === "-" && next === "-") {
      index += 2;

      while (index < end && text[index] !== "\n" && text[index] !== "\r") index += 1;
      continue;
    }

    if (character === "#") {
      index += 1;

      while (index < end && text[index] !== "\n" && text[index] !== "\r") index += 1;
      continue;
    }

    if (character === "/" && next === "*") return true;

    if (character === "'" || character === '"' || character === "`" || character === "[")
      quote = character;
    index += 1;
  }

  return false;
};

const sqlTokenize = (text: string): SqlLexResult => {
  const lex = (source: string, initialDepth: number): SqlLexResult => {
    const tokens: SqlToken[] = [];
    let index = 0;
    let depth = initialDepth;
    let malformed = false;

    const push = (kind: SqlToken["kind"], value: string, tokenDepth = depth): void => {
      tokens.push({ kind, value, depth: tokenDepth });
    };

    while (index < source.length) {
      const character = source[index] ?? "";
      const next = source[index + 1] ?? "";

      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }

      if (character === "-" && next === "-") {
        index += 2;

        while (index < source.length && source[index] !== "\n" && source[index] !== "\r")
          index += 1;
        continue;
      }

      if (character === "#") {
        index += 1;

        while (index < source.length && source[index] !== "\n" && source[index] !== "\r")
          index += 1;
        continue;
      }

      if (character === "/" && next === "*") {
        const executable = source[index + 2] === "!";
        const end = source.indexOf("*/", index + 2);

        if (end < 0) {
          malformed = true;
          index = source.length;
          continue;
        }

        if (sqlNestedBlockCommentOutsideQuotes(source, index + 2, end)) malformed = true;

        if (executable) {
          const body = source.slice(index + 3, end).replace(/^\s*\d*/u, "");
          const nested = lex(body, depth);
          tokens.push(...nested.tokens);
          depth = nested.depth;
          malformed ||= nested.malformed;
        }

        index = end + 2;
        continue;
      }

      if (character === "'" || character === '"' || character === "`" || character === "[") {
        const quote = character;
        const closing = quote === "[" ? "]" : quote;
        const kind: SqlToken["kind"] = quote === "'" ? "string" : "identifier";
        let value = "";
        index += 1;

        while (index < source.length) {
          const current = source[index] ?? "";
          const following = source[index + 1] ?? "";

          if (current === closing && following === closing) {
            value += closing;
            index += 2;
            continue;
          }

          if (current === "\\" && following !== "") {
            value += following;
            index += 2;
            continue;
          }

          if (current === closing) {
            index += 1;
            break;
          }

          value += current;
          index += 1;
        }

        push(kind, value);
        continue;
      }

      if (/[A-Za-z_]/u.test(character)) {
        const start = index;
        index += 1;

        while (index < source.length && /[A-Za-z0-9_$-]/u.test(source[index] ?? "")) index += 1;
        push("identifier", source.slice(start, index));
        continue;
      }

      if (/[0-9]/u.test(character)) {
        const start = index;
        index += 1;

        while (index < source.length && /[A-Za-z0-9._+-]/u.test(source[index] ?? "")) index += 1;
        push("identifier", source.slice(start, index));
        continue;
      }

      if (
        (character === "=" ||
          character === ":" ||
          character === ">" ||
          character === "<" ||
          character === "!") &&
        (next === "=" || (character === ":" && next === ":"))
      ) {
        if (character === ":" && next === ":") {
          push("punctuation", "::");
          index += 2;
        } else {
          push("operator", `${character}${next}`);
          index += 2;
        }

        continue;
      }

      if (character === "=" || character === ":") {
        push("operator", character);
        index += 1;
        continue;
      }

      if ("(),.;".includes(character)) {
        push("punctuation", character);

        if (character === "(") depth += 1;

        if (character === ")") depth = Math.max(0, depth - 1);
        index += 1;
        continue;
      }

      push("punctuation", character);
      index += 1;
    }

    return { tokens, depth, malformed };
  };

  return lex(text, 0);
};

const sqlIdentifierName = (token: SqlToken): string | null =>
  token.kind === "identifier"
    ? token.value
        .trim()
        .replace(/([a-z])([A-Z])/gu, "$1_$2")
        .replaceAll("-", "_")
        .toLowerCase()
    : null;

const sqlRhsIsSafe = (tokens: readonly SqlToken[]): boolean => {
  if (tokens.length === 0) return false;

  return tokens.every((token) => {
    if (token.kind === "string") return isAllowedTestValue(token.value, { key: "sql", path: "" });

    if (token.kind === "identifier") return SQL_SAFE_LITERAL.test(token.value);

    return token.kind === "punctuation" && "()[],.".includes(token.value);
  });
};

const sqlTokenIsKeyword = (token: SqlToken | undefined, keyword: string): boolean =>
  token?.kind === "identifier" && token.value.toLowerCase() === keyword;

const sqlPlainEqualsIsProceduralAssignment = (
  tokens: readonly SqlToken[],
  operatorIndex: number,
  statementStart: number,
  depth: number,
): boolean => {
  let targetStart = operatorIndex - 1;
  const target = tokens[targetStart];

  if (target?.kind !== "identifier" || target.depth !== depth) return false;

  while (targetStart - 2 >= statementStart) {
    const separator = tokens[targetStart - 1];
    const qualifier = tokens[targetStart - 2];

    if (
      separator?.value !== "." ||
      separator.depth !== depth ||
      qualifier?.kind !== "identifier" ||
      qualifier.depth !== depth
    )
      break;
    targetStart -= 2;
  }

  if (targetStart === statementStart) return true;
  const boundary = tokens[targetStart - 1];

  return (
    boundary?.kind === "identifier" &&
    boundary.depth === depth &&
    /^(?:begin|else|loop|then)$/iu.test(boundary.value)
  );
};

const sqlEqualsIsAssignment = (tokens: readonly SqlToken[], operatorIndex: number): boolean => {
  const operator = tokens[operatorIndex];

  if (operator?.value !== "=") return false;
  const depth = operator.depth;
  let statementStart = 0;

  for (let index = operatorIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];

    if (token?.value === ";" && token.depth === depth) {
      statementStart = index + 1;
      break;
    }
  }

  let firstKeyword: string | null = null;
  let sawUpdate = false;
  let inSetClause = false;

  for (let index = statementStart; index < operatorIndex; index += 1) {
    const token = tokens[index];

    if (token?.kind !== "identifier" || token.depth !== depth) continue;
    const keyword = token.value.toLowerCase();
    firstKeyword ??= keyword;

    if (keyword === "update") sawUpdate = true;

    if (keyword === "set" && (sawUpdate || firstKeyword === "set")) {
      inSetClause = true;
      continue;
    }

    if (inSetClause && /^(?:from|returning|where)$/u.test(keyword)) inSetClause = false;
  }

  if (inSetClause) return true;

  if (sqlPlainEqualsIsProceduralAssignment(tokens, operatorIndex, statementStart, depth))
    return true;
  const assignmentTarget = tokens[operatorIndex - 1];
  const variableSigil = tokens[operatorIndex - 2];

  return (
    firstKeyword === "select" &&
    assignmentTarget?.kind === "identifier" &&
    assignmentTarget.depth === depth &&
    variableSigil?.value === "@" &&
    variableSigil.depth === depth
  );
};

const sqlSetToHasUnsafeLiteral = (tokens: readonly SqlToken[]): boolean => {
  for (const [setIndex, token] of tokens.entries()) {
    if (!sqlTokenIsKeyword(token, "set")) continue;
    const depth = token.depth;
    let statementStart = 0;

    for (let index = setIndex - 1; index >= 0; index -= 1) {
      const candidate = tokens[index];

      if (candidate?.value === ";" && candidate.depth === depth) {
        statementStart = index + 1;
        break;
      }
    }

    const firstKeyword = tokens
      .slice(statementStart, setIndex + 1)
      .find((candidate) => candidate.kind === "identifier" && candidate.depth === depth);

    if (!sqlTokenIsKeyword(firstKeyword, "set")) continue;

    const statementEnd = tokens.findIndex(
      (candidate, index) =>
        index > setIndex && candidate.value === ";" && candidate.depth === depth,
    );

    const end = statementEnd < 0 ? tokens.length : statementEnd;

    const toIndex = tokens.findIndex(
      (candidate, index) =>
        index > setIndex &&
        index < end &&
        candidate.depth === depth &&
        sqlTokenIsKeyword(candidate, "to"),
    );

    if (toIndex < 0) continue;
    const left = tokens.slice(setIndex + 1, toIndex);

    if (
      !left.some((candidate) => {
        const name = sqlIdentifierName(candidate);

        return name !== null && isSensitiveKeyName(name);
      })
    )
      continue;

    if (!sqlRhsIsSafe(tokens.slice(toIndex + 1, end))) return true;
  }

  return false;
};

const sqlAssignmentHasUnsafeLiteral = (tokens: readonly SqlToken[]): boolean => {
  for (const [index, token] of tokens.entries()) {
    if (
      token.kind !== "operator" ||
      (token.value !== ":=" && !sqlEqualsIsAssignment(tokens, index))
    )
      continue;
    let start = index;

    while (start > 0) {
      const previous = tokens[start - 1];

      if (previous === undefined) break;

      if (
        previous.value === ";" ||
        previous.kind === "operator" ||
        (previous.value === "," && previous.depth === token.depth) ||
        (previous.kind === "identifier" &&
          /^(?:begin|do|else|having|into|loop|returning|select|set|then|where)$/iu.test(
            previous.value,
          ))
      )
        break;
      start -= 1;
    }

    const left = tokens.slice(start, index);

    if (
      !left.some((candidate) => {
        const name = sqlIdentifierName(candidate);

        return name !== null && isSensitiveKeyName(name);
      })
    )
      continue;

    const end = tokens.findIndex(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        (candidate.value === ";" ||
          (candidate.depth === token.depth &&
            (candidate.value === "," ||
              (candidate.kind === "identifier" &&
                /^(?:from|returning|where)$/iu.test(candidate.value))))),
    );

    const right = tokens.slice(index + 1, end < 0 ? tokens.length : end);

    if (!sqlRhsIsSafe(right)) return true;
  }

  return false;
};

const SQL_RECORDSET_COLUMN_TYPES = new Map<string, boolean>([
  ["bigint", true],
  ["boolean", true],
  ["date", true],
  ["integer", true],
  ["json", true],
  ["jsonb", true],
  ["numeric", true],
  ["smallint", true],
  ["text", true],
  ["timestamp", true],
  ["timestamptz", true],
  ["uuid", true],
]);

const sqlInsertSelectRecordsetIsSafe = (
  tokens: readonly SqlToken[],
  insertIndex: number,
): boolean => {
  const insert = tokens[insertIndex];

  if (!sqlTokenIsKeyword(insert, "insert")) return false;
  const statementDepth = insert?.depth ?? 0;
  let statementStart = 0;

  for (let index = insertIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];

    if (token?.value === ";" && token.depth === statementDepth) {
      statementStart = index + 1;
      break;
    }
  }

  if (statementStart !== insertIndex) return false;
  let statementEnd = tokens.length;

  for (let index = insertIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token?.value === ";" && token.depth === statementDepth) {
      statementEnd = index;
      break;
    }
  }

  for (let index = statementStart; index < statementEnd; index += 1) {
    if (tokens[index]?.kind === "string") return false;
  }

  let cursor = insertIndex;

  const takeKeyword = (keyword: string): boolean => {
    if (!sqlTokenIsKeyword(tokens[cursor], keyword)) return false;
    cursor += 1;

    return true;
  };

  const takePunctuation = (value: string): boolean => {
    const token = tokens[cursor];

    if (token?.kind !== "punctuation" || token.value !== value) return false;
    cursor += 1;

    return true;
  };

  const takeIdentifier = (): string | null => {
    const token = tokens[cursor];

    if (token === undefined) return null;
    const name = sqlIdentifierName(token);

    if (name === null) return null;
    cursor += 1;

    return name;
  };

  if (!takeKeyword("insert") || !takeKeyword("into") || takeIdentifier() === null) return false;

  while (takePunctuation(".")) {
    if (takeIdentifier() === null) return false;
  }

  if (!takePunctuation("(")) return false;
  const insertColumns: string[] = [];

  for (;;) {
    const column = takeIdentifier();

    if (column === null) return false;
    insertColumns.push(column);

    if (takePunctuation(")")) break;

    if (!takePunctuation(",")) return false;
  }

  if (!takeKeyword("select")) return false;
  const projectionAliases: string[] = [];
  const projectionColumns: string[] = [];

  for (;;) {
    const alias = takeIdentifier();

    if (alias === null || !takePunctuation(".")) return false;
    const column = takeIdentifier();

    if (column === null) return false;
    projectionAliases.push(alias);
    projectionColumns.push(column);

    if (!takePunctuation(",")) break;
  }

  if (
    !takeKeyword("from") ||
    !takeKeyword("jsonb_to_recordset") ||
    !takePunctuation("(") ||
    !takePunctuation("$")
  )
    return false;
  const parameter = tokens[cursor];

  if (parameter?.kind !== "identifier" || !/^[1-9][0-9]*$/u.test(parameter.value)) return false;
  cursor += 1;

  if (
    !takePunctuation("::") ||
    !takeKeyword("jsonb") ||
    !takePunctuation(")") ||
    !takeKeyword("as")
  )
    return false;
  const recordsetAlias = takeIdentifier();

  if (recordsetAlias === null || !takePunctuation("(")) return false;
  const recordsetColumns: string[] = [];

  for (;;) {
    const column = takeIdentifier();
    const type = takeIdentifier();

    if (column === null || type === null || SQL_RECORDSET_COLUMN_TYPES.get(type) !== true)
      return false;
    recordsetColumns.push(column);

    if (takePunctuation(")")) break;

    if (!takePunctuation(",")) return false;
  }

  if (takeKeyword("where") && !takeKeyword("true")) return false;
  let conflictColumn: string | null = null;

  if (takeKeyword("on")) {
    if (!takeKeyword("conflict") || !takePunctuation("(")) return false;
    conflictColumn = takeIdentifier();

    if (
      conflictColumn === null ||
      !takePunctuation(")") ||
      !takeKeyword("do") ||
      !takeKeyword("nothing")
    )
      return false;
  }

  if (cursor !== statementEnd || insertColumns.length !== recordsetColumns.length) return false;

  if (projectionColumns.length !== insertColumns.length) return false;

  if (
    projectionAliases.some((alias) => alias !== recordsetAlias) ||
    projectionColumns.some((column, index) => column !== insertColumns[index]) ||
    recordsetColumns.some((column, index) => column !== insertColumns[index])
  )
    return false;

  return conflictColumn === null || insertColumns.includes(conflictColumn);
};

const isAllowedTestValue = (
  value: string,
  context?: { readonly path?: string; readonly key?: string },
): boolean => {
  const normalized = value.trim().normalize("NFC");

  if (normalized.length === 0) return true;

  if (context?.key !== undefined && isSensitiveKeyName(context.key))
    return context.path !== undefined && envExplicitSentinel(context.path, context.key, normalized);

  if (envFrameworkPlaceholderPattern.test(normalized)) return true;

  return (
    context?.path !== undefined &&
    context.key !== undefined &&
    envExplicitSentinel(context.path, context.key, normalized)
  );
};

/** Returns a sanitized failure for concrete sensitive values in dotenv assignments. */
export const unsafeEnvSourceTextReason = (text: string, path = ""): "UNSAFE_SOURCE" | null => {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/u);

    if (match === null) continue;
    const key = match[1] ?? "";
    const value = unquoteEnvValue(match[2] ?? "");
    const allowed = isAllowedTestValue(value, { path, key });

    if (envAtPlaceholderPattern.test(value)) return "UNSAFE_SOURCE";

    if (knownCredentialTokenPattern.test(value)) return "UNSAFE_SOURCE";

    if (isSensitiveKeyName(key) && !allowed) return "UNSAFE_SOURCE";

    if (hasUnreservedEmail(value)) return "UNSAFE_SOURCE";

    if (sourcePhonePattern.test(value)) return "UNSAFE_SOURCE";
  }

  return null;
};

/** Returns a sanitized failure for literal data or sensitive values in SQL source. */
export const unsafeSqlSourceTextReason = (text: string): "UNSAFE_SOURCE" | null => {
  if (knownCredentialTokenPattern.test(text) || hasUnreservedEmail(text)) return "UNSAFE_SOURCE";
  const lexed = sqlTokenize(text);

  if (lexed.malformed) return "UNSAFE_SOURCE";
  const tokens = lexed.tokens;

  if (sqlAssignmentHasUnsafeLiteral(tokens) || sqlSetToHasUnsafeLiteral(tokens))
    return "UNSAFE_SOURCE";

  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (
      sqlTokenIsKeyword(tokens[index], "insert") &&
      sqlTokenIsKeyword(tokens[index + 1], "into") &&
      !sqlInsertSelectRecordsetIsSafe(tokens, index)
    )
      return "UNSAFE_SOURCE";
  }

  for (const token of tokens) {
    if (knownCredentialTokenPattern.test(token.value) || hasUnreservedEmail(token.value))
      return "UNSAFE_SOURCE";

    if (sourcePhonePattern.test(token.value)) return "UNSAFE_SOURCE";
  }

  return null;
};

/** Validates the bytes of a textual source file. */
export const sourceTextSafetyReason = (
  path: string,
  value: Uint8Array,
): SourceSafetyReason | null => {
  if (!isTextualSourcePath(path)) return null;
  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return "INVALID_UTF8";
  }

  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);

  if (envSourcePathPattern.test(normalized) && unsafeEnvSourceTextReason(text, path) !== null)
    return "UNSAFE_SOURCE";

  if (
    sqlSourcePathPattern.test(basename) &&
    approvedSqlSourceDigests.get(normalized) !==
      `sha256:${createHash("sha256").update(value).digest("hex")}` &&
    unsafeSqlSourceTextReason(text) !== null
  )
    return "UNSAFE_SOURCE";

  return null;
};

/** Reserved example and test domains are fixture addresses, not personal data. */
const hasUnreservedEmail = (text: string): boolean =>
  (text.match(emailCandidatePattern) ?? []).some((candidate) => {
    const domain = (candidate.match(emailPattern)?.[1] ?? "").toLowerCase();

    return !(
      domain === "example.com" ||
      domain === "example.org" ||
      domain === "example.net" ||
      domain === "localhost" ||
      domain.endsWith(".invalid") ||
      domain.endsWith(".test")
    );
  });
