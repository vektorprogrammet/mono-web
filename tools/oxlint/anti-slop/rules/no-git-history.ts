import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// Git commands that walk the commit graph. A depth-1 checkout holds only HEAD, so they fail or
// silently see one commit.
const historyCommands = new Set([
  "annotate",
  "bisect",
  "blame",
  "cherry",
  "describe",
  "log",
  "merge-base",
  "name-rev",
  "reflog",
  "rev-list",
  "shortlog",
  "show-branch",
  "whatchanged",
]);

// Global options that take the next word as their value, such as `git -C <root> <command>`.
const globalOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

// Node and Bun APIs that run a shell command line.
const shellApis = new Set(["exec", "execSync"]);

/**
 * A revision beyond HEAD: an ancestor (`HEAD~1`, `HEAD^`, `HEAD^2`, but not the peel
 * `HEAD^{tree}`), a reflog entry (`@{1}`), a range (`main..HEAD`, `main...HEAD`, which needs a
 * merge base), or a full commit name, which exists only where its history was fetched.
 */
const pastHeadRevision = /(?:HEAD|@)(?:~|\^(?!\{))|@\{|^[\w@^~{}/-]+\.{2,3}[\w@^~{}/-]*$|^[0-9a-f]{40}$/u;

// A callee that wraps Git: `git`, `gitOutput`, `readGitValue`, `runGit`, but not `digits`.
const gitCallee = /^git(?![a-z])|Git(?![a-z])/u;

/** A word of a Git argument list; `null` stands for a word that is not static text. */
type Word = string | null;

function staticText(node: ESTree.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function calleeName(callee: ESTree.Node): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function isGitProgram(word: Word): boolean {
  return word !== null && (word === "git" || word.endsWith("/git"));
}

function words(nodes: ReadonlyArray<ESTree.Node | null>): Array<Word> {
  return nodes.map((node) => staticText(node));
}

/** The words of a shell command line; each interpolation is one non-static word. */
function shellWords(quasis: ReadonlyArray<string>): Array<Word> {
  return quasis.flatMap((text, index) => [
    ...text.split(/\s+/u).filter((word) => word.length > 0),
    ...(index < quasis.length - 1 ? [null] : []),
  ]);
}

function shellText(node: ESTree.Node | undefined): Array<string> | null {
  if (node === undefined) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : null;
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? "");
  return null;
}

/** The history read that a Git argument list (without the program) makes, if any. */
function historyRead(argumentsOfGit: ReadonlyArray<Word>): string | null {
  let command: string | null = null;

  for (let index = 0; index < argumentsOfGit.length; index += 1) {
    const word = argumentsOfGit[index];

    if (word === null || word === undefined) continue;
    // Pathspecs follow `--`; they name files, not revisions.
    if (command !== null && word === "--") return null;
    if (command === null && globalOptionsWithValue.has(word)) {
      index += 1;
      continue;
    }
    if (command === null && !word.startsWith("-")) {
      command = word;
      if (historyCommands.has(word)) return word;
      continue;
    }
    if (command !== null && pastHeadRevision.test(word)) return `${command} ${word}`;
  }

  return null;
}

/**
 * Reject journey code that reads Git history beyond HEAD. Hosted journeys run in a depth-1
 * checkout, so a command that walks the commit graph or names an ancestor, range, or fixed
 * commit fails there while it passes in a full local clone (CI run 36233895862). Bind source
 * identity with `rev-parse HEAD`, `HEAD^{tree}`, or a content digest instead.
 */
export const noGitHistoryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Git commands in journey code that read history beyond HEAD, which a depth-1 checkout lacks.",
    },
    messages: {
      gitHistory:
        "`git {{read}}` reads history beyond HEAD, and hosted journeys run in a depth-1 checkout. Bind the source with `rev-parse HEAD`, `HEAD^{tree}`, or a content digest.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Node, argumentsOfGit: ReadonlyArray<Word>) => {
      const read = historyRead(argumentsOfGit);
      if (read !== null) context.report({ node, messageId: "gitHistory", data: { read } });
    };

    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const [first, second] = node.arguments;

        if (first === undefined) return;

        // exec("git log -1"), execSync(`git -C ${root} merge-base HEAD main`).
        if (name !== null && shellApis.has(name)) {
          const text = shellText(first);
          const shell = text === null ? [] : shellWords(text);
          if (isGitProgram(shell[0] ?? null)) check(first, shell.slice(1));
          return;
        }

        // spawnSync("git", ["log"]), run("git", ["merge-base", "HEAD", base]).
        if (isGitProgram(staticText(first)) && second?.type === "ArrayExpression") {
          check(second, words(second.elements));
          return;
        }

        // A Git wrapper: git("merge-base", a, b), readGitValue(["merge-base", "HEAD", base]).
        if (name === null || !gitCallee.test(name)) return;

        if (first.type === "ArrayExpression") {
          // ["git", ...] is an argument vector, which ArrayExpression checks.
          if (!isGitProgram(staticText(first.elements[0]))) check(first, words(first.elements));
          return;
        }

        check(node, words(node.arguments));
      },
      ArrayExpression(node) {
        // runLocal(["git", "rev-list", "HEAD"]), Bun.spawn(["git", "log"]).
        if (isGitProgram(staticText(node.elements[0]))) check(node, words(node.elements.slice(1)));
      },
      TaggedTemplateExpression(node) {
        // Bun Shell: $`git log -1`.
        const tag = node.tag;
        const shell =
          (tag.type === "Identifier" && tag.name === "$") ||
          (tag.type === "MemberExpression" &&
            !tag.computed &&
            tag.property.type === "Identifier" &&
            tag.property.name === "$");
        if (!shell) return;
        const text = shellWords(node.quasi.quasis.map((quasi) => quasi.value.cooked ?? ""));
        if (isGitProgram(text[0] ?? null)) check(node, text.slice(1));
      },
    };
  },
});
