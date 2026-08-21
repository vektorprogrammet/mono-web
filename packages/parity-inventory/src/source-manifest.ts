import { canonicalJson, compareByteOrder, sha256, stableId } from "./canonical.js";
import type {
  AuthorityLine,
  CensusRoot,
  IgnoreRule,
  RevisionRecord,
  RootCensusRecord,
  RuntimeObservation,
  SourceManifest,
  SourceRecord,
} from "./types.js";

export interface SourceFamily {
  readonly family_id: string;
  readonly authority_line: "legacy" | "mono";
  readonly authority_role: string;
  readonly patterns: readonly string[];
  readonly empty_allowed: boolean;
}

const RATIONALE = {
  repository_metadata: "Git administrative bytes are not application declarations.",
  dependency_cache: "Nested JavaScript dependency bytes are not first-party declarations.",
  vendor_cache: "Nested third-party dependency bytes are not first-party declarations.",
  generated_output: "Distribution output is derived and is not a declaration authority.",
  build_output: "Build output is derived and is not a declaration authority.",
  turbo_cache: "Turbo cache bytes are generated build state.",
  tool_cache: "Tool cache bytes are generated build state.",
  legacy_application_cache: "Legacy application cache is generated execution state.",
  legacy_root_cache: "Legacy root cache is generated execution state.",
  legacy_var_cache: "Legacy var cache is generated execution state.",
  legacy_var_data: "Legacy var data is generated runtime state.",
  mono_server_runtime: "Server runtime state is generated execution data.",
  legacy_application_logs: "Legacy application logs are execution evidence.",
  legacy_root_logs: "Legacy root logs are execution evidence.",
  legacy_var_logs: "Legacy var logs are execution evidence.",
  legacy_nested_debug_logs: "Nested npm debug logs are execution evidence.",
  test_support: "Coverage output is test evidence, not parity authority.",
  binary_tool: "Bundled Composer is an executable tool, not a source declaration.",
} as const;

type RuleSpec = Omit<IgnoreRule, "ignore_rule_id" | "authority_line"> & {
  readonly rule_kind: IgnoreRule["rule_kind"];
};

const LEGACY_RULES: readonly RuleSpec[] = [
  {
    root_ref: "legacy",
    precedence: 10,
    pattern: "**/.git/**",
    selection: "ordered_set_difference",
    rule_kind: "repository_metadata",
    rationale: RATIONALE.repository_metadata,
  },
  {
    root_ref: "legacy",
    precedence: 20,
    pattern: "**/node_modules/**",
    selection: "ordered_set_difference",
    rule_kind: "dependency_cache",
    rationale: RATIONALE.dependency_cache,
  },
  {
    root_ref: "legacy",
    precedence: 21,
    pattern: "**/vendor/**",
    selection: "ordered_set_difference",
    rule_kind: "dependency_cache",
    rationale: RATIONALE.vendor_cache,
  },
  {
    root_ref: "legacy",
    precedence: 30,
    pattern: "**/dist/**",
    selection: "ordered_set_difference",
    rule_kind: "generated_output",
    rationale: RATIONALE.generated_output,
  },
  {
    root_ref: "legacy",
    precedence: 31,
    pattern: "**/build/**",
    selection: "ordered_set_difference",
    rule_kind: "generated_output",
    rationale: RATIONALE.build_output,
  },
  {
    root_ref: "legacy",
    precedence: 40,
    pattern: "**/.turbo/**",
    selection: "ordered_set_difference",
    rule_kind: "build_cache",
    rationale: RATIONALE.turbo_cache,
  },
  {
    root_ref: "legacy",
    precedence: 41,
    pattern: "**/.cache/**",
    selection: "ordered_set_difference",
    rule_kind: "build_cache",
    rationale: RATIONALE.tool_cache,
  },
  {
    root_ref: "legacy",
    precedence: 50,
    pattern: "app/cache/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_cache",
    rationale: RATIONALE.legacy_application_cache,
  },
  {
    root_ref: "legacy",
    precedence: 51,
    pattern: "cache/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_cache",
    rationale: RATIONALE.legacy_root_cache,
  },
  {
    root_ref: "legacy",
    precedence: 52,
    pattern: "var/cache/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_cache",
    rationale: RATIONALE.legacy_var_cache,
  },
  {
    root_ref: "legacy",
    precedence: 53,
    pattern: "var/data/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_cache",
    rationale: RATIONALE.legacy_var_data,
  },
  {
    root_ref: "legacy",
    precedence: 60,
    pattern: "app/logs/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_log",
    rationale: RATIONALE.legacy_application_logs,
  },
  {
    root_ref: "legacy",
    precedence: 61,
    pattern: "logs/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_log",
    rationale: RATIONALE.legacy_root_logs,
  },
  {
    root_ref: "legacy",
    precedence: 62,
    pattern: "var/logs/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_log",
    rationale: RATIONALE.legacy_var_logs,
  },
  {
    root_ref: "legacy",
    precedence: 63,
    pattern: "**/npm-debug.log",
    selection: "ordered_set_difference",
    rule_kind: "runtime_log",
    rationale: RATIONALE.legacy_nested_debug_logs,
  },
  {
    root_ref: "legacy",
    precedence: 70,
    pattern: "**/coverage/**",
    selection: "ordered_set_difference",
    rule_kind: "test_support",
    rationale: RATIONALE.test_support,
  },
  {
    root_ref: "legacy",
    precedence: 80,
    pattern: "composer.phar",
    selection: "ordered_set_difference",
    rule_kind: "binary_tool",
    rationale: RATIONALE.binary_tool,
  },
];

