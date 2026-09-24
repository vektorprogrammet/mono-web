import { join } from "node:path";
import { Effect, Schema } from "effect";
import { validateAcceptedIntentAuthoringDocument } from "./accepted-intent-schema.js";
import { canonicalJson, compareByteOrder, sha256, sortUnique } from "./canonical.js";
import { tryDecodeAcceptedIntentRegister } from "./coverage.js";
import { assertSafeAcceptedIntentBytes } from "./coverage.js";
import { validateInventory, validateSourceManifest } from "./schema.js";
import { ParityFileSystem, type ParityFileSystemOperations } from "./services.js";
import type { InventoryEnvelope, InventoryKind, SourceManifest } from "./types.js";

export class AcceptedIntentAuthorError extends Schema.TaggedError<AcceptedIntentAuthorError>()(
  "AcceptedIntentAuthorError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const INVENTORY_FILES = [
  "legacy-routes.json",
  "mono-routes.json",
  "api-operations.json",
  "command-write-paths.json",
  "scheduled-background-workflows.json",
  "external-integrations.json",
] as const;

export interface AuthorAcceptedIntentOptions {
  readonly inputPath: string;
  readonly sourceManifestPath: string;
  readonly inventoryDirectory: string;
  readonly outputPath: string;
}

export interface AcceptedIntentAuthorReceipt {
  readonly status: "accepted_intent_written";
  readonly output_path: string;
  readonly output_sha256: string;
  readonly selected_revision_ref_ids: readonly string[];
  readonly intent_count: number;
  readonly journey_count: number;
  readonly step_count: number;
}

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

const parseJson = (
  bytes: Uint8Array,
  label: string,
): Effect.Effect<Schema.Json, AcceptedIntentAuthorError> =>
  Effect.try({
    try: () => decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: (cause) =>
      new AcceptedIntentAuthorError({
        message: `${label} is not valid UTF-8 JSON`,
        cause,
      }),
  });

const readBytes = (
  fileSystem: ParityFileSystemOperations,
  path: string,
): Effect.Effect<Uint8Array, AcceptedIntentAuthorError> =>
  Effect.tryPromise({
    try: () => fileSystem.readBytesPromise(path),
    catch: (cause) => new AcceptedIntentAuthorError({ message: `cannot read ${path}`, cause }),
  });

const sourceManifestDigest = (manifest: SourceManifest): string => sha256(canonicalJson(manifest));

