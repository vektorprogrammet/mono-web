import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Database } from "@vektorprogrammet/database";
import { readPrivateCohortJson } from "@vektorprogrammet/database/cohort-cli";
import { databaseSchemaRevision } from "@vektorprogrammet/database/migrations";
import { DatabaseRuntimeLive } from "@vektorprogrammet/database/runtime";
import { ReceiptCohortFailure, ReceiptReview } from "@vektorprogrammet/domain/receipt";
import { Effect, Layer, Predicate, Redacted, Schema } from "effect";
import {
  ReceiptFileStoreLive,
  ReceiptFileStoreResource,
} from "@vektorprogrammet/backend/receipt/filesystem";
import { decodePaymentAccountCipher } from "@vektorprogrammet/backend/receipt/payment-account";
import { runReviewedReceiptImport } from "@vektorprogrammet/backend/receipt/reviewed-import";
import { selectLegacyTargetTransport } from "./legacy-database-transport";
import {
  buildLegacyReceiptSnapshot,
  legacyReceiptAccounts,
  legacyReceiptTransformationRevision,
} from "./legacy-receipt-snapshot";
import { readLegacySourceSnapshot } from "./legacy-source-snapshot";

const EnvironmentName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)));

const PathSelection = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));

export const LegacyReceiptImportOptions = Schema.Struct({
  reviewPath: PathSelection,
  archiveRoot: PathSelection,
  stagingRoot: PathSelection,
  committedRoot: PathSelection,
  paymentKeyPath: PathSelection,
  sourceEnv: EnvironmentName,
  targetEnv: EnvironmentName,
  targetDatabase: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_]+$/))),
  organizationSource: Schema.Literals(["NotRequested", "Include"]),
});

export type LegacyReceiptImportOptions = typeof LegacyReceiptImportOptions.Type;

type ImportStage =
  | "Selection"
  | "ReviewRead"
  | "KeyRead"
  | "Transformation"
  | "SourceRead"
  | "Projection"
  | "FileRoots"
  | "TargetConnect"
  | "ReceiptImport";

export class LegacyReceiptImportFailure extends Error {
  constructor(
    readonly stage: ImportStage,
    readonly code: string = "Failed",
  ) {
    super(`Legacy receipt import ${stage}/${code} failed; details redacted`);
    this.name = "LegacyReceiptImportFailure";
  }
}

