/**
 * The schema search path of each production PostgreSQL pool, one source for hosts, proofs and tests.
 * The pool layers never supply a fallback; every host passes one of these as `startupOptions`.
 */

/** Production native database pools resolve business tables in public only. */
export const NativeDatabaseStartupOptions = "-c search_path=public";

/** Supported Better Auth pools resolve authentication tables in auth only. */
export const BetterAuthStartupOptions = "-c search_path=auth";