const MONO_RULES: readonly RuleSpec[] = [
  {
    root_ref: "mono",
    precedence: 10,
    pattern: "**/.git/**",
    selection: "ordered_set_difference",
    rule_kind: "repository_metadata",
    rationale: RATIONALE.repository_metadata,
  },
  {
    root_ref: "mono",
    precedence: 20,
    pattern: "**/node_modules/**",
    selection: "ordered_set_difference",
    rule_kind: "dependency_cache",
    rationale: RATIONALE.dependency_cache,
  },
  {
    root_ref: "mono",
    precedence: 21,
    pattern: "**/vendor/**",
    selection: "ordered_set_difference",
    rule_kind: "dependency_cache",
    rationale: RATIONALE.vendor_cache,
  },
  {
    root_ref: "mono",
    precedence: 30,
    pattern: "**/dist/**",
    selection: "ordered_set_difference",
    rule_kind: "generated_output",
    rationale: RATIONALE.generated_output,
  },
  {
    root_ref: "mono",
    precedence: 31,
    pattern: "**/build/**",
    selection: "ordered_set_difference",
    rule_kind: "generated_output",
    rationale: RATIONALE.build_output,
  },
  {
    root_ref: "mono",
    precedence: 40,
    pattern: "**/.turbo/**",
    selection: "ordered_set_difference",
    rule_kind: "build_cache",
    rationale: RATIONALE.turbo_cache,
  },
  {
    root_ref: "mono",
    precedence: 41,
    pattern: "**/.cache/**",
    selection: "ordered_set_difference",
    rule_kind: "build_cache",
    rationale: RATIONALE.tool_cache,
  },
  {
    root_ref: "mono",
    precedence: 53,
    pattern: "apps/server/var/**",
    selection: "ordered_set_difference",
    rule_kind: "runtime_cache",
    rationale: RATIONALE.mono_server_runtime,
  },
  {
    root_ref: "mono",
    precedence: 70,
    pattern: "**/coverage/**",
    selection: "ordered_set_difference",
    rule_kind: "test_support",
    rationale: RATIONALE.test_support,
  },
];

export const IGNORE_RULES: readonly IgnoreRule[] = [
  ...LEGACY_RULES.map((rule) => makeIgnoreRule("legacy", rule)),
  ...MONO_RULES.map((rule) => makeIgnoreRule("mono", rule)),
];

const routeLegacyPatterns = [
  "app/config/routing.yml",
  "app/config/routing_api.yml",
  "app/config/routing_dev.yml",
  "app/config/routing*.yml",
  "src/AppBundle/**/Controller/**/*.php",
] as const;

const routeMonoPatterns = [
  "apps/server/config/routes.yaml",
  "apps/server/src/App/**/Controller/**/*.php",
] as const;

export const SOURCE_FAMILIES: readonly SourceFamily[] = [
  {
    family_id: "legacy_routes",
    authority_line: "legacy",
    authority_role: "legacy_route_authority",
    patterns: routeLegacyPatterns,
    empty_allowed: false,
  },
  {
    family_id: "legacy_api_resources",
    authority_line: "legacy",
    authority_role: "legacy_api_resource_authority",
    patterns: [
      "src/AppBundle/**/Controller/Api/**/*.php",
      "src/AppBundle/**/Entity/**/*.php",
      "src/AppBundle/**/Form/**/*.php",
    ],
    empty_allowed: false,
  },
  {
    family_id: "legacy_commands_writes",
    authority_line: "legacy",
    authority_role: "legacy_command_write_authority",
    patterns: [
      "src/AppBundle/**/Command/**/*.php",
      "src/AppBundle/**/Controller/**/*.php",
      "src/AppBundle/**/Service/**/*.php",
      "src/AppBundle/**/Entity/**/*.php",
      "src/AppBundle/**/Event/**/*.php",
      "src/AppBundle/**/EventSubscriber/**/*.php",
      "src/AppBundle/**/Repository/**/*.php",
      "app/config/services*.yml",
      "app/config/config*.yml",
      "app/config/routing*.yml",
    ],
    empty_allowed: false,
  },
  {
    family_id: "legacy_schedules",
    authority_line: "legacy",
    authority_role: "legacy_schedule_authority",
    patterns: [
      "app/config/**/*.yml",
      "app/config/**/*.yaml",
      "src/AppBundle/**/Command/**/*.php",
      "src/AppBundle/**/EventSubscriber/**/*.php",
      ".github/workflows/**/*.yml",
      ".github/workflows/**/*.yaml",
    ],
    empty_allowed: true,
  },
  {
    family_id: "legacy_integrations",
    authority_line: "legacy",
    authority_role: "legacy_integration_authority",
    patterns: [
      "src/AppBundle/**/Google/**/*.php",
      "src/AppBundle/**/Slack/**/*.php",
      "src/AppBundle/**/Sms/**/*.php",
      "src/AppBundle/**/Mailer/**/*.php",
      "src/AppBundle/**/Service/**/*.php",
      "src/AppBundle/**/Controller/**/*.php",
      "app/config/services*.yml",
    ],
    empty_allowed: false,
  },
  {
    family_id: "legacy_journeys",
    authority_line: "legacy",
    authority_role: "legacy_journey_reference",
    patterns: ["docs/**/*.md", "design-specs/**/*.md"],
    empty_allowed: true,
  },
  {
    family_id: "mono_routes",
    authority_line: "mono",
    authority_role: "mono_route_authority",
    patterns: routeMonoPatterns,
    empty_allowed: false,
  },
  {
    family_id: "mono_api_resources",
    authority_line: "mono",
    authority_role: "mono_api_resource_authority",
    patterns: [
      "apps/server/src/App/**/Api/Resource/**/*.php",
      "apps/server/src/App/**/Api/State/**/*.php",
      "apps/server/src/App/**/Infrastructure/Entity/**/*.php",
    ],
    empty_allowed: false,
  },
  {
    family_id: "mono_commands_writes",
    authority_line: "mono",
    authority_role: "mono_command_write_authority",
    patterns: [
      "apps/server/src/App/**/Infrastructure/Command/**/*.php",
      "apps/server/src/App/**/Controller/**/*.php",
      "apps/server/src/App/**/Infrastructure/Repository/**/*.php",
      "apps/server/src/App/**/Infrastructure/AccessControlService.php",
      "apps/server/src/App/**/Infrastructure/AdmissionNotifier.php",
      "apps/server/src/App/**/Infrastructure/ApplicationAdmission.php",
      "apps/server/src/App/**/Infrastructure/ApplicationData.php",
      "apps/server/src/App/**/Infrastructure/ApplicationManager.php",
      "apps/server/src/App/**/Infrastructure/AssistantHistoryData.php",
      "apps/server/src/App/**/Infrastructure/BetaRedirecter.php",
      "apps/server/src/App/**/Infrastructure/CompanyEmailMaker.php",
      "apps/server/src/App/**/Infrastructure/ContentModeManager.php",
      "apps/server/src/App/**/Infrastructure/EmailSender.php",
      "apps/server/src/App/**/Infrastructure/FileUploader.php",
      "apps/server/src/App/**/Infrastructure/GeoLocation.php",
      "apps/server/src/App/**/Infrastructure/InterviewManager.php",
      "apps/server/src/App/**/Infrastructure/InterviewNotificationManager.php",
      "apps/server/src/App/**/Infrastructure/LogService.php",
      "apps/server/src/App/**/Infrastructure/LoginManager.php",
      "apps/server/src/App/**/Infrastructure/PasswordManager.php",
      "apps/server/src/App/**/Infrastructure/RoleManager.php",
      "apps/server/src/App/**/Infrastructure/SbsData.php",
      "apps/server/src/App/**/Infrastructure/Slack/SlackMessenger.php",
      "apps/server/src/App/**/Infrastructure/Slack/SlackMailer.php",
      "apps/server/src/App/**/Infrastructure/SurveyManager.php",
      "apps/server/src/App/**/Infrastructure/SurveyNotifier.php",
      "apps/server/src/App/**/Infrastructure/TeamMembershipService.php",
      "apps/server/src/App/**/Infrastructure/UserGroupCollectionManager.php",
      "apps/server/src/App/**/Infrastructure/UserRegistration.php",
      "apps/server/src/App/**/Infrastructure/UserService.php",
      "apps/server/src/App/**/Infrastructure/Subscriber/**/*.php",
      "apps/server/src/App/**/Event/**/*.php",
      "apps/server/src/App/**/EventSubscriber/**/*.php",
      "apps/server/config/services*.yaml",
      "apps/server/config/packages/*.yaml",
      "apps/server/config/routes*.yaml",
      "apps/server/config/routes/**/*.yaml",
    ],
    empty_allowed: false,
  },
  {
    family_id: "mono_schedules",
    authority_line: "mono",
    authority_role: "mono_schedule_authority",
    patterns: [
      ".github/workflows/**/*.yml",
      ".github/workflows/**/*.yaml",
      "infra/**/*.ts",
      "infra/**/*.tsx",
      "infra/**/*.js",
      "infra/**/*.mjs",
      "infra/**/*.yml",
      "infra/**/*.yaml",
      "apps/server/config/**/*.yaml",
      "apps/server/src/App/**/Infrastructure/Command/**/*.php",
      "apps/server/src/App/**/EventSubscriber/**/*.php",
    ],
    empty_allowed: true,
  },
  {
    family_id: "mono_integrations",
    authority_line: "mono",
    authority_role: "mono_integration_authority",
    patterns: [
      "apps/server/src/App/**/Infrastructure/**/*.php",
      "apps/server/src/App/**/Support/**/*.php",
      "apps/server/src/App/**/Controller/**/*.php",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/*.js",
      ".github/workflows/**/*.yml",
      ".github/workflows/**/*.yaml",
      "infra/**/*.ts",
      "infra/**/*.tsx",
      "infra/**/*.js",
      "infra/**/*.mjs",
    ],
    empty_allowed: false,
  },
  {
    family_id: "mono_journeys",
    authority_line: "mono",
    authority_role: "mono_journey_reference",
    patterns: [
      "docs/**/*.md",
      "design-specs/**/*.md",
      "apps/**/routes/**/*.tsx",
      "apps/**/routes/**/*.ts",
    ],
    empty_allowed: false,
  },
  {
    family_id: "mono_h3",
    authority_line: "mono",
    authority_role: "mono_h3_derivation",
    patterns: [
      "apps/server/tools/security-h3/0015/generate.ts",
      "apps/server/tools/security-h3/0015/generate.test.ts",
      "apps/server/tools/security-h3/0015/reason-codes.json",
      "apps/server/tools/security-h3/0015/schema.json",
      "apps/server/tools/security-h3/0015/fixtures/**/*.json",
      "evidence/security-h3/0015/current-route-inventory.json",
      "evidence/security-h3/0015/current-resource-inventory.json",
      "evidence/security-h3/0015/source-manifest.json",
      "evidence/security-h3/0015/route-collector.json",
      "evidence/security-h3/0015/decision-packet.json",
    ],
    empty_allowed: false,
  },
];

