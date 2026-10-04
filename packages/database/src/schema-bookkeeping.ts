/**
 * The tables that a freshly built database fills: the ledgers of the schema changes applied to
 * it, and the copy that a migration ships with the system.
 *
 * They hold no application state when the schema is built: building it fills them, and nothing else
 * does. A check that a database holds no application state, such as the empty-target scan of
 * a legacy cutover, skips exactly these tables. `schema-bookkeeping.test.ts` builds a fresh
 * database and fails when a table outside this list holds rows, or when a listed table is
 * missing, so a schema change that seeds a new table must declare it here.
 */

/** A table in the `public` or `auth` schema, the two schemas of the native database. */
export interface SchemaBookkeepingTable {
  readonly schema: "public" | "auth";
  readonly table: string;
}

/** The ledger in which the Migrator of `runDatabaseMigrations` records each applied migration. */
export const schemaMigrationLedger = {
  schema: "public",
  table: "vektorprogrammet_schema_migrations",
} as const satisfies SchemaBookkeepingTable;

/**
 * The ledger of the PersistedQueue SQL store's own Migrator (`<tableName>_migrations` for the
 * `effect_queue` store). The schema pre-records the store's migrations in it, so the store
 * finds nothing to run at process start.
 */
export const persistedQueueMigrationLedger = {
  schema: "public",
  table: "effect_queue_migrations",
} as const satisfies SchemaBookkeepingTable;

/**
 * The scope row and the three approved default messages (global revision 1) that migration 0082
 * seeds for the admission outcome mail. They are the system's shipped copy, not people's data.
 * Listing them makes the empty-target scan of a legacy cutover skip these two tables whatever they
 * hold, so a template that a coordinator or administrator later edits is not seen as preexisting
 * state there. The edited rows are append-only revisions and stay readable through the template
 * store.
 */
export const admissionOutcomeTemplateScopes = {
  schema: "public",
  table: "admission_outcome_template_scopes",
} as const satisfies SchemaBookkeepingTable;

export const admissionOutcomeTemplateRevisions = {
  schema: "public",
  table: "admission_outcome_template_revisions",
} as const satisfies SchemaBookkeepingTable;

/** Every bookkeeping table of a freshly built database. */
export const schemaBookkeepingTables = [
  schemaMigrationLedger,
  persistedQueueMigrationLedger,
  admissionOutcomeTemplateScopes,
  admissionOutcomeTemplateRevisions,
] as const satisfies ReadonlyArray<SchemaBookkeepingTable>;
