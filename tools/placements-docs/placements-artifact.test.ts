import { expect, test } from "bun:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Clock, Duration, Effect, Exit, Fiber, FileSystem, Option, Path, Schema, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  acceptArtifact,
  git,
  inventory,
  outsideOutput,
  publicFile,
  readPublicSource,
  ReceiptJson,
  receiptName,
} from "./placements-artifact.js";
import { runDocumentationCommand } from "./placements-process.js";
import { PlacementsDocsPlatform } from "./placements.js";

const run = <A, E>(effect: Effect.Effect<A, E, PlacementsDocsPlatform | Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(PlacementsDocsPlatform)));

const temporaryDirectory = Effect.fnUntraced(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

// Whether a process with this id exists; ESRCH means that it does not.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const killQuietly = (pid: number | undefined) =>
  Effect.sync(() => {
    if (pid === undefined) return;

    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has exited.
    }
  });

const waitForPid = Effect.fnUntraced(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const deadline = (yield* Clock.currentTimeMillis) + 3000;

  do {
    const text = yield* Effect.option(fileSystem.readFileString(file));

    if (Option.isSome(text) && text.value !== "") return Number(text.value);

    yield* Effect.sleep(Duration.millis(20));
  } while ((yield* Clock.currentTimeMillis) < deadline);

  return yield* Effect.die("Documentation process fixture did not start");
});

const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

test("interruption stops a subprocess that ignores TERM", () =>
  run(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const temporary = yield* temporaryDirectory("placements-process-test-");
      const pidFile = path.resolve(temporary, "pid");
      const program = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${jsonString(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

      const running = yield* Effect.forkChild(
        runDocumentationCommand({ command: "node", args: ["-e", program], cwd: temporary }),
      );

      const pid = yield* waitForPid(pidFile);

      yield* Effect.addFinalizer(() => killQuietly(pid));

      const exit = yield* Fiber.interrupt(running).pipe(Effect.andThen(Fiber.await(running)));

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(alive(pid)).toBe(false);
    }),
  ), 8000);

test("leader failure preserves its exit code and stops TERM-ignoring descendants", () =>
  run(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const temporary = yield* temporaryDirectory("placements-process-test-");
      const pidFile = path.resolve(temporary, "pid");
      const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${jsonString(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${jsonString(descendant)}], {stdio: "ignore"}).unref(); const timer = setInterval(() => { if(require("node:fs").existsSync(${jsonString(pidFile)})) process.exit(7); }, 10);`;

      const failure = yield* Effect.flip(
        runDocumentationCommand({ command: "node", args: ["-e", leader], cwd: temporary }),
      );

      expect(failure.exitCode).toBe(7);

      const pid = yield* waitForPid(pidFile);

      yield* Effect.addFinalizer(() => killQuietly(pid));

      expect(alive(pid)).toBe(false);
    }),
  ), 8000);

interface Fixture {
  readonly root: string;
  readonly output: string;
  readonly revision: string;
  readonly temporary: string;
}

const commitAs = ["-c", "user.name=Documentation test", "-c", "user.email=docs@example.invalid"];

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* temporaryDirectory("placements-artifact-test-");
  const root = path.resolve(temporary, "source");
  const output = path.resolve(temporary, "output");

  yield* fileSystem.makeDirectory(root);
  yield* fileSystem.makeDirectory(output);
  yield* git(root, "init", "--quiet");
  yield* fileSystem.writeFileString(path.resolve(root, "guide.md"), "Public guide\n");
  yield* git(root, "add", "guide.md");
  yield* git(root, ...commitAs, "commit", "--quiet", "-m", "source");

  const revision = yield* git(root, "rev-parse", "HEAD");

  yield* fileSystem.writeFileString(path.resolve(output, "index.html"), "<h1>Public reference</h1>");
  yield* fileSystem.makeDirectory(path.resolve(output, "media"));
  yield* fileSystem.writeFileString(path.resolve(output, "media/guide.md"), "Public guide\n");

  yield* fileSystem.writeFileString(
    path.resolve(output, receiptName),
    yield* Schema.encodeEffect(ReceiptJson)({
      format: 1,
      status: "complete",
      revision,
      sourceUrl: `https://github.com/vektorprogrammet/mono-web/blob/${revision}/{path}#L{line}`,
      files: yield* inventory(output),
    }),
  );

  return { root, output, revision, temporary } satisfies Fixture;
});

const rejects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => expect(Exit.isFailure(exit)).toBe(true));