export interface ScanFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: Uint8Array | null;
  readonly byteLength: number | null;
  readonly digest: string | null;
  readonly availability: "available" | "unavailable";
  readonly unsafe: boolean;
}

export interface RootScanSnapshot {
  readonly rootRef: "legacy" | "mono";
  readonly authorityLine: "legacy" | "mono";
  readonly rootPath: string;
  readonly files: readonly ScanFile[];
  readonly revision: RevisionRecord;
  readonly revisionRefId: string;
}

export interface ManifestContext {
  readonly scans: Readonly<Record<"legacy" | "mono", RootScanSnapshot>>;
  readonly sources: SourceRecord[];
  readonly rootCensus: RootCensusRecord[];
  readonly censusRoots: CensusRoot[];
  readonly revisions: RevisionRecord[];
  readonly runtimeObservations: RuntimeObservation[];
  readonly ignoreRules: readonly IgnoreRule[];
  readonly sourceByKey: Map<string, string>;
  readonly sourcePathById: Map<
    string,
    { readonly rootRef: "legacy" | "mono"; readonly path: string }
  >;
}

function makeIgnoreRule(authorityLine: "legacy" | "mono", spec: RuleSpec): IgnoreRule {
  const identity = {
    authority_line: authorityLine,
    root_ref: spec.root_ref,
    precedence: spec.precedence,
    pattern: spec.pattern,
    selection: spec.selection,
    rule_kind: spec.rule_kind,
    rationale: spec.rationale,
  };
  return { ignore_rule_id: stableId("ignore", identity), authority_line: authorityLine, ...spec };
}

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export const literalPatternRegex = (pattern: string): RegExp => {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) continue;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        regex += "(?:.*/)?";
        index += 2;
      } else {
        regex += ".*";
        index += 1;
      }
    } else if (char === "*") {
      regex += "[^/]*";
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += escapeRegex(char);
    }
  }
  return new RegExp(`${regex}$`);
};

export const matchesLiteralPattern = (path: string, pattern: string): boolean =>
  literalPatternRegex(pattern).test(path);
const unsafePathSegmentPattern =
  /(?:^|\/)(?:credentials?(?:$|[._-]|\/)|secrets?(?:$|[._-]|\/)|private[-_]?keys?(?:$|[._-]|\/)|(?:raw[-_]?payloads?|payloads?|backups?|dumps?|databases?|database|db)(?:$|[._-]|\/))/i;
const unsafePathExtensionPattern =
  /\.(?:pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db|dump|bak|backup)$/i;
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
const isIdentityFieldName = (value: string): boolean =>
  canonicalKeyTokens(value).some((token) =>
    ["user_id", "account_id", "customer_id", "member_id", "identity_id"].includes(token),
  );
