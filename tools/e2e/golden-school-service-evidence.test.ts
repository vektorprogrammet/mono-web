import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, Exit, FileSystem, Path, Schema, type Scope, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  goldenRunnerPaths,
  readGoldenEvidence,
  redactedEvidenceJson,
  sha256,
  stageEvidence,
} from "./golden-school-service-evidence";

const UnknownJson = Schema.fromJsonString(Schema.Unknown);

const jsonText = Schema.encodeEffect(UnknownJson);

const Summary = Schema.fromJsonString(Schema.Struct({ passed: Schema.Boolean }));

const root = fileURLToPath(new URL("../../", import.meta.url));

const run = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));

// A partial failed-run receipt exercises diagnostic custody, not journey acceptance.
const diagnostic = Effect.fnUntraced(function* (directory: string, name: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bytes = Buffer.from(text);

  const sources = yield* Effect.forEach(goldenRunnerPaths, (source) =>
    Effect.map(fs.readFile(path.join(root, source)), (content) => ({
      path: source,
      sha256: sha256(content),
    })),
  );

  const artifacts = [{ path: name, sha256: sha256(bytes), bytes: bytes.length }];
  yield* fs.writeFile(path.join(directory, name), bytes);
  yield* fs.writeFileString(
    path.join(directory, "receipt.json"),
    yield* jsonText({
      schema_version: "native-functional-journey/v1",
      journey_ref_id: "intent://golden-school-service",
      mono_revision_ref_id: "rev-diagnostic-fixture",
      source_tree: "diagnostic-fixture",
      clean_source: true,
      environment_kind: "local_disposable",
      required_browser: true,
      result: "failed",
      exit_code: 1,
      runner_sources: sources,
      fixture_digest: "sha256:" + sources[0]!.sha256,
      artifacts,
      artifact_digest: "sha256:" + sha256(yield* jsonText(artifacts)),
    }),
  );
});

const stage = (directory: string, destination: string) =>
  readGoldenEvidence({
    directory,
    root,
    revision: "diagnostic-fixture",
    sourceTree: "diagnostic-fixture",
  }).pipe(Effect.flatMap((evidence) => stageEvidence(evidence, destination)));

test("diagnostic custody rejects encoded credentials before any upload file exists", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "golden-diagnostic-custody-" });

      const cases: ReadonlyArray<readonly [string, string]> = [
        ["evidence.json", '{"authoriz\\u0061tion":"Bearer private-value"}'],
        ["evidence.json", '{"message":"synthetic-school-service-\\u0074oken"}'],
        ["failure.log", "Authorization: [REDACTED]Bearer private-value"],
        ["evidence.json", '{"cookie":" private-value"}'],
        ["failure.log", "DATABASE_PASSWORD=private-value"],
        ["private-trace-1.zip", "unlisted raw trace"],
      ];

      for (const [index, [name, text]] of cases.entries()) {
        const directory = path.join(temporary, String(index));
        const destination = path.join(temporary, String(index) + "-upload");
        yield* fs.makeDirectory(directory);
        yield* fs.makeDirectory(destination);
        yield* diagnostic(directory, name, text);
        expect(Exit.isFailure(yield* Effect.exit(stage(directory, destination)))).toBe(true);
        expect(yield* fs.readDirectory(destination)).toEqual([]);
      }

      const directory = path.join(temporary, "safe");
      const destination = path.join(temporary, "safe-upload");
      yield* fs.makeDirectory(directory);
      yield* fs.makeDirectory(destination);
      const redacted = '{"authorization":"[REDACTED]"}';
      yield* diagnostic(directory, "evidence.json", redacted);
      yield* stage(directory, destination);
      expect(yield* fs.readFileString(path.join(destination, "evidence.json"))).toBe(redacted);
    }),
  ));

test("a setup failure publishes only its failed summary for upload", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "golden-output-custody-" });
      const destination = path.join(temporary, "upload");
      const output = path.join(temporary, "github-output");

      const handle = yield* ChildProcess.make(
        process.execPath,
        ["--no-env-file", path.join(root, "tools/e2e/golden-school-service-ci.mjs"), destination],
        {
          env: { GOLDEN_EXPECTED_REVISION: "not-this-checkout", GITHUB_OUTPUT: output },
          extendEnv: true,
          stdin: "ignore",
        },
      );

      const [, , status] = yield* Effect.all(
        [Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("10 seconds"));

      expect(Number(status)).toBe(1);
      const [header = "", ...lines] = (yield* fs.readFileString(output)).trimEnd().split("\n");
      expect(header.startsWith("artifact_paths<<")).toBe(true);
      expect(lines.pop()).toBe(header.slice("artifact_paths<<".length));
      expect(lines).toEqual([path.join(destination, "ci-summary.json")]);
      expect(
        (yield* Schema.decodeEffect(Summary)(yield* fs.readFileString(lines[0]!))).passed,
      ).toBe(false);
    }),
  ));

test("evidence redaction keeps credential fields and diagnostic text valid JSON", () => {
  const evidence = {
    deliveries: [{ authorization: "Bearer private-value", idempotencyKey: "effect:a,b" }],
    failure: "request failed: cookie=private-value, retrying",
    note: "sent journey-secret-0123456789abcdef",
    absent: { cookie: null },
  };

  expect(
    Schema.decodeSync(UnknownJson)(
      redactedEvidenceJson(["journey-secret-0123456789abcdef"], evidence),
    ),
  ).toEqual({
    deliveries: [{ authorization: "[REDACTED]", idempotencyKey: "effect:a,b" }],
    failure: "request failed: cookie=[REDACTED], retrying",
    note: "sent [REDACTED]",
    absent: { cookie: null },
  });
});
