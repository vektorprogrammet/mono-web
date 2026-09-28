/**
 * Transaction-scoped PostgreSQL advisory locks under registered keys.
 *
 * PostgreSQL identifies an advisory lock by `hashtextextended(key, 0)`, so every writer that
 * hashes the same key text shares the lock. Each key namespace is spelled once below and is
 * reachable only through its named constructor. Changing the bytes of a key silently ends mutual
 * exclusion with every writer that still uses the old bytes.
 *
 * SQL writers outside this module hash the same text; keep them byte-identical:
 * - person authorization: `'vektorprogrammet:person-authorization:v1:' || person` in migrations
 *   0037 and 0038 (`public.version_applicant_identity_link`) and 0060
 *   (`auth.guard_session_issuance`, `auth.guard_credential_write`,
 *   `auth.guard_human_token_issuance`);
 * - recruitment interview: the bare interview identifier in migration 0039
 *   (`public.enforce_recruitment_interview_correction_chain`).
 *
 * Raw `pg` adapters that still spell their keys by hand are the exceptions of the
 * `anti-slop/no-raw-advisory-lock-sql` rule in `oxlint.config.ts`.
 *
 * Constructors documented as bare hash the identifier without a prefix, so they share one key
 * space. Adding a prefix to one of them is a lock migration, not a rename.
 */
import { Brand, Effect, Predicate } from "effect";
import { dual } from "effect/Function";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AUTHZ_LOCK_PROTOCOL } from "@vektorprogrammet/domain/authz";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import type { ReceiptImportResult } from "@vektorprogrammet/domain/receipt";
import type { DatabaseOperations } from "./service.js";

/** Text that PostgreSQL hashes into one advisory lock; only `AdvisoryLockKey` produces it. */
export type AdvisoryLockKey = Brand.Branded<string, "AdvisoryLockKey">;

const advisoryLockKey = Brand.nominal<AdvisoryLockKey>();

/** The key namespaces of `AdvisoryLockKey`, each with the writers that share its lock. */
export interface AdvisoryLockKeys {
  /** One person's protected commands and authority writers; migrations 0037, 0038, 0060. */
  readonly personAuthorization: (personId: string) => AdvisoryLockKey;
  /** The usable global-administrator set. Acquire it before any person lock. */
  readonly administratorSet: AdvisoryLockKey;
  /** The authorization rule set of `AUTHZ_LOCK_PROTOCOL`: readers share it, writers exclude. */
  readonly authorizationRules: AdvisoryLockKey;
  /** Public application command receipt. Bare. */
  readonly publicApplicationCommand: (commandId: string) => AdvisoryLockKey;
  /** Applicant identity by normalized email, across concurrent applications. */
  readonly applicantEmail: (email: string) => AdvisoryLockKey;
  /** Returning-assistant registration command receipt. */
  readonly returningAssistantCommand: (commandId: string) => AdvisoryLockKey;
  /** Admission-period command receipt. Bare. */
  readonly admissionPeriodCommand: (commandId: string) => AdvisoryLockKey;
  /** The admission period of one department and semester. Bare pair. */
  readonly admissionPeriodSemester: (departmentId: string, semesterId: string) => AdvisoryLockKey;
  /** Content publication command receipt. */
  readonly contentCommand: (commandId: string) => AdvisoryLockKey;
  /** Publication transitions of one article, by its integer identifier. */
  readonly contentArticle: (articleId: number) => AdvisoryLockKey;
  /** Organization administration command receipt. Bare. */
  readonly organizationCommand: (commandId: string) => AdvisoryLockKey;
  /** Organization lifecycle command receipt. */
  readonly organizationLifecycleCommand: (commandId: string) => AdvisoryLockKey;
  /** Delegation command receipt. */
  readonly delegationCommand: (commandId: string) => AdvisoryLockKey;
  /** Own-Profile command receipt. Bare. */
  readonly profileCommand: (commandId: string) => AdvisoryLockKey;
  /** Receipt command receipt, shared by receipt and settlement commands. */
  readonly receiptCommand: (commandId: string) => AdvisoryLockKey;
  /** One external settlement reference. */
  readonly receiptSettlementReference: (
    externalAuthority: string,
    externalReference: string,
  ) => AdvisoryLockKey;
  /** Ownership of one legacy source receipt, across native and reviewed importers. */
  readonly receiptImportSource: (
    sourceRepository: string,
    sourcePrimaryKey: string,
  ) => AdvisoryLockKey;
  /** One import occurrence of a legacy source receipt. Bare canonical JSON. */
  readonly receiptImportOccurrence: (result: ReceiptImportResult) => AdvisoryLockKey;
  /** The destination receipt identifier of an import. */
  readonly importedReceipt: (receiptId: string) => AdvisoryLockKey;
  /** The destination visual identifier of an import. */
  readonly importedReceiptVisual: (visualId: string) => AdvisoryLockKey;
  /** The reviewed receipt cohort import. */
  readonly reviewedReceiptImport: AdvisoryLockKey;
  /** Schedule, conduct, response, and staffing writers of one interview; migration 0039. Bare. */
  readonly recruitmentInterview: (interviewId: string) => AdvisoryLockKey;
  /** Recruitment scheduling, conduct, and assignment command receipt. Bare. */
  readonly recruitmentCommand: (commandId: string) => AdvisoryLockKey;
  /** Assignment writers of one application. Bare. */
  readonly recruitmentApplication: (applicationId: string) => AdvisoryLockKey;
  /** Recruitment maintenance command receipt of one actor. */
  readonly recruitmentMaintenanceCommand: (personId: string, commandId: string) => AdvisoryLockKey;
  /** School administration command receipt of one actor. */
  readonly schoolsCommand: (personId: string, commandId: string) => AdvisoryLockKey;
  /** Team application command receipt. */
  readonly teamApplicationCommand: (commandId: string) => AdvisoryLockKey;
  /** Native HTTP command receipt identity digest. Bare. */
  readonly httpCommandReceipt: (identitySha256: string) => AdvisoryLockKey;
}