const identityFieldPattern = /^(?:user|account|customer|member|identity)[_-]?id(?:s)?$/i;
const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i;
const phonePattern = /\+?[0-9][0-9().\-\s]{6,}[0-9]/;
const sourcePhonePattern = /\+[0-9][0-9().\-\s]{6,}[0-9]/;
const knownCredentialTokenPattern =
  /(?:^|[^A-Za-z0-9])(?:sk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pous]_[A-Za-z0-9]{8,}|github[_-]?token(?:[_-][A-Za-z0-9]+)+|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+={0,})(?![A-Za-z0-9\-._~+/=])/i;
const credentialAssignmentPattern =
  /(?:^|[\s?&#,/[{])(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*[:=]\s*[^\s,}\]]+/i;
const colonCredentialAssignmentPattern =
  /:(?:password|passwd|secret|secrets|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)\s*=\s*[^\s,}\]]+/i;
const streamSensitiveAssignmentPattern =
  /(?:^|[\s"'`([{,])["'`]?([A-Za-z_][A-Za-z0-9_.:/-]*)["'`]?\s*[:=]/giu;
/** Returns true only for source path classes that must be blocked before hashing. */
export const isUnsafeSourcePath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return unsafePathSegmentPattern.test(normalized) || unsafePathExtensionPattern.test(basename);
};
const envSourcePathPattern = /(?:^|\/)\.env(?:$|[.-])/i;
const sqlSourcePathPattern = /\.sql$/i;
const textualSourceExtensionPattern =
  /\.(?:php|inc|phtml|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|xml|twig|md|markdown|lock|ini|conf|config|toml|css|scss|graphql|gql|sh|bash|py|rb|go|rs|java|kt|swift|vue|html|htm|txt)$/i;
const sensitiveEnvKeyPattern = { test: isSensitiveKeyName };
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
    (normalizedKey === "DATABASE_URL" && normalizedValue === "sqlite:///:memory:")
  );
};


/** Returns true for source paths whose bytes must be decoded before hashing. */
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
const STREAM_LEAF_KEYS = new Set(["example", "examples", "default", "defaults", "value", "values"]);
const STREAM_SAFE_LITERAL = /^(?:null|default|true|false|current_timestamp|current_date|current_time|test|testing|fixture|dummy|placeholder|example|changeme|change[-_]me|do[-_]not[-_]use|not[-_]a[-_]secret|local(?:host)?|development|dev|0|1|\*)$/iu;
const streamScalarIsSafe = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().normalize("NFC");
  return normalized.length === 0 || STREAM_SAFE_LITERAL.test(normalized) || envFrameworkPlaceholderPattern.test(normalized);
};
const streamFieldIsLeaf = (value: string): boolean =>
  canonicalKeyTokens(value).some((token) => STREAM_LEAF_KEYS.has(token));
const SQL_SAFE_LITERAL = /^(?:null|default|true|false|current_timestamp|current_date|current_time|test|testing|fixture|dummy|placeholder|example|changeme|change[-_]me|do[-_]not[-_]use|not[-_]a[-_]secret|local(?:host)?|development|dev|0|1|\*)$/iu;
type SqlLexResult = {
  readonly tokens: SqlToken[];
  readonly depth: number;
  readonly malformed: boolean;
};
const sqlNestedBlockCommentOutsideQuotes = (text: string, start: number, end: number): boolean => {
  let index = start;
  let quote: "'" | "\"" | "`" | "[" | null = null;
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
    if (character === "'" || character === "\"" || character === "`" || character === "[") quote = character;
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
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      if (character === "#") {
        index += 1;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
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
      if (character === "'" || character === "\"" || character === "`" || character === "[") {
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
      if ((character === "=" || character === ":" || character === ">" || character === "<" || character === "!") && (next === "=" || (character === ":" && next === ":"))) {
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
  token.kind === "identifier" ? token.value.trim().replace(/([a-z])([A-Z])/gu, "$1_$2").replaceAll("-", "_").toLowerCase() : null;
const sqlRhsIsSafe = (tokens: readonly SqlToken[]): boolean => {
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    if (token.kind === "string") return isAllowedTestValue(token.value, { key: "sql", path: "" });
    if (token.kind === "identifier") return SQL_SAFE_LITERAL.test(token.value);
    return token.kind === "punctuation" && "()[],.".includes(token.value);
  });
};
const sqlAssignmentHasUnsafeLiteral = (tokens: readonly SqlToken[]): boolean => {
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "operator" || !["=", ":", ":="].includes(token.value)) continue;
    let start = index;
    while (start > 0) {
      const previous = tokens[start - 1];
      if (previous === undefined) break;
      if (previous.value === ";" || (previous.value === "," && previous.depth === token.depth) || (previous.kind === "identifier" && /^(?:set|where|having)$/iu.test(previous.value))) break;
      start -= 1;
    }
    const left = tokens.slice(start, index);
    if (!left.some((candidate) => {
      const name = sqlIdentifierName(candidate);
      return name !== null && isSensitiveKeyName(name);
    })) continue;
    const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && (candidate.value === ";" || (candidate.value === "," && candidate.depth === token.depth)));
    const right = tokens.slice(index + 1, end < 0 ? tokens.length : end);
    if (!sqlRhsIsSafe(right)) return true;
  }
  return false;
};
const structuredValueHasUnsafeSensitiveValue = (
  value: unknown,
  sensitiveAncestor = false,
  fieldName = "",
): boolean => {
  if (Array.isArray(value))
    return value.some((entry) => structuredValueHasUnsafeSensitiveValue(entry, sensitiveAncestor, fieldName));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
      structuredValueHasUnsafeSensitiveValue(child, sensitiveAncestor || isSensitiveKeyName(key), key),
    );
  }
  if (!sensitiveAncestor) return typeof value === "string" && unsafeScalarReason(value, fieldName) !== null;
  if (isSensitiveKeyName(fieldName))
    return typeof value === "string"
      ? unsafeScalarReason(value, fieldName) !== null
      : value !== null && value !== undefined;
  if (streamFieldIsLeaf(fieldName) || typeof value === "string") return !streamScalarIsSafe(value);
  return value !== null && value !== undefined;
};
export const unsafeStructuredValueReason = (value: unknown): "UNSAFE_SOURCE" | null =>
  structuredValueHasUnsafeSensitiveValue(value) ? "UNSAFE_SOURCE" : null;
