# Effect exceptions

A site that cannot follow an Effect rule is an exception with a lifecycle (FX012).
[docs/effect-exceptions.json](../../../../docs/effect-exceptions.json) registers each one.
`just exceptions` checks the registry against the tree. The pre-commit hook, `just check`, and the Checks workflow run it.
[tools/conventions/src/exceptions.ts](../../../../tools/conventions/src/exceptions.ts) is the check.

## What needs an entry

- A disable comment, `oxlint-disable` or `eslint-disable` in any form, that names a rule of `effecttsgo`, `effect`, or `anti-slop-effect`. A disable comment that names no rule fails, because it suppresses every rule.
- An allow directive of the Oxlint Effect plugin, `oxlint-effect-plugin allow(<rule>)`, which suppresses the `effect/<rule>` that it names. The plugin accepts only `no-ambient-console` with a `dev only:` reason.
- A leaking-requirements expectation: `@effect-expect-leaking` or `@effect-leakable-service` in a JSDoc block.
- An `@effect-diagnostics` or `@effect-diagnostics-next-line` directive that lowers a rule.
- A non-native substitute without a suppression, such as a Promise bridge or another package where Effect has the construct. Name the id in a comment at the site.

`oxlint.config.ts` also turns some Effect rules off for listed files, with the reason beside each override. The registry does not cover those overrides.

## Before you add one

Establish that no native form serves, in this order: an Effect construct, a composition of constructs, a small construct built from Effect, a boundary adapter. Search the installed guidance and source for the capability first (`effect-first`).
Unfamiliarity is not a missing capability. A performance concern needs a measured, unmet requirement (FX016).

## The entry

| Field                | Holds                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`                 | `EX-` and four digits: the next free number. Never reuse one.                                          |
| `rules`              | At least one FX rule that the sites depart from, and every tool rule that the sites suppress.          |
| `scope`              | `files`: each file with a site. `symbols`: the declarations at the sites.                              |
| `reason`             | Why the site needs the form that it has.                                                               |
| `missingCapability`  | What the native form lacks in the examined version, or "None in Effect" and why the requirement stays. |
| `nativeAlternatives` | Each native form examined, and why it does not serve.                                                  |
| `verification`       | The tests, journeys, and checks that cover the sites, and what no test covers.                         |
| `owner`              | The module, a directory with an `AGENTS.md` guide, that holds every file of the scope.                 |
| `examinedWith`       | Each package whose capability the entry depends on, with the version that `package.json` pins.         |
| `retirementTrigger`  | The change that retires the entry, and what to do then.                                                |

## At the site

- Disable comment: `// oxlint-disable-next-line <rule> -- EX-NNNN: <reason>`.
- Allow directive of the Oxlint Effect plugin: the id after `dev only:`, as in `// oxlint-effect-plugin allow(no-ambient-console): dev only: EX-NNNN: <reason>`.
- JSDoc expectation: name the id in the same JSDoc block, before the tag. The tag reads the rest of its text as service names.
- Diagnostics directive or substitute: name the id in the same comment.

## What the check rejects

- A suppression that names no registered id, or a rule that its entry does not list.
- An id that the registry does not have, or whose entry does not list the file.
- A disable comment that names no rule.
- An entry without an FX rule, with a tool rule that no site suppresses, with a file or symbol that is gone, with a file where no comment names it, or with a file outside its owner.
- An entry whose `examinedWith` version differs from the version that `package.json` pins. An upgrade reopens the entry: examine the capability in the new version, then update the version or retire the entry.

## Retire an entry

When the trigger arrives, replace each site with the native form, remove the suppressions, and delete the entry. Keep its id unused.