/**
 * The registered advisory-lock keys, one constructor per namespace.
 *
 * @remarks
 * Each member builds the key text of one namespace, and `AdvisoryLockKeys` names the writers that
 * share it. `lockAdvisory` hashes the text with `hashtextextended(key, 0)`, so two writers exclude
 * each other exactly when they build the same bytes. A bare namespace hashes its identifier
 * without a prefix, so the bare namespaces share one key space. The SQL writers that the module
 * documentation lists hash the same text inside migrations.
 *
 * @sideEffects none: it builds key text, and `lockAdvisory` takes the lock.
 *
 * @example
 * ```ts
 * yield* lockAdvisory(sql, AdvisoryLockKey.receiptCommand(command.commandId));
 * ```
 *
 * @avoid Writing key text by hand, in SQL or in TypeScript, or changing the bytes of a member:
 * another spelling ends mutual exclusion with every writer of the old bytes, and
 * `anti-slop/no-raw-advisory-lock-sql` rejects hand-written advisory-lock SQL. Add a member for a
 * new namespace; a change to an existing one is a lock migration.
 *
 * @construct sql-lock
 */
export const AdvisoryLockKey: AdvisoryLockKeys = {
  personAuthorization: (personId) =>
    advisoryLockKey(`vektorprogrammet:person-authorization:v1:${personId}`),
  administratorSet: advisoryLockKey("vektorprogrammet:administrator-set:v1"),
  authorizationRules: advisoryLockKey(AUTHZ_LOCK_PROTOCOL.advisoryKey),
  publicApplicationCommand: (commandId) => advisoryLockKey(commandId),
  applicantEmail: (email) => advisoryLockKey(`applicant:${email}`),
  returningAssistantCommand: (commandId) => advisoryLockKey(`returning:${commandId}`),
  admissionPeriodCommand: (commandId) => advisoryLockKey(commandId),
  admissionPeriodSemester: (departmentId, semesterId) =>
    advisoryLockKey(`${departmentId}:${semesterId}`),
  contentCommand: (commandId) => advisoryLockKey(`content-command-${commandId}`),
  contentArticle: (articleId) => advisoryLockKey(`content-article-${articleId}`),
  organizationCommand: (commandId) => advisoryLockKey(commandId),
  organizationLifecycleCommand: (commandId) =>
    advisoryLockKey(`organization-lifecycle:${commandId}`),
  delegationCommand: (commandId) => advisoryLockKey(`delegation-command:${commandId}`),
  profileCommand: (commandId) => advisoryLockKey(commandId),
  receiptCommand: (commandId) => advisoryLockKey(`receipt-command:${commandId}`),
  receiptSettlementReference: (externalAuthority, externalReference) =>
    advisoryLockKey(
      `receipt-settlement-reference:${JSON.stringify([externalAuthority, externalReference])}`,
    ),
  receiptImportSource: (sourceRepository, sourcePrimaryKey) =>
    advisoryLockKey(`receipt-import-source:${canonicalJson([sourceRepository, sourcePrimaryKey])}`),
  receiptImportOccurrence: (result) =>
    advisoryLockKey(
      canonicalJson({
        sourceRepository: result.provenance.sourceRepository,
        sourceRevision: result.provenance.sourceRevision,
        snapshotId: result.provenance.snapshotId,
        sourcePrimaryKey: result.sourcePrimaryKey,
        sourceOccurrence: result.sourceOccurrence,
        transformationRevision: result.provenance.transformationRevision,
      }),
    ),
  importedReceipt: (receiptId) => advisoryLockKey(`receipt:${receiptId}`),
  importedReceiptVisual: (visualId) => advisoryLockKey(`visual:${visualId}`),
  reviewedReceiptImport: advisoryLockKey("native-reviewed-receipt-import"),
  recruitmentInterview: (interviewId) => advisoryLockKey(interviewId),
  recruitmentCommand: (commandId) => advisoryLockKey(commandId),
  recruitmentApplication: (applicationId) => advisoryLockKey(applicationId),
  recruitmentMaintenanceCommand: (personId, commandId) =>
    advisoryLockKey(`recruitment-maintenance:${personId}:${commandId}`),
  schoolsCommand: (personId, commandId) =>
    advisoryLockKey(`schools-command:${personId}:${commandId}`),
  teamApplicationCommand: (commandId) => advisoryLockKey(`team-application-command:${commandId}`),
  httpCommandReceipt: (identitySha256) => advisoryLockKey(identitySha256),
};

