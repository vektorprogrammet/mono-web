[//]: # "generated from content/specs/land-installs-0927.mdx by just docs generate; do not edit"

# Land gate checks the merged tree's own dependencies

Why just land could not merge a branch that changed package.json, and the design that fixes it.

# Land gate checks the merged tree's own dependencies

Status: design frozen, no code written yet. Remove this specification once `tools/scripts/land.ts`,
`devenv.nix`, and `tools/scripts/tests/land.test.ts` implement it and `AGENTS.md` reflects it.

## Goal

`just land <branch>` must check the merged tree against dependencies installed from the merged
tree's own `bun.lock`/`package.json`, and must leave main's checkout and its `node_modules`
consistent with main's own `bun.lock` no matter how the land ends (clean landing, a failed check,
a conflict, or an interrupted process). A frozen install (`bun install --frozen-lockfile`) must
fail loudly when `bun.lock` does not satisfy `package.json`.

## Bug

`merge-full` (`devenv.nix`) runs `just check --concurrency=1 && just test --concurrency=1` on the
pre-merge-commit worktree but never installs. A branch that changes `package.json`/`bun.lock` is
gated against main's stale `node_modules`. Observed: landing `docs/fumadocs-integration-0927`
(adds `yaml` 2.9.1, rewrites `bun.lock`) aborted with `Cannot find package 'yaml'` in `just layout`.

## Decision: (b), a temporary detached worktree, not (a) a same-checkout reinstall

Chosen: `land.ts` builds and verifies the merge in a **temporary detached worktree** created from
main's current tip, then lands into main only as a fast-forward of the exact commit it already
verified there. Rejected: (a) running `bun install --frozen-lockfile` directly in main's checkout
before `check`/`test`, with a reinstall in `land.ts` after an aborted merge to restore main.

Why (b) has fewer ways to leave main or its `node_modules` inconsistent:

- Under (a), main sits in a "merge in progress" state for the entire duration of `check`/`test`
  (potentially many minutes: full test suite, lint, type check). Any interruption in that long
  window (SIGKILL, an unrelated crash) leaves main mid-merge with `node_modules` already mutated
  to match the _merged_ tree, while `git merge --abort` only restores _tracked_ files (`bun.lock`,
  `package.json`) to main's old state — `node_modules` is untracked, so it is not restored. (a)'s
  own proposal papers over exactly this with a second explicit reinstall after abort, i.e. it
  needs a remedy because the defect is representable.
- Under (b), main is **never modified** until after the merge, the install, and the full
  `check`/`test` have already succeeded once, in a disposable worktree. The only operation that
  ever touches main is `git merge --ff-only <verified-sha>` (a ref update to a commit that is
  known to be a genuine fast-forward from main's tip — no working-tree merge algorithm runs there,
  and per `githooks(5)`, a fast-forward never invokes `pre-merge-commit`). If the verification
  fails or is interrupted, only the disposable worktree is damaged; it is discarded and main was
  untouched the whole time — the "restore main's dependencies after an aborted merge" step (a)
  needs is unnecessary by construction, not by a second remedy.
- Because hooks are shared across all linked worktrees of one repository (they live in the common
  `.git` dir, not per-worktree), merging in the temporary worktree still runs the exact same
  `pre-merge-commit` hooks (`hook-config-current-merge`, `check-merge-conflicts`, `merge-full`) as
  merging in main would. Fixing `merge-full` itself (adding the install before check/test) is
  still required and benefits any merge commit made directly on main by someone bypassing
  `land.ts` — belt and suspenders, not a duplicate mechanism.
- The only step (b) still performs directly in main after landing is a sync install
  (`bun install --frozen-lockfile`, gated on `bun.lock` existing) so main's own checkout stays
  usable, since a fast-forward does not invoke any hook that would do it. If that sync install is
  interrupted, main's ref has already correctly landed (git-level success), and the state left
  behind is "needs `bun install`" — the same idempotent, always-safe-to-rerun state as a fresh
  clone before its first install — not a torn state between `bun.lock` and `package.json`.