const privateDirectory = async (selection: string, create: boolean): Promise<void> => {
  const path = resolve(selection);

  let metadata = await lstat(path).catch((error) => {
    if (Predicate.isObjectOrArray(error) && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });

  if (metadata === null && create) {
    // Inspect the nearest existing ancestor before recursive creation can follow a symlink.
    let ancestor = dirname(path);

    for (;;) {
      try {
        if ((await realpath(ancestor)) !== ancestor)
          throw new LegacyReceiptImportFailure("FileRoots", "UnsafeDirectory");
        break;
      } catch (error) {
        if (!Predicate.isObjectOrArray(error) || !("code" in error) || error.code !== "ENOENT")
          throw error;
        ancestor = dirname(ancestor);
      }
    }

    await mkdir(path, { recursive: true, mode: 0o700 });
    metadata = await lstat(path);
  }

  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new LegacyReceiptImportFailure("FileRoots", "UnsafeDirectory");
};

/** Separate from the service cutover: Person/reference transactions must already be committed. */
export const runLegacyReceiptImport = async (input: LegacyReceiptImportOptions) => {
  let stage: ImportStage = "Selection";

  try {
    const options = Schema.decodeUnknownSync(LegacyReceiptImportOptions)(input, {
      onExcessProperty: "error",
    });

    const sourceUrl = process.env[options.sourceEnv];
    const targetUrl = process.env[options.targetEnv];

    if (
      !sourceUrl ||
      !targetUrl ||
      options.sourceEnv === options.targetEnv ||
      sourceUrl === targetUrl
    )
      throw new LegacyReceiptImportFailure(stage, "InvalidSelection");
    const roots = [options.archiveRoot, options.stagingRoot, options.committedRoot];

    if (
      roots.some((path) => !isAbsolute(path) || path.includes("\0")) ||
      new Set(roots.map((path) => resolve(path))).size !== roots.length
    )
      throw new LegacyReceiptImportFailure(stage, "InvalidFileRoots");

    const { targetSelection, socketPath, caEnv } = selectLegacyTargetTransport(
      targetUrl,
      options.targetDatabase,
    );

    stage = "ReviewRead";

    const review = Schema.decodeUnknownSync(ReceiptReview)(
      await readPrivateCohortJson(
        options.reviewPath,
        () => new Error("InvalidSnapshot"),
        16_777_216,
      ),
      { onExcessProperty: "error" },
    );

    stage = "KeyRead";

    const cipher = decodePaymentAccountCipher(
      await readPrivateCohortJson(options.paymentKeyPath, () => new Error("InvalidSnapshot"), 4096),
    );

    stage = "Transformation";

    if (review.transformationRevision !== (await legacyReceiptTransformationRevision()))
      throw new LegacyReceiptImportFailure(stage, "TransformationMismatch");
    stage = "SourceRead";
    const source = await readLegacySourceSnapshot(sourceUrl, options.organizationSource, "Include");
    stage = "Projection";
    const snapshot = buildLegacyReceiptSnapshot(source, review, cipher);
    const accounts = legacyReceiptAccounts(source);
    stage = "FileRoots";
    await privateDirectory(options.archiveRoot, false);
    await privateDirectory(options.stagingRoot, true);
    await privateDirectory(options.committedRoot, true);

    stage = "TargetConnect";

    return await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database;
        const files = yield* ReceiptFileStoreResource;

        const selected = yield* database<{
          readonly name: string;
        }>`SELECT current_database() AS name`;

        if (selected[0]?.name !== options.targetDatabase)
          return yield* new ReceiptCohortFailure({ code: "TargetDatabaseMismatch" });

        if (database.schemaRevision !== databaseSchemaRevision)
          return yield* new ReceiptCohortFailure({ code: "TargetSchemaMismatch" });
        stage = "ReceiptImport";

        const report = yield* runReviewedReceiptImport(
          snapshot,
          accounts,
          options.archiveRoot,
          files,
          cipher,
        );

        // Deliberate allowlist: acceptedResults contains private ciphertext, descriptions and file metadata.
        return {
          snapshotKey: report.snapshotKey,
          sourceRevision: review.sourceRevision,
          receiptSourceRevision: review.receiptSourceRevision,
          transformationRevision: review.transformationRevision,
          schemaRevision: database.schemaRevision,
          replay: report.replay,
          input: report.input,
          accepted: report.accepted,
          quarantined: report.quarantined,
          excluded: report.excluded,
          occurrences: report.occurrences.map(({ sourcePrimaryKey, disposition, reasons }) => ({
            sourcePrimaryKey,
            disposition,
            reasons: disposition === "Excluded" ? ["ExcludedByReview"] : reasons,
          })),
          reconciled: report.reconciled,
          pending: report.pending,
          complete: report.complete,
        };
      }).pipe(
        Effect.catchTag("ReceiptCohortFailure", (failure) =>
          Effect.fail(new LegacyReceiptImportFailure(stage, failure.code)),
        ),
        Effect.provide(
          Layer.merge(
            ReceiptFileStoreLive({
              stagingRoot: options.stagingRoot,
              committedRoot: options.committedRoot,
            }),
            DatabaseRuntimeLive({
              url: Redacted.make(targetSelection.toString()),
              host: socketPath ?? undefined,
              ssl:
                caEnv === null ? undefined : { ca: process.env[caEnv], rejectUnauthorized: true },
              applicationName: "reviewed-legacy-receipt-import",
              maxConnections: 2,
            }),
          ),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof LegacyReceiptImportFailure) throw error;
    throw new LegacyReceiptImportFailure(stage);
  }
};

const usage =
  "Usage: bun run run-legacy-receipt-import.ts --review=PATH --archive-root=PATH --staging-root=PATH --committed-root=PATH --payment-key=PATH --source-env=NAME --target-env=NAME --target-database=NAME --organization-source=none|include (existing migrated target schema required; connections require local sockets or verified TLS)";

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    try {
      const names = [
        "review",
        "archive-root",
        "staging-root",
        "committed-root",
        "payment-key",
        "source-env",
        "target-env",
        "target-database",
        "organization-source",
      ];

      const argumentsByName: Record<string, string> = {};

      for (const argument of process.argv.slice(2)) {
        const match = /^--([a-z-]+)=(.+)$/.exec(argument);

        if (!match || !names.includes(match[1]!) || Object.hasOwn(argumentsByName, match[1]!))
          throw new LegacyReceiptImportFailure("Selection", "InvalidOptions");
        argumentsByName[match[1]!] = match[2]!;
      }

      if (
        names.some((name) => !argumentsByName[name]) ||
        !["none", "include"].includes(argumentsByName["organization-source"]!)
      )
        throw new LegacyReceiptImportFailure("Selection", "InvalidOptions");

      const report = await runLegacyReceiptImport({
        reviewPath: argumentsByName.review!,
        archiveRoot: argumentsByName["archive-root"]!,
        stagingRoot: argumentsByName["staging-root"]!,
        committedRoot: argumentsByName["committed-root"]!,
        paymentKeyPath: argumentsByName["payment-key"]!,
        sourceEnv: argumentsByName["source-env"]!,
        targetEnv: argumentsByName["target-env"]!,
        targetDatabase: argumentsByName["target-database"]!,
        organizationSource:
          argumentsByName["organization-source"] === "include" ? "Include" : "NotRequested",
      });

      console.log(JSON.stringify(report));

      if (!report.complete) process.exitCode = 2;
    } catch (error) {
      console.error(
        error instanceof LegacyReceiptImportFailure
          ? error.message
          : "Legacy receipt import Selection/Failed failed; details redacted",
      );
      process.exitCode = 1;
    }
  }
}