const loadInputs = (fileSystem: ParityFileSystemOperations, options: AuthorAcceptedIntentOptions) =>
  Effect.gen(function* () {
    const inputBytes = yield* readBytes(fileSystem, options.inputPath);
    yield* Effect.try({
      try: () => assertSafeAcceptedIntentBytes(inputBytes, false),
      catch: (cause) =>
        new AcceptedIntentAuthorError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    const input = yield* parseJson(inputBytes, "accepted intent authoring input");

    if (!validateAcceptedIntentAuthoringDocument(input))
      return yield* new AcceptedIntentAuthorError({
        message: "accepted intent authoring input is schema-invalid",
      });

    const manifest = yield* parseJson(
      yield* readBytes(fileSystem, options.sourceManifestPath),
      "source manifest",
    );

    if (!validateSourceManifest(manifest))
      return yield* new AcceptedIntentAuthorError({ message: "source manifest is schema-invalid" });
    const manifestSha256 = sourceManifestDigest(manifest);

    const inventories: InventoryEnvelope[] = [];

    for (const file of INVENTORY_FILES) {
      const inventory = yield* parseJson(
        yield* readBytes(fileSystem, join(options.inventoryDirectory, file)),
        file,
      );

      if (!validateInventory(inventory))
        return yield* new AcceptedIntentAuthorError({ message: `${file} is schema-invalid` });

      if (inventory.source_manifest_sha256 !== manifestSha256)
        return yield* new AcceptedIntentAuthorError({
          message: `${file} does not derive from the supplied source manifest`,
        });
      inventories.push(inventory);
    }

    return { input, manifest, inventories };
  });

const sortStrings = (values: readonly string[]): string[] => [...values].sort(compareByteOrder);

export const authorAcceptedIntentRegister = (
  options: AuthorAcceptedIntentOptions,
): Effect.Effect<AcceptedIntentAuthorReceipt, AcceptedIntentAuthorError, ParityFileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* ParityFileSystem;
    const { input, manifest, inventories } = yield* loadInputs(fileSystem, options);

    const { register, expectedRevisionRefIds } = yield* Effect.try({
      try: () => {
        const expectedRevisionRefIds = sortStrings(
          manifest.revisions
            .filter(
              (revision) =>
                revision.repository_ref === "legacy" || revision.repository_ref === "mono",
            )
            .map((revision) => revision.revision_ref_id),
        );

        if (
          canonicalJson(sortStrings(input.selected_revision_ref_ids)) !==
          canonicalJson(expectedRevisionRefIds)
        ) {
          throw new AcceptedIntentAuthorError({
            message: "selected revisions do not match the supplied source manifest",
          });
        }

        const sourceIds = new Set(manifest.sources.map((source) => source.source_id));

        const rows = new Map(
          inventories.flatMap((inventory) =>
            inventory.rows.map(
              (row) =>
                [row.row_id, { kind: inventory.inventory_kind, signature: row.signature }] as const,
            ),
          ),
        );

        const signatureKinds = new Map<string, Set<InventoryKind>>();

        for (const inventory of inventories) {
          for (const row of inventory.rows) {
            const kinds = signatureKinds.get(row.signature) ?? new Set<InventoryKind>();
            kinds.add(inventory.inventory_kind);
            signatureKinds.set(row.signature, kinds);
          }
        }

        const validateSources = (ids: readonly string[]): void => {
          for (const id of ids)
            if (!sourceIds.has(id))
              throw new AcceptedIntentAuthorError({ message: `unknown source reference: ${id}` });
        };

        const validateRow = (rowId: string, kind: string): void => {
          const row = rows.get(rowId);

          if (row === undefined)
            throw new AcceptedIntentAuthorError({ message: `unknown inventory row: ${rowId}` });

          if (row.kind !== kind)
            throw new AcceptedIntentAuthorError({
              message: `inventory row ${rowId} is not on surface ${kind}`,
            });
        };

        const validateSignature = (signature: string, kinds: readonly InventoryKind[]): void => {
          const observedKinds = signatureKinds.get(signature);

          if (observedKinds === undefined)
            throw new AcceptedIntentAuthorError({
              message: `unknown canonical signature: ${signature}`,
            });

          if (!kinds.some((kind) => observedKinds.has(kind)))
            throw new AcceptedIntentAuthorError({
              message: `canonical signature is not on an allowed surface: ${signature}`,
            });
        };

        const intents = input.intents
          .map((intent) => {
            validateSources(intent.source_ref_ids);

            for (const rowId of intent.row_ids) {
              const row = rows.get(rowId);

              if (row === undefined)
                throw new AcceptedIntentAuthorError({ message: `unknown inventory row: ${rowId}` });

              if (!intent.inventory_kinds.includes(row.kind))
                throw new AcceptedIntentAuthorError({
                  message: `intent ${intent.intent_ref_id} omits inventory kind ${row.kind}`,
                });
            }

            for (const signature of intent.canonical_signatures)
              validateSignature(signature, intent.inventory_kinds);

            const payload = {
              ...intent,
              selected_revision_ref_ids: expectedRevisionRefIds,
              source_ref_ids: sortUnique(intent.source_ref_ids),
              row_ids: sortUnique(intent.row_ids),
              canonical_signatures: sortUnique(intent.canonical_signatures),
              inventory_kinds: sortUnique(intent.inventory_kinds),
              journey_ref_ids: sortUnique(intent.journey_ref_ids),
            };

            return { ...payload, intent_digest: sha256(canonicalJson(payload)) };
          })
          .sort((left, right) => compareByteOrder(left.intent_ref_id, right.intent_ref_id));

        const journeys = input.journeys
          .map((journey) => {
            validateSources(journey.source_ref_ids);

            const payload = {
              ...journey,
              selected_revision_ref_ids: expectedRevisionRefIds,
              source_ref_ids: sortUnique(journey.source_ref_ids),
              steps: journey.steps
                .map((step) => {
                  for (const rowId of step.row_ids) validateRow(rowId, step.surface);

                  for (const signature of step.canonical_signatures)
                    validateSignature(signature, [step.surface]);

                  return {
                    ...step,
                    row_ids: sortUnique(step.row_ids),
                    canonical_signatures: sortUnique(step.canonical_signatures),
                    runtime_evidence_ref_ids: sortUnique(step.runtime_evidence_ref_ids),
                  };
                })
                .sort((left, right) => compareByteOrder(left.step_id, right.step_id)),
            };

            return { ...payload, journey_digest: sha256(canonicalJson(payload)) };
          })
          .sort((left, right) => compareByteOrder(left.journey_ref_id, right.journey_ref_id));

        const registerValue = {
          schema_version: "functional-parity-accepted-intent/v1",
          intents,
          journeys,
        };

        const decoded = tryDecodeAcceptedIntentRegister([registerValue, expectedRevisionRefIds]);

        if (decoded.register === null)
          throw new AcceptedIntentAuthorError({
            message: `generated register is invalid: ${decoded.issues.map((entry) => entry.reasonCode).join(",")}`,
          });

        return { register: decoded.register, expectedRevisionRefIds };
      },
      catch: (cause) =>
        cause instanceof AcceptedIntentAuthorError
          ? cause
          : new AcceptedIntentAuthorError({
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });

    const outputBytes = new TextEncoder().encode(canonicalJson(register));
    yield* Effect.tryPromise({
      try: () => fileSystem.writeBytesPromise(options.outputPath, outputBytes),
      catch: (cause) =>
        new AcceptedIntentAuthorError({ message: `cannot write ${options.outputPath}`, cause }),
    });

    return {
      status: "accepted_intent_written",
      output_path: options.outputPath,
      output_sha256: sha256(outputBytes),
      selected_revision_ref_ids: expectedRevisionRefIds,
      intent_count: register.intents.length,
      journey_count: register.journeys.length,
      step_count: register.journeys.reduce((count, journey) => count + journey.steps.length, 0),
    };
  });

const argValue = (args: readonly string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];

  if (value === undefined || value.startsWith("--"))
    throw new AcceptedIntentAuthorError({ message: `missing ${name}` });

  return value;
};

export const parseIntentAuthorArgs = (args: readonly string[]): AuthorAcceptedIntentOptions => ({
  inputPath: argValue(args, "--input"),
  sourceManifestPath: argValue(args, "--source-manifest"),
  inventoryDirectory: argValue(args, "--inventory-directory"),
  outputPath: argValue(args, "--output"),
});
