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
import { Brand, Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AUTHZ_LOCK_PROTOCOL } from "@vektorprogrammet/domain/authz";
import { canonicalJson } from "@vektorprogrammet/domain/shared-kernel";
import type { ReceiptImportResult } from "@vektorprogrammet/domain/receipt";
import type { DatabaseOperations } from "./service.js";

/** Text that PostgreSQL hashes into one advisory lock; only `AdvisoryLockKey` produces it. */
export type AdvisoryLockKey = Brand.Branded<string, "AdvisoryLockKey">;

const advisoryLockKey = Brand.nominal<AdvisoryLockKey>();

/**
 * The registered advisory-lock keys, one constructor per namespace.
 *
 * @construct sql-lock
 */
export const AdvisoryLockKey = {
  /** One person's protected commands and authority writers; migrations 0037, 0038, 0060. */
  personAuthorization: (personId: string) =>
    advisoryLockKey(`vektorprogrammet:person-authorization:v1:${personId}`),
  /** The usable global-administrator set. Acquire it before any person lock. */
  administratorSet: advisoryLockKey("vektorprogrammet:administrator-set:v1"),
  /** The authorization rule set of `AUTHZ_LOCK_PROTOCOL`: readers share it, writers exclude. */
  authorizationRules: advisoryLockKey(AUTHZ_LOCK_PROTOCOL.advisoryKey),
  /** Public application command receipt. Bare. */
  publicApplicationCommand: (commandId: string) => advisoryLockKey(commandId),
  /** Applicant identity by normalized email, across concurrent applications. */
  applicantEmail: (email: string) => advisoryLockKey(`applicant:${email}`),
  /** Returning-assistant registration command receipt. */
  returningAssistantCommand: (commandId: string) => advisoryLockKey(`returning:${commandId}`),
  /** Admission-period command receipt. Bare. */
  admissionPeriodCommand: (commandId: string) => advisoryLockKey(commandId),
  /** The admission period of one department and semester. Bare pair. */
  admissionPeriodSemester: (departmentId: string, semesterId: string) =>
    advisoryLockKey(`${departmentId}:${semesterId}`),
  /** Content publication command receipt. */
  contentCommand: (commandId: string) => advisoryLockKey(`content-command-${commandId}`),
  /** Publication transitions of one article, by its integer identifier. */
  contentArticle: (articleId: number) => advisoryLockKey(`content-article-${articleId}`),
  /** Organization administration command receipt. Bare. */
  organizationCommand: (commandId: string) => advisoryLockKey(commandId),
  /** Organization lifecycle command receipt. */
  organizationLifecycleCommand: (commandId: string) =>
    advisoryLockKey(`organization-lifecycle:${commandId}`),
  /** Delegation command receipt. */
  delegationCommand: (commandId: string) => advisoryLockKey(`delegation-command:${commandId}`),
  /** Own-Profile command receipt. Bare. */
  profileCommand: (commandId: string) => advisoryLockKey(commandId),
  /** Receipt command receipt, shared by receipt and settlement commands. */
  receiptCommand: (commandId: string) => advisoryLockKey(`receipt-command:${commandId}`),
  /** One external settlement reference. */
  receiptSettlementReference: (externalAuthority: string, externalReference: string) =>
    advisoryLockKey(
      `receipt-settlement-reference:${JSON.stringify([externalAuthority, externalReference])}`,
    ),
  /** Ownership of one legacy source receipt, across native and reviewed importers. */
  receiptImportSource: (sourceRepository: string, sourcePrimaryKey: string) =>
    advisoryLockKey(`receipt-import-source:${canonicalJson([sourceRepository, sourcePrimaryKey])}`),
  /** One import occurrence of a legacy source receipt. Bare canonical JSON. */
  receiptImportOccurrence: (result: ReceiptImportResult) =>
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
  /** The destination receipt identifier of an import. */
  importedReceipt: (receiptId: string) => advisoryLockKey(`receipt:${receiptId}`),
  /** The destination visual identifier of an import. */
  importedReceiptVisual: (visualId: string) => advisoryLockKey(`visual:${visualId}`),
  /** The reviewed receipt cohort import. */
  reviewedReceiptImport: advisoryLockKey("native-reviewed-receipt-import"),
  /** Schedule, conduct, response, and staffing writers of one interview; migration 0039. Bare. */
  recruitmentInterview: (interviewId: string) => advisoryLockKey(interviewId),
  /** Recruitment scheduling, conduct, and assignment command receipt. Bare. */
  recruitmentCommand: (commandId: string) => advisoryLockKey(commandId),
  /** Assignment writers of one application. Bare. */
  recruitmentApplication: (applicationId: string) => advisoryLockKey(applicationId),
  /** Recruitment maintenance command receipt of one actor. */
  recruitmentMaintenanceCommand: (personId: string, commandId: string) =>
    advisoryLockKey(`recruitment-maintenance:${personId}:${commandId}`),
  /** School administration command receipt of one actor. */
  schoolsCommand: (personId: string, commandId: string) =>
    advisoryLockKey(`schools-command:${personId}:${commandId}`),
  /** Team application command receipt. */
  teamApplicationCommand: (commandId: string) =>
    advisoryLockKey(`team-application-command:${commandId}`),
  /** Native HTTP command receipt identity digest. Bare. */
  httpCommandReceipt: (identitySha256: string) => advisoryLockKey(identitySha256),
} as const;

/** Shared holders exclude only exclusive holders; an exclusive holder excludes both. */
export type AdvisoryLockMode = "exclusive" | "shared";

/**
 * Waits for the advisory lock on `key` until the current transaction ends. Outside a
 * transaction PostgreSQL releases it after the statement, so run it inside `withTransaction`.
 *
 * @construct sql-lock
 */
export const lockAdvisory = (
  sql: DatabaseOperations,
  key: AdvisoryLockKey,
  mode: AdvisoryLockMode = "exclusive",
): Effect.Effect<void, SqlError> =>
  (mode === "shared"
    ? sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${key}, 0))`
    : sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  ).pipe(Effect.asVoid);

/**
 * Takes the exclusive advisory lock on `key` until the current transaction ends when no other
 * transaction holds it. Answers false instead of waiting.
 *
 * @construct sql-lock
 */
export const tryLockAdvisory = (
  sql: DatabaseOperations,
  key: AdvisoryLockKey,
): Effect.Effect<boolean, SqlError> =>
  sql<{ readonly acquired: boolean }>`
    SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0)) AS acquired
  `.pipe(Effect.map((rows) => rows[0]?.acquired === true));
