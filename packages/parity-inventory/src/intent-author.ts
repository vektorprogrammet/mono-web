import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { validateAcceptedIntentAuthoringShape } from "./accepted-intent-schema.js";
import { canonicalJson, compareByteOrder, sha256, sortUnique } from "./canonical.js";
import { tryDecodeAcceptedIntentRegister } from "./coverage.js";
import { assertSafeAcceptedIntentBytes } from "./coverage.js";
import { validateInventory, validateSourceManifest } from "./schema.js";
import type { InventoryEnvelope, InventoryKind, SourceManifest } from "./types.js";

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

const parseJson = (bytes: Uint8Array, label: string): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
};

const readBytes = (path: string): Effect.Effect<Uint8Array, Error> =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => new Error(`cannot read ${path}`, { cause }),
  });

const sourceManifestDigest = (manifest: SourceManifest): string => sha256(canonicalJson(manifest));

const loadInputs = (options: AuthorAcceptedIntentOptions) =>
  Effect.gen(function* () {
    const inputBytes = yield* readBytes(options.inputPath);
    assertSafeAcceptedIntentBytes(inputBytes);
    const input = parseJson(inputBytes, "accepted intent authoring input");
    if (!validateAcceptedIntentAuthoringShape(input))
      throw new Error("accepted intent authoring input is schema-invalid");

    const manifest = parseJson(yield* readBytes(options.sourceManifestPath), "source manifest");
    if (!validateSourceManifest(manifest)) throw new Error("source manifest is schema-invalid");
    const manifestSha256 = sourceManifestDigest(manifest);

    const inventories: InventoryEnvelope[] = [];
    for (const file of INVENTORY_FILES) {
      const inventory = parseJson(yield* readBytes(join(options.inventoryDirectory, file)), file);
      if (!validateInventory(inventory)) throw new Error(`${file} is schema-invalid`);
      if (inventory.source_manifest_sha256 !== manifestSha256)
        throw new Error(`${file} does not derive from the supplied source manifest`);
      inventories.push(inventory);
    }
    return { input, manifest, inventories };
  });

const sortStrings = (values: readonly string[]): string[] => [...values].sort(compareByteOrder);

export const authorAcceptedIntentRegister = (
  options: AuthorAcceptedIntentOptions,
): Effect.Effect<AcceptedIntentAuthorReceipt, Error> =>
  Effect.gen(function* () {
    const { input, manifest, inventories } = yield* loadInputs(options);
    const expectedRevisionRefIds = sortStrings(
      manifest.revisions
        .filter(
          (revision) => revision.repository_ref === "legacy" || revision.repository_ref === "mono",
        )
        .map((revision) => revision.revision_ref_id),
    );
    if (
      canonicalJson(sortStrings(input.selected_revision_ref_ids)) !==
      canonicalJson(expectedRevisionRefIds)
    ) {
      throw new Error("selected revisions do not match the supplied source manifest");
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
        if (!sourceIds.has(id)) throw new Error(`unknown source reference: ${id}`);
    };
    const validateRow = (rowId: string, kind: string): void => {
      const row = rows.get(rowId);
      if (row === undefined) throw new Error(`unknown inventory row: ${rowId}`);
      if (row.kind !== kind) throw new Error(`inventory row ${rowId} is not on surface ${kind}`);
    };
    const validateSignature = (signature: string, kinds: readonly string[]): void => {
      const observedKinds = signatureKinds.get(signature);
      if (observedKinds === undefined) throw new Error(`unknown canonical signature: ${signature}`);
      if (!kinds.some((kind) => observedKinds.has(kind as InventoryKind)))
        throw new Error(`canonical signature is not on an allowed surface: ${signature}`);
    };

    const intents = input.intents
      .map((intent) => {
        validateSources(intent.source_ref_ids);
        for (const rowId of intent.row_ids) {
          const row = rows.get(rowId);
          if (row === undefined) throw new Error(`unknown inventory row: ${rowId}`);
          if (!intent.inventory_kinds.includes(row.kind))
            throw new Error(`intent ${intent.intent_ref_id} omits inventory kind ${row.kind}`);
        }
        for (const signature of intent.canonical_signatures)
          validateSignature(signature, intent.inventory_kinds);
        const payload = {
          ...intent,
          selected_revision_ref_ids: expectedRevisionRefIds,
          source_ref_ids: sortUnique(intent.source_ref_ids),
          row_ids: sortUnique(intent.row_ids),
          canonical_signatures: sortUnique(intent.canonical_signatures),
          inventory_kinds: sortUnique(intent.inventory_kinds) as InventoryKind[],
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

    const registerValue: unknown = {
      schema_version: "functional-parity-accepted-intent/v1",
      intents,
      journeys,
    };
    const decoded = tryDecodeAcceptedIntentRegister(registerValue, expectedRevisionRefIds);
    if (decoded.register === null)
      throw new Error(
        `generated register is invalid: ${decoded.issues.map((entry) => entry.reasonCode).join(",")}`,
      );
    const outputBytes = new TextEncoder().encode(canonicalJson(decoded.register));
    yield* Effect.tryPromise({
      try: () => writeFile(options.outputPath, outputBytes),
      catch: (cause) => new Error(`cannot write ${options.outputPath}`, { cause }),
    });
    return {
      status: "accepted_intent_written",
      output_path: options.outputPath,
      output_sha256: sha256(outputBytes),
      selected_revision_ref_ids: expectedRevisionRefIds,
      intent_count: decoded.register.intents.length,
      journey_count: decoded.register.journeys.length,
      step_count: decoded.register.journeys.reduce(
        (count, journey) => count + journey.steps.length,
        0,
      ),
    };
  });

const argValue = (args: readonly string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
};

export const parseIntentAuthorArgs = (args: readonly string[]): AuthorAcceptedIntentOptions => ({
  inputPath: argValue(args, "--input"),
  sourceManifestPath: argValue(args, "--source-manifest"),
  inventoryDirectory: argValue(args, "--inventory-directory"),
  outputPath: argValue(args, "--output"),
});

if (import.meta.main) {
  Effect.runPromise(authorAcceptedIntentRegister(parseIntentAuthorArgs(process.argv.slice(2))))
    .then((receipt) => process.stdout.write(canonicalJson(receipt)))
    .catch((cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
}