const malformedStreamHasSensitiveAssignment = (text: string): boolean => {
  for (const match of text.matchAll(streamSensitiveAssignmentPattern)) {
    if (isSensitiveKeyName(match[1] ?? "")) return true;
  }
  return false;
};
const jsonStreamHasSensitiveKey = (text: string): boolean => {
  try {
    return unsafeStructuredValueReason(JSON.parse(text) as unknown) !== null;
  } catch {
    return malformedStreamHasSensitiveAssignment(text);
  }
};

const isAllowedTestValue = (value: string, context?: { readonly path?: string; readonly key?: string }): boolean => {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) return true;
  if (context?.key !== undefined && sensitiveEnvKeyPattern.test(context.key))
    return context.path !== undefined && envExplicitSentinel(context.path, context.key, normalized);
  if (envFrameworkPlaceholderPattern.test(normalized)) return true;
  return context?.path !== undefined && context.key !== undefined && envExplicitSentinel(context.path, context.key, normalized);
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
    if (sensitiveEnvKeyPattern.test(key) && !allowed) return "UNSAFE_SOURCE";
    const emails = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
    if (
      emails.some((candidate) => {
        const emailMatch = candidate.match(emailPattern);
        return emailMatch !== null && !isReservedEmail(candidate, emailMatch);
      })
    )
      return "UNSAFE_SOURCE";
    if (sourcePhonePattern.test(value)) return "UNSAFE_SOURCE";
  }
  return null;
};

/** Returns a sanitized failure for literal data or sensitive values in SQL source. */
export const unsafeSqlSourceTextReason = (text: string, _path = ""): "UNSAFE_SOURCE" | null => {
  if (knownCredentialTokenPattern.test(text)) return "UNSAFE_SOURCE";
  const emailsInSource = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
  if (
    emailsInSource.some((candidate) => {
      const emailMatch = candidate.match(emailPattern);
      return emailMatch !== null && !isReservedEmail(candidate, emailMatch);
    })
  )
    return "UNSAFE_SOURCE";
  const lexed = sqlTokenize(text);
  if (lexed.malformed) return "UNSAFE_SOURCE";
  const tokens = lexed.tokens;
  if (sqlAssignmentHasUnsafeLiteral(tokens)) return "UNSAFE_SOURCE";
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index]?.kind === "identifier" && /^insert$/iu.test(tokens[index]?.value ?? "") && tokens[index + 1]?.kind === "identifier" && /^into$/iu.test(tokens[index + 1]?.value ?? "")) return "UNSAFE_SOURCE";
  }
  for (const token of tokens) {
    if (knownCredentialTokenPattern.test(token.value)) return "UNSAFE_SOURCE";
    const emails = token.value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? [];
    if (
      emails.some((candidate) => {
        const emailMatch = candidate.match(emailPattern);
        return emailMatch !== null && !isReservedEmail(candidate, emailMatch);
      })
    )
      return "UNSAFE_SOURCE";
    if (sourcePhonePattern.test(token.value)) return "UNSAFE_SOURCE";
  }
  return null;
};
/** Validates textual source bytes before any source digest or ID is created. */
export const sourceTextSafetyReason = (
  path: string,
  value: Uint8Array,
): "INVALID_UTF8" | "UNSAFE_SOURCE" | null => {
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
  if (sqlSourcePathPattern.test(basename) && unsafeSqlSourceTextReason(text, path) !== null)
    return "UNSAFE_SOURCE";
  return null;
};

