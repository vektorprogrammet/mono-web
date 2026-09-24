import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  acceptArtifact,
  git,
  inventory,
  outsideOutput,
  publicFile,
  receiptName,
} from "./placements-artifact.mjs";
import { runDocumentationCommand } from "./placements-process.mjs";
import { setTimeout } from "node:timers/promises";

async function waitForPid(path) {
  const deadline = Date.now() + 3000;

  do {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await setTimeout(20);
  } while (Date.now() < deadline);

  throw new Error("Documentation process fixture did not start");
}

test("interruption stops a subprocess that ignores TERM", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "placements-process-test-"));
  const controller = new AbortController();
  const pidFile = resolve(temporary, "pid");
  const reason = new Error("requested interruption");
  const program = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  let pid;
  const running = runDocumentationCommand("node", ["-e", program], temporary, controller.signal);

  const result = running.then(
    () => undefined,
    (error) => error,
  );

  try {
    pid = await waitForPid(pidFile);
    controller.abort(reason);
    assert.equal(await result, reason);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort(reason);
    await result;

    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    await rm(temporary, { recursive: true, force: true });
  }
}, 8000);

test("leader failure preserves its exit code and stops TERM-ignoring descendants", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "placements-process-test-"));
  const pidFile = resolve(temporary, "pid");
  const descendant = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"}).unref(); const timer = setInterval(() => { if(require("node:fs").existsSync(${JSON.stringify(pidFile)})) process.exit(7); }, 10);`;
  let pid;

  try {
    const result = await runDocumentationCommand(
      "node",
      ["-e", leader],
      temporary,
      new AbortController().signal,
    ).then(
      () => undefined,
      (error) => error,
    );

    assert.equal(result.actual, 7);
    pid = await waitForPid(pidFile);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    await rm(temporary, { recursive: true, force: true });
  }
}, 8000);

async function fixture(run) {
  const temporary = await mkdtemp(resolve(tmpdir(), "placements-artifact-test-"));
  const root = resolve(temporary, "source");
  const output = resolve(temporary, "output");

  try {
    await mkdir(root);
    await mkdir(output);
    git(root, "init", "--quiet");
    await writeFile(resolve(root, "guide.md"), "Public guide\n");
    git(root, "add", "guide.md");
    git(
      root,
      "-c",
      "user.name=Documentation test",
      "-c",
      "user.email=docs@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "source",
    );
    const revision = git(root, "rev-parse", "HEAD");
    await writeFile(resolve(output, "index.html"), "<h1>Public reference</h1>");
    await mkdir(resolve(output, "media"));
    await writeFile(resolve(output, "media/guide.md"), "Public guide\n");
    await writeFile(
      resolve(output, receiptName),
      JSON.stringify({
        format: 1,
        status: "complete",
        revision,
        sourceUrl: `https://github.com/vektorprogrammet/mono-web/blob/${revision}/{path}#L{line}`,
        files: await inventory(output),
      }),
    );
    await run({ root, output, revision, temporary });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("a retained artifact rejects changed copied media, missing output, and extra files", () =>
  fixture(async ({ root, output, revision }) => {
    await acceptArtifact(root, output, revision);
    await writeFile(resolve(output, "media/guide.md"), "Changed public guide\n");
    await assert.rejects(acceptArtifact(root, output, revision));
    await writeFile(resolve(output, "media/guide.md"), "Public guide\n");
    await writeFile(resolve(output, "__proto__"), "Unreviewed content");
    await assert.rejects(acceptArtifact(root, output, revision));
    await rm(resolve(output, "__proto__"));
    await rm(resolve(output, "index.html"));
    await assert.rejects(acceptArtifact(root, output, revision));
  }));

test("a retained artifact rejects dirty source and a newer clean public guide revision", () =>
  fixture(async ({ root, output, revision }) => {
    await writeFile(resolve(root, "guide.md"), "Changed public guide\n");
    await assert.rejects(acceptArtifact(root, output, revision));
    git(root, "add", "guide.md");
    git(
      root,
      "-c",
      "user.name=Documentation test",
      "-c",
      "user.email=docs@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "changed guide",
    );
    const changed = git(root, "rev-parse", "HEAD");
    await assert.rejects(acceptArtifact(root, output, changed));
    await assert.rejects(acceptArtifact(root, output, revision));
  }));

test("missing and incomplete receipts cannot authorize consumption", () =>
  fixture(async ({ root, output, revision }) => {
    const receipt = JSON.parse(await readFile(resolve(output, receiptName), "utf8"));
    await writeFile(
      resolve(output, receiptName),
      JSON.stringify({ ...receipt, status: "interrupted" }),
    );
    await assert.rejects(acceptArtifact(root, output, revision));
    await rm(resolve(output, receiptName));
    await assert.rejects(acceptArtifact(root, output, revision));
    await assert.rejects(acceptArtifact(root, output, undefined));
  }));

test("symlinks cannot substitute artifact files, public inputs, or output parents", () =>
  fixture(async ({ root, output, revision, temporary }) => {
    await rm(resolve(output, "media/guide.md"));
    await symlink(resolve(root, "guide.md"), resolve(output, "media/guide.md"));
    await assert.rejects(acceptArtifact(root, output, revision));
    await symlink(resolve(root, "guide.md"), resolve(root, "linked.md"));
    assert.throws(() => publicFile(root, new Set(["linked.md"]), resolve(root, "linked.md")));
    await symlink(root, resolve(temporary, "alias"));
    await assert.rejects(outsideOutput(root, resolve(temporary, "alias/generated")));
    await assert.rejects(outsideOutput(root, temporary));
  }));

test("generated API source links resolve to actual repository source", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temporary = await mkdtemp(resolve(tmpdir(), "placements-source-link-test-"));
  const output = resolve(temporary, "guide");

  try {
    const rendered = spawnSync(
      process.execPath,
      ["--no-env-file", "tools/system-guide/placements.ts", "generate", output],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );

    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    const links = new Set();

    for (const path of Object.keys(await inventory(output)).filter((path) =>
      path.endsWith(".html"),
    )) {
      await new HTMLRewriter()
        .on("a[href]", {
          element(element) {
            const href = element.getAttribute("href");

            if (href?.startsWith("file:")) links.add(href);
          },
        })
        .transform(new Response(await readFile(resolve(output, path))))
        .arrayBuffer();
    }

    assert(
      [...links].some((href) => href.includes("/packages/placements/src/service.ts#L")),
      "The public service has no source link",
    );

    for (const href of links) {
      const url = new URL(href);
      const line = Number(url.hash.slice(2));
      const source = await readFile(fileURLToPath(url), "utf8");
      assert(
        Number.isInteger(line) && line > 0 && line <= source.split("\n").length,
        "Source link points outside its file",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 40000);