test("a retained artifact rejects changed copied media, missing output, and extra files", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, output, revision } = yield* fixture;
      const accept = acceptArtifact({ root, output, expected: revision });

      yield* accept;
      yield* fileSystem.writeFileString(path.resolve(output, "media/guide.md"), "Changed public guide\n");
      yield* rejects(accept);
      yield* fileSystem.writeFileString(path.resolve(output, "media/guide.md"), "Public guide\n");
      yield* fileSystem.writeFileString(path.resolve(output, "__proto__"), "Unreviewed content");
      yield* rejects(accept);
      yield* fileSystem.remove(path.resolve(output, "__proto__"));
      yield* fileSystem.remove(path.resolve(output, "index.html"));
      yield* rejects(accept);
    }),
  ));

test("a retained artifact rejects dirty source and a newer clean public guide revision", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, output, revision } = yield* fixture;

      yield* fileSystem.writeFileString(path.resolve(root, "guide.md"), "Changed public guide\n");
      yield* rejects(acceptArtifact({ root, output, expected: revision }));
      yield* git(root, "add", "guide.md");
      yield* git(root, ...commitAs, "commit", "--quiet", "-m", "changed guide");

      const changed = yield* git(root, "rev-parse", "HEAD");

      yield* rejects(acceptArtifact({ root, output, expected: changed }));
      yield* rejects(acceptArtifact({ root, output, expected: revision }));
    }),
  ));

test("missing and incomplete receipts cannot authorize consumption", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, output, revision } = yield* fixture;
      const receiptFile = path.resolve(output, receiptName);

      const receipt = yield* fileSystem
        .readFileString(receiptFile)
        .pipe(Effect.flatMap(Schema.decodeEffect(ReceiptJson)));

      yield* fileSystem.writeFileString(
        receiptFile,
        yield* Schema.encodeEffect(ReceiptJson)({ ...receipt, status: "interrupted" }),
      );

      yield* rejects(acceptArtifact({ root, output, expected: revision }));
      yield* fileSystem.remove(receiptFile);
      yield* rejects(acceptArtifact({ root, output, expected: revision }));
      yield* rejects(acceptArtifact({ root, output, expected: undefined }));
    }),
  ));

test("symlinks cannot substitute artifact files, public inputs, or output parents", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, output, revision, temporary } = yield* fixture;

      yield* fileSystem.remove(path.resolve(output, "media/guide.md"));
      yield* fileSystem.symlink(path.resolve(root, "guide.md"), path.resolve(output, "media/guide.md"));
      yield* rejects(acceptArtifact({ root, output, expected: revision }));
      yield* fileSystem.symlink(path.resolve(root, "guide.md"), path.resolve(root, "linked.md"));

      const source = yield* readPublicSource({ root, tracked: ["linked.md"] });

      expect(() => publicFile(source, path.resolve(root, "linked.md"))).toThrow(
        "must not traverse a symlink",
      );

      yield* fileSystem.symlink(root, path.resolve(temporary, "alias"));
      yield* rejects(outsideOutput({ root, destination: path.resolve(temporary, "alias/generated") }));
      yield* rejects(outsideOutput({ root, destination: temporary }));
    }),
  ));

test("generated API source links resolve to actual repository source", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const temporary = yield* temporaryDirectory("placements-source-link-test-");
      const output = path.resolve(temporary, "guide");

      const rendered = yield* spawner
        .exitCode(
          ChildProcess.make(
            process.execPath,
            ["--no-env-file", "tools/placements-docs/placements.ts", "generate", output],
            { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
          ),
        )
        .pipe(Effect.timeout(Duration.seconds(30)));

      expect(Number(rendered)).toBe(0);

      const links = new Set<string>();

      for (const file of Object.keys(yield* inventory(output)).filter((file) =>
        file.endsWith(".html"),
      )) {
        const html = yield* fileSystem.readFile(path.resolve(output, file));

        yield* Effect.promise(() =>
          new HTMLRewriter()
            .on("a[href]", {
              element(element) {
                const href = element.getAttribute("href");

                if (href?.startsWith("file:") === true) links.add(href);
              },
            })
            .transform(new Response(html))
            .arrayBuffer(),
        );
      }

      expect(
        [...links].some((href) => href.includes("/packages/domain/src/placements/service.ts#L")),
      ).toBe(true);

      for (const href of links) {
        const url = new URL(href);
        const line = Number(url.hash.slice(2));
        const source = yield* fileSystem.readFileString(fileURLToPath(url));

        expect(Number.isInteger(line) && line > 0 && line <= source.split("\n").length).toBe(true);
      }
    }),
  ), 40000);