/** Shared holders exclude only exclusive holders; an exclusive holder excludes both. */
export type AdvisoryLockMode = "exclusive" | "shared";

/**
 * Waits for the advisory lock on `key` until the current transaction ends.
 *
 * @remarks
 * It runs `pg_advisory_xact_lock(hashtextextended(key, 0))`, or `pg_advisory_xact_lock_shared`
 * when `mode` is `shared`: shared holders exclude only exclusive holders, and an exclusive holder
 * excludes both. PostgreSQL releases a transaction-level lock at commit or rollback, and outside a
 * transaction after the statement, so the lock serializes only what runs inside the same
 * `withTransaction`. Writers that take several locks take them in one order, such as the
 * administrator set before any person lock, so that two of them cannot deadlock.
 *
 * @sideEffects Holds a PostgreSQL advisory lock until the transaction ends, and waits while
 * another transaction holds a conflicting one.
 *
 * @example
 * ```ts
 * yield* lockAdvisory(sql, AdvisoryLockKey.contentArticle(articleId));
 * ```
 *
 * @avoid Calling it outside `withTransaction`, where the lock ends with its own statement and
 * guards nothing, and hand-written `pg_advisory_xact_lock` SQL, which
 * `anti-slop/no-raw-advisory-lock-sql` rejects. Lock first inside the transaction that writes.
 *
 * @construct sql-lock
 */
export const lockAdvisory: {
  (
    key: AdvisoryLockKey,
    mode?: AdvisoryLockMode,
  ): (sql: DatabaseOperations) => Effect.Effect<void, SqlError>;
  (
    sql: DatabaseOperations,
    key: AdvisoryLockKey,
    mode?: AdvisoryLockMode,
  ): Effect.Effect<void, SqlError>;
} = dual(
  (args) => !Predicate.isString(args[0]),
  (
    sql: DatabaseOperations,
    key: AdvisoryLockKey,
    mode: AdvisoryLockMode = "exclusive",
  ): Effect.Effect<void, SqlError> =>
    (mode === "shared"
      ? sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${key}, 0))`
      : sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
    ).pipe(Effect.asVoid),
);

/**
 * Takes the exclusive advisory lock on `key` until the current transaction ends when no other
 * transaction holds it. Answers false instead of waiting.
 */
export const tryLockAdvisory: {
  (key: AdvisoryLockKey): (sql: DatabaseOperations) => Effect.Effect<boolean, SqlError>;
  (sql: DatabaseOperations, key: AdvisoryLockKey): Effect.Effect<boolean, SqlError>;
} = dual(
  2,
  (sql: DatabaseOperations, key: AdvisoryLockKey): Effect.Effect<boolean, SqlError> =>
    sql<{ readonly acquired: boolean }>`
    SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0)) AS acquired
  `.pipe(Effect.map((rows) => rows[0]?.acquired === true)),
);