const isReservedEmail = (_value: string, match: RegExpMatchArray): boolean => {
  const domain = (match[1] ?? "").toLowerCase();
  return (
    domain === "example.com" ||
    domain === "example.org" ||
    domain === "example.net" ||
    domain === "example.invalid" ||
    domain === "example.test" ||
    domain === "localhost" ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
};

const hasHighEntropySecretShape = (value: string): boolean => {
  if (value.length < 32 || /^[a-f0-9]{32,}$/i.test(value)) return false;
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;
  return classes >= 3;
};
const unsafeSourceSymbol = (value: string): boolean => {
  if (knownCredentialTokenPattern.test(value)) return true;
  const controller = value.match(/(?:^|\\)([A-Za-z0-9_!@#$%^&*]{32,})Controller(?:::|$)/);
  return controller !== null && hasHighEntropySecretShape(controller[1] ?? "");
};

const frameworkPlaceholderPattern = /^(?:\{[^{}]+\}|<[^<>]+>|:[A-Za-z_][A-Za-z0-9_-]*)$/;
const credentialRouteContextPattern =
  /(?:^|\/)(?:reset|verify|invite|activation|confirm|password-reset|magic|magic-link)(?:[-_]|\/|$)/i;
const longHexAssetSegmentPattern = /^(?=[a-f0-9]{32,}$)(?=.*[a-f])[a-f0-9]+$/i;
export type ScalarContext =
  | "route_path"
  | "route_name"
  | "controller"
  | "owner"
  | "resource"
  | "source_path"
  | "source_symbol"
  | "field";

const scalarContext = (fieldName: string | undefined, source: boolean): ScalarContext => {
  const field = fieldName?.trim().toLowerCase() ?? "";
  if (source) {
    if (field === "path" || field === "source_path") return "source_path";
    if (field === "symbol" || field === "source_symbol") return "source_symbol";
    if (field === "owner" || field === "owner_ref") return "owner";
    return "field";
  }
  if (field === "path" || field === "route_path") return "route_path";
  if (field === "name" || field === "route_name") return "route_name";
  if (field === "controller" || field === "_controller") return "controller";
  if (field === "owner" || field === "owner_ref" || field === "symbol") return "owner";
  if (field === "resource") return "resource";
  return "field";
};

const stripFrameworkPlaceholders = (value: string, context: ScalarContext): string => {
  if (context !== "route_path") return value;
  return value.replace(/\{[^{}]+\}|<[^<>]+>|(?:^|\/):[A-Za-z_][A-Za-z0-9_-]*(?=$|\/)/g, "");
};
const explicitUnsafeScalarReason = (
  normalized: string,
  context: ScalarContext,
  rawField: string,
): "UNSAFE_SOURCE" | null => {
  const literal = stripFrameworkPlaceholders(normalized, context);
  if (
    (identityFieldPattern.test(rawField) || isIdentityFieldName(rawField)) &&
    /^(?:\d{1,12}|[A-Za-z]{1,3}\d{1,8})$/.test(literal)
  )
    return "UNSAFE_SOURCE";
  if (knownCredentialTokenPattern.test(literal)) return "UNSAFE_SOURCE";
  if (credentialAssignmentPattern.test(literal) || colonCredentialAssignmentPattern.test(literal))
    return "UNSAFE_SOURCE";
  if (isSensitiveKeyName(rawField)) return "UNSAFE_SOURCE";
  if (context === "route_path") {
    const query = normalized.match(
      /[?&](password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)=([^&#]*)/i,
    );
    if (
      query !== null &&
      query[2] !== undefined &&
      !frameworkPlaceholderPattern.test(query[2]) &&
      query[2].length > 0
    )
      return "UNSAFE_SOURCE";
    const pathSecret = normalized.match(
      /(?:^|[/?&#])(password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|client[_-]?secret)(?:=|\/)([^/?&#]+)/i,
    );
    if (
      pathSecret !== null &&
      pathSecret[2] !== undefined &&
      !frameworkPlaceholderPattern.test(pathSecret[2]) &&
      pathSecret[2].length > 0
    )
      return "UNSAFE_SOURCE";
  }
  const emails = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (
    emails.some((candidate) => {
      const match = candidate.match(emailPattern);
      return match !== null && !isReservedEmail(candidate, match);
    })
  )
    return "UNSAFE_SOURCE";
  return null;
};

/** Returns a sanitized failure reason without returning the unsafe scalar. */
export const unsafeScalarReason = (value: string, fieldName?: string): "UNSAFE_SOURCE" | null => {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) return null;
  const rawField = fieldName?.trim() ?? "";
  const context = scalarContext(rawField, false);
  const explicit = explicitUnsafeScalarReason(normalized, context, rawField);
  if (context === "owner" && unsafeSourceSymbol(normalized)) return "UNSAFE_SOURCE";
  if (explicit !== null) return explicit;
  const segments = normalized.split(/[/?&#]/);
  if (
    segments.some(
      (segment) => phonePattern.test(segment) && !longHexAssetSegmentPattern.test(segment),
    )
  )
    return "UNSAFE_SOURCE";
  if (context === "route_path") {
    if (
      credentialRouteContextPattern.test(normalized) &&
      segments.some((segment) => /^[a-f0-9]{32,}$/i.test(segment))
    )
      return "UNSAFE_SOURCE";
    if (
      segments.some(
        (segment) =>
          hasHighEntropySecretShape(segment) && !frameworkPlaceholderPattern.test(segment),
      )
    )
      return "UNSAFE_SOURCE";
  }
  return null;
};

/** Returns a source-path/scalar failure reason without generic entropy detection. */
export const unsafeSourceScalarReason = (
  value: string,
  fieldName?: string,
): "UNSAFE_SOURCE" | null => {
  const normalized = value.trim().normalize("NFC");
  if (normalized.length === 0) return null;
  const rawField = fieldName?.trim() ?? "";
  const context = scalarContext(rawField, true);
  if ((context === "owner" || context === "source_symbol") && unsafeSourceSymbol(normalized))
    return "UNSAFE_SOURCE";
  if (sourcePhonePattern.test(normalized)) return "UNSAFE_SOURCE";
  return explicitUnsafeScalarReason(normalized, context, rawField);
};
/** Returns a sanitized source failure before unsafe content can enter a digest or row. */
export const unsafeSourceTextReason = (value: Uint8Array | string): "UNSAFE_SOURCE" | null => {
  let text: string;
  try {
    text =
      typeof value === "string" ? value : new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
  if (
    knownCredentialTokenPattern.test(text) ||
    credentialAssignmentPattern.test(text) ||
    colonCredentialAssignmentPattern.test(text) ||
    jsonStreamHasSensitiveKey(text)
  )
    return "UNSAFE_SOURCE";
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (
    emails.some((candidate) => {
      const match = candidate.match(emailPattern);
      return match !== null && !isReservedEmail(candidate, match);
    })
  )
    return "UNSAFE_SOURCE";
  if (sourcePhonePattern.test(text)) return "UNSAFE_SOURCE";
  return null;
};

/** Returns null instead of emitting a credential, identity, or raw payload scalar. */
export const sanitizeScalar = (value: string, fieldName?: string): string | null =>
  unsafeScalarReason(value, fieldName) === null ? value.trim().normalize("NFC") : null;

const sortedRulesFor = (rootRef: "legacy" | "mono"): readonly IgnoreRule[] =>
  IGNORE_RULES.filter((rule) => rule.root_ref === rootRef).sort(
    (a, b) =>
      a.precedence - b.precedence ||
      compareByteOrder(a.pattern, b.pattern) ||
      compareByteOrder(a.ignore_rule_id, b.ignore_rule_id),
  );

export const effectiveIgnoreRule = (
  rootRef: "legacy" | "mono",
  path: string,
): IgnoreRule | null => {
  const rules = sortedRulesFor(rootRef);
  const matched = new Set<string>();
  for (const rule of rules) {
    if (matchesLiteralPattern(path, rule.pattern) && !matched.has(path)) return rule;
    if (matchesLiteralPattern(path, rule.pattern)) matched.add(path);
  }
  return null;
};

const REDACTED_SOURCE_SCALAR = "unsafe-source-redacted";

const redactedStructuralScalar = (
  value: string | null,
  fieldName: string,
): { readonly value: string | null; readonly unsafe: boolean } => {
  if (value === null) return { value: null, unsafe: false };
  const normalized = value.trim().normalize("NFC");
  if (normalized === REDACTED_SOURCE_SCALAR) return { value: normalized, unsafe: true };
  if (unsafeSourceScalarReason(normalized, fieldName) === null)
    return { value: normalized, unsafe: false };
  return { value: REDACTED_SOURCE_SCALAR, unsafe: true };
};

const sourceKey = (
  authorityLine: AuthorityLine,
  role: string,
  rootRef: string,
  path: string,
  lineStart: number | null,
  lineEnd: number | null,
  symbol: string | null,
): string =>
  canonicalJson({
    authority_line: authorityLine,
    authority_role: role,
    root_ref: rootRef,
    path,
    line_start: lineStart,
    line_end: lineEnd,
    symbol,
  });

export interface OutOfBandSourceCapture {
  readonly bytes: Uint8Array;
  readonly revisionRefId?: string;
  readonly repositoryRef?: string;
}

const makeSource = (
  context: ManifestContext,
  params: {
    readonly authorityLine: AuthorityLine;
    readonly authorityRole: string;
    readonly rootRef: "legacy" | "mono";
    readonly path: string;
    readonly lineStart: number | null;
    readonly lineEnd: number | null;
    readonly symbol: string | null;
    readonly captureMode?: SourceRecord["capture_mode"];
    readonly failureStatus?: SourceRecord["failure_status"];
    readonly failureReason?: string | null;
    readonly outOfBand?: OutOfBandSourceCapture;
  },
): SourceRecord => {
  const safePath = redactedStructuralScalar(params.path, "source_path");
  const safeSymbol = redactedStructuralScalar(params.symbol, "source_symbol");
  const path = safePath.value ?? "unsafe-source-null";
  const symbol = safeSymbol.value;
  const key = sourceKey(
    params.authorityLine,
    params.authorityRole,
    params.rootRef,
    path,
    params.lineStart,
    params.lineEnd,
    symbol,
  );
  const existing = context.sourceByKey.get(key);
  if (existing !== undefined) {
    const found = context.sources.find((source) => source.source_id === existing);
    if (found !== undefined) return found;
  }
  const scanFile = context.scans[params.rootRef].files.find((file) => file.path === path);
  const unsafe = safePath.unsafe || safeSymbol.unsafe || scanFile?.unsafe === true;
  const outOfBand = params.outOfBand;
  const revisionRefId = outOfBand?.revisionRefId ?? context.scans[params.rootRef].revisionRefId;
  const repositoryRef = outOfBand?.repositoryRef ?? params.rootRef;
  const unavailable = outOfBand === undefined && (scanFile === undefined || scanFile.availability === "unavailable" || unsafe);
  const classificationStatus =
    params.failureReason === "UNCLASSIFIED_SOURCE"
      ? ("unclassified" as const)
      : ("classified" as const);
  const sourceId = stableId("src", {
    authority_line: params.authorityLine,
    authority_role: params.authorityRole,
    repository_ref: repositoryRef,
    revision_ref_id: revisionRefId,
    path,
    line_start: params.lineStart,
    line_end: params.lineEnd,
    symbol,
  });
  const recordBase = {
    source_id: sourceId,
    authority_line: params.authorityLine,
    authority_role: params.authorityRole,
    repository_ref: repositoryRef,
    revision_ref_id: revisionRefId,
    path,
    line_start: params.lineStart,
    line_end: params.lineEnd,
    symbol,
    byte_length: unavailable ? null : (outOfBand?.bytes.byteLength ?? scanFile?.byteLength ?? null),
    sha256: unavailable ? null : (outOfBand === undefined ? (scanFile?.digest ?? null) : sha256(outOfBand.bytes)),
    capture_mode: params.captureMode ?? "static",
    availability: unavailable ? ("unavailable" as const) : ("available" as const),
    classification_status: classificationStatus,
    ...(outOfBand === undefined ? {} : { out_of_band: true as const }),
  };
  const record: SourceRecord =
    unavailable || params.failureStatus !== undefined || params.failureReason !== undefined
      ? {
          ...recordBase,
          failure_status:
            params.failureStatus ??
            (unsafe
              ? "source_unavailable"
              : classificationStatus === "unclassified"
                ? "unresolved"
                : "source_unavailable"),
          failure_reason:
            params.failureReason ??
            (unsafe ? "UNSAFE_SOURCE" : unavailable ? "SOURCE_UNAVAILABLE" : null),
        }
      : recordBase;
  context.sourceByKey.set(key, record.source_id);
  context.sourcePathById.set(record.source_id, { rootRef: params.rootRef, path });
  context.sources.push(record);
  return record;
};
export const addSourceReference = (
  context: ManifestContext,
  params: Parameters<typeof makeSource>[1],
): string => makeSource(context, params).source_id;

export type SourceTextResult =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable"; readonly reason: "SOURCE_UNAVAILABLE" | "INVALID_UTF8" };

export const readSourceTextDetailed = (
  context: ManifestContext,
  rootRef: "legacy" | "mono",
  path: string,
): SourceTextResult => {
  const scan = context.scans[rootRef].files.find((file) => file.path === path);
  if (scan === undefined || scan.availability === "unavailable" || scan.bytes === null)
    return { status: "unavailable", reason: "SOURCE_UNAVAILABLE" };
  try {
    return {
      status: "available",
      text: new TextDecoder("utf-8", { fatal: true }).decode(scan.bytes),
    };
  } catch {
    return { status: "unavailable", reason: "INVALID_UTF8" };
  }
};

export const readSourceText = (
  context: ManifestContext,
  rootRef: "legacy" | "mono",
  path: string,
): string | null => {
  const result = readSourceTextDetailed(context, rootRef, path);
  return result.status === "available" ? result.text : null;
};

const sourceFamiliesFor = (rootRef: "legacy" | "mono"): readonly SourceFamily[] =>
  SOURCE_FAMILIES.filter((family) => family.authority_line === rootRef);

const makeRootCensus = (context: ManifestContext, scan: RootScanSnapshot): void => {
  const familyMatches = sourceFamiliesFor(scan.rootRef);
  for (const file of scan.files) {
    const ignore = effectiveIgnoreRule(scan.rootRef, file.path);
    if (ignore !== null) {
      context.rootCensus.push({
        census_id: stableId("census", {
          authority_line: scan.authorityLine,
          root_ref: scan.rootRef,
          path: file.path,
          byte_length: null,
          sha256: null,
          availability: file.availability,
          classification: "ignored",
          source_ref_ids: [],
          ignore_rule_id: ignore.ignore_rule_id,
        }),
        authority_line: scan.authorityLine,
        root_ref: scan.rootRef,
        path: file.path,
        byte_length: null,
        sha256: null,
        availability: file.availability,
        classification: "ignored",
        source_ref_ids: [],
        ignore_rule_id: ignore.ignore_rule_id,
      });
      continue;
    }
    const unsafe = file.unsafe || unsafeSourceScalarReason(file.path, "source_path") !== null;
    const availability = file.availability;
    const sources: string[] = [];
    const censusSource = makeSource(context, {
      authorityLine: scan.authorityLine,
      authorityRole: "census_all_regular_files",
      rootRef: scan.rootRef,
      path: file.path,
      lineStart: null,
      lineEnd: null,
      symbol: null,
      failureStatus: availability === "unavailable" ? "source_unavailable" : undefined,
      failureReason: unsafe
        ? "UNSAFE_SOURCE"
        : availability === "unavailable"
          ? "SOURCE_UNAVAILABLE"
          : undefined,
    });
    sources.push(censusSource.source_id);
    for (const family of familyMatches) {
      if (!family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern))) continue;
      const source = makeSource(context, {
        authorityLine: scan.authorityLine,
        authorityRole: family.authority_role,
        rootRef: scan.rootRef,
        path: file.path,
        lineStart: null,
        lineEnd: null,
        symbol: null,
        failureStatus: availability === "unavailable" ? "source_unavailable" : undefined,
        failureReason: unsafe
          ? "UNSAFE_SOURCE"
          : availability === "unavailable"
            ? "SOURCE_UNAVAILABLE"
            : undefined,
      });
      sources.push(source.source_id);
    }
    const classification =
      availability === "available" ? ("matched" as const) : ("unclassified" as const);
    const censusIdentity = {
      authority_line: scan.authorityLine,
      root_ref: scan.rootRef,
      path: file.path,
      byte_length: availability === "available" ? file.byteLength : null,
      sha256: availability === "available" ? file.digest : null,
      availability,
      classification,
      source_ref_ids: sources,
      ignore_rule_id: null,
    };
    const censusId = stableId("census", censusIdentity);
    context.rootCensus.push({
      authority_line: scan.authorityLine,
      census_id: censusId,
      root_ref: scan.rootRef,
      path: file.path,
      byte_length: availability === "available" ? file.byteLength : null,
      sha256: availability === "available" ? file.digest : null,
      availability,
      classification,
      source_ref_ids: sources,
      ignore_rule_id: null,
    });
  }
  for (const family of familyMatches) {
    const matched = scan.files.some(
      (file) =>
        effectiveIgnoreRule(scan.rootRef, file.path) === null &&
        family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern)),
    );
    if (matched || family.empty_allowed) continue;
    for (const pattern of family.patterns) {
      const source = makeSource(context, {
        authorityLine: scan.authorityLine,
        authorityRole: family.authority_role,
        rootRef: scan.rootRef,
        path: pattern,
        lineStart: null,
        lineEnd: null,
        symbol: null,
        failureStatus: "source_unavailable",
        failureReason: "SOURCE_UNAVAILABLE",
      });
      if (!context.sources.some((entry) => entry.source_id === source.source_id))
        context.sources.push(source);
    }
  }
};

export const createManifestContextFromSnapshots = (
  legacy: RootScanSnapshot,
  mono: RootScanSnapshot,
): ManifestContext => {
  const context: ManifestContext = {
    scans: { legacy, mono },
    sources: [],
    rootCensus: [],
    censusRoots: [
      {
        root_ref: "legacy",
        authority_line: "legacy",
        repository_ref: "legacy",
        revision_ref_id: legacy.revisionRefId,
        root_kind: "repository",
        scan_mode: "all_regular_files",
      },
      {
        root_ref: "mono",
        authority_line: "mono",
        repository_ref: "mono",
        revision_ref_id: mono.revisionRefId,
        root_kind: "repository",
        scan_mode: "all_regular_files",
      },
    ],
    revisions: [legacy.revision, mono.revision],
    runtimeObservations: [],
    ignoreRules: IGNORE_RULES,
    sourceByKey: new Map(),
    sourcePathById: new Map(),
  };
  makeRootCensus(context, legacy);
  makeRootCensus(context, mono);
  return context;
};
export const finalizeManifest = (context: ManifestContext): SourceManifest => {
  const sources = [...context.sources].sort((a, b) => compareByteOrder(a.source_id, b.source_id));
  const rootCensus = [...context.rootCensus].sort((a, b) =>
    compareByteOrder(a.census_id, b.census_id),
  );
  const ignoreRules = [...context.ignoreRules].sort(
    (a, b) =>
      compareByteOrder(a.root_ref, b.root_ref) ||
      a.precedence - b.precedence ||
      compareByteOrder(a.pattern, b.pattern) ||
      compareByteOrder(a.ignore_rule_id, b.ignore_rule_id),
  );
  const censusRoots = [...context.censusRoots].sort((a, b) =>
    compareByteOrder(a.root_ref, b.root_ref),
  );
  const revisions = [...context.revisions].sort((a, b) =>
    compareByteOrder(a.revision_ref_id, b.revision_ref_id),
  );
  const runtimeObservations = [...context.runtimeObservations].sort((a, b) =>
    compareByteOrder(a.runtime_observation_ref_id, b.runtime_observation_ref_id),
  );
  const sourceSetSources = sources.filter((source) => source.out_of_band !== true);
  const sourceSetRuntimeObservations = runtimeObservations.filter((observation) => observation.out_of_band !== true);
  const logical = {
    census_roots: censusRoots,
    revisions,
    runtime_observations: sourceSetRuntimeObservations,
    root_census: rootCensus,
    ignore_rules: ignoreRules,
    sources: sourceSetSources,
  };
  const sourceSetSha = sha256(canonicalJson(logical));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    schema_version: "functional-parity-source-manifest/v1",
    manifest_id: stableId("source-manifest", {
      source_set: "legacy-and-mono-functional-parity",
      source_set_sha256: sourceSetSha,
    }),
    source_set: "legacy-and-mono-functional-parity",
    census_roots: censusRoots,
    revisions,
    runtime_observations: runtimeObservations,
    root_census: rootCensus,
    ignore_rules: ignoreRules,
    sources,
    source_set_sha256: sourceSetSha,
  };
};

export const sourceDigestForManifest = (manifest: SourceManifest): string =>
  sha256(canonicalJson(manifest));

export const sourceById = (manifest: SourceManifest, sourceId: string): SourceRecord | undefined =>
  manifest.sources.find((source) => source.source_id === sourceId);

export const sourceRelativePath = (manifest: SourceManifest, sourceId: string): string | null =>
  sourceById(manifest, sourceId)?.path ?? null;

export const rootRevision = (
  context: ManifestContext,
  rootRef: "legacy" | "mono",
): RevisionRecord => context.scans[rootRef].revision;

export const sourceFamilyMatchedPaths = (
  context: ManifestContext,
  family: SourceFamily,
): readonly string[] => {
  const scan = context.scans[family.authority_line];
  return scan.files
    .filter(
      (file) =>
        effectiveIgnoreRule(scan.rootRef, file.path) === null &&
        family.patterns.some((pattern) => matchesLiteralPattern(file.path, pattern)),
    )
    .map((file) => file.path)
    .sort(compareByteOrder);
};

export const censusUnclassifiedCount = (manifest: SourceManifest): number =>
  manifest.root_census.filter((record) => record.classification === "unclassified").length;