The `merge-full` hook does **not** re-run `just check`/`just test` a second time on the same
tree during a normal `just land`: `land.ts`'s own fast-forward of the already-verified commit into
main cannot invoke `pre-merge-commit` at all (fast-forwards don't fire it), so there is nothing to
skip by special-casing — the non-repetition falls out of using `--ff-only`, not an env flag the
hook has to trust.

## Concrete plan (not yet implemented)

1. `devenv.nix`, `merge-full` hook: prepend `bun install --frozen-lockfile &&` to its entry, so
   `bash -c 'bun install --frozen-lockfile && just check --concurrency=1 && just test --concurrency=1'`.
   This is required regardless of (a)/(b): it is what actually installs the merged tree's own
   dependencies wherever the merge happens (main directly, or the temporary worktree).
2. `tools/scripts/land.ts`, in the `else` branch that currently does
   `git merge --no-ff --no-edit branch` directly in main:
   - `beforeFull = read("rev-parse", "main")`.
   - Create `tempDir = mkdtempSync(join(tmpdir(), "land-verify-"))`.
   - `git("worktree", "add", "--detach", tempDir, beforeFull)`.
   - Attempt `spawnSync("git", ["-C", tempDir, "merge", "--no-ff", "--no-edit", branch], { stdio: "inherit" })`.
     - On failure: if `git -C tempDir rev-parse --verify --quiet MERGE_HEAD` succeeds, run
       `git -C tempDir merge --abort`; always `git worktree remove --force tempDir` after; `fail`
       with the existing message ("The merge of ... stopped and was aborted. main is unchanged at
       ..."). Main is untouched the entire time — no separate abort path in main needed.
   - On success: `verifiedSha = read("-C", tempDir, "rev-parse", "HEAD")`.
   - Land: `spawnSync("git", ["merge", "--ff-only", verifiedSha], { stdio: "inherit" })` in main
     (default cwd). If this fails (main changed concurrently — should not happen under the
     single-writer-per-worktree convention), `fail` with a clear message naming `verifiedSha`.
   - `git("worktree", "remove", "--force", tempDir)`; `fail` if removal fails, same style as the
     existing branch-worktree-removal failure (land already succeeded at this point, so this is
     reported, not treated as land having failed).
   - If `existsSync(join(process.cwd(), "bun.lock"))`, run
     `spawnSync("bun", ["install", "--frozen-lockfile"], { stdio: "inherit" })` in main to sync
     `node_modules` to the now-landed `bun.lock`; on failure, print a clear remediation message
     (`main landed at <sha>; node_modules needs bun install --frozen-lockfile`) and exit 1 — this
     does not undo the already-successful git-level land.
   - `how = "merge commit"` unchanged.
3. `tools/scripts/tests/land.test.ts`: add, following the existing fixture style (a fabricated
   `main`+`feature` repo pair, a hand-written `.git/hooks/pre-merge-commit` script — hooks are
   shared across worktrees so a script installed once covers both main and the temporary worktree):
   - A fixture repo whose base commit carries a `package.json`, a `bun.lock` with no dependencies,
     and a tracked local package `local-dep/` (its own minimal `package.json` + `index.js`) so a
     `file:./local-dep` dependency installs fully offline, no network.
   - **Red** (proves the hook itself must gain the install step, not just land.ts's worktree
     restructuring): feature branch adds the `local-dep` dependency to `package.json`, regenerates
     `bun.lock` to match, and adds `index.ts` importing and using it. `pre-merge-commit` is today's
     exact hook shape, `bun run index.ts` with no install first. Landing fails (`Cannot find
package`), main unchanged, `existsSync(join(main, "node_modules"))` is `false`.
   - **Green** (the fix): identical branch, `pre-merge-commit` now does
     `bun install --frozen-lockfile && bun run index.ts` (mirrors the fixed `merge-full`). Landing
     succeeds; assert `git rev-list --parents` on main same as the existing fast-forward test.
   - **Negative control**: feature branch's `bun.lock` is inconsistent with its `package.json`
     (e.g. `package.json` gains a dependency `bun.lock` does not list). With the fixed hook,
     landing fails specifically at the frozen install (assert on the frozen-lockfile failure, not
     a generic non-zero), main unchanged.
   - **Consistency after abort**: reusing the red or negative-control scenario, assert
     `existsSync(join(main, "node_modules"))` is `false` after the aborted land — main's
     `node_modules` was never touched because `land.ts` never runs any install in main until after
     a verified fast-forward.
4. `AGENTS.md`, the landing paragraph (one sentence): note that `just land` verifies the merge,
   including installing its own dependencies, in a temporary worktree before fast-forwarding main,
   so a failed or interrupted land never leaves main's checkout or `node_modules` inconsistent.
5. Run `bun test tools/scripts/tests/land.test.ts` directly (fast, no heavy lock needed — these are
   plain git/bun operations, not `just check`/`just test`), then `just measure --class ... -- just
check --concurrency=1` per the assignment before the final commit.

## Not yet done

No code has been written. `devenv shell -- true` has been run once in this worktree
(`../mono-web-land-installs`), so hooks are installed and current. Nothing else is committed.
