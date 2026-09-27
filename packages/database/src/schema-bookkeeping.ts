/**
 * The tables in which a freshly built database records the schema changes applied to it.
 *
 * They are ledgers, not application state: building the schema fills them, and nothing else
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

/** Every bookkeeping table of a freshly built database. */
export const schemaBookkeepingTables = [
  schemaMigrationLedger,
  persistedQueueMigrationLedger,
] as const satisfies ReadonlyArray<SchemaBookkeepingTable>;
