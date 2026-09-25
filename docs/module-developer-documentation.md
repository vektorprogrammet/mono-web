# Developer module documentation

Status: implementation roadmap. The [Placements guide](../packages/placements/README.md) implements the first pilot.
[STATE.md](../STATE.md#evidence-boundary) records acceptance and remaining work.

## Goal

A developer can use a module without reading its private implementation.
A maintainer can change that implementation without breaking its public contract.
Both readers can identify the owner of a failure and run the relevant checks.

Documentation covers logical capabilities, such as Placements and Recruitment, rather than every helper file.
Small modules need short guides. Complex boundaries need more detail.

## Two readers, one contract

| Reader     | Required answers                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer   | What can I rely on? Which imports can I use? What dependencies and authority must I supply? What can fail?                            |
| Maintainer | How does the module uphold its contract? Where can I change it? Which checks protect the contract? Why do important boundaries exist? |

Consumer guarantees remain stable through internal refactoring.
Implementation explanations change with the implementation.
Neither guide replaces the authoritative business rules or public declarations.

## Module entry point

Each substantive module has one discoverable guide with these sections:

1. **Purpose and ownership:** the capability it owns, its exclusions, and links to related owners.
2. **Use it:** supported imports and a complete runnable example.
3. **Contract:** preconditions, results, failures, authority, and important invariants.
4. **Compose it:** required Services and Layers, configuration, runtime restrictions, and resource ownership.
5. **How it works:** the execution path, state transitions, transaction boundaries, and reasons for important choices.
6. **Change and check it:** common changes, relevant source locations, executable checks, and their evidence limits.

These are sections, not a requirement for six files per module.
The guide links API reference material rather than copying declarations.
It uses a small diagram where a dependency or execution path needs explanation.
It does not narrate each function or list every private table as a public contract.

## Effect contracts

A type signature does not explain all usage requirements.
Documentation for an effectful operation covers:

- Required dependencies and authority, including the meaning of its Effect requirements.
- Typed failures and the action available to the caller.
- Transaction ownership and which facts commit together.
- Retry behavior and whether a retry can repeat an external effect.
- Interruption behavior and its effect on committed work.
- Whether success means committed state, queued delivery, or provider acknowledgement.
- Resource acquisition, release, and supervision ownership.

Pure calculations remain direct functions. Documentation does not introduce a Service without a real dependency or authority boundary.

## Authoritative sources and derivations

| Information             | Authoritative source                                     | Documentation treatment                                         |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Supported imports       | Package export maps                                      | Derive the public entry-point inventory                         |
| Signatures and schemas  | TypeScript declarations                                  | Generate reference material                                     |
| API-specific guarantees | Documentation beside public declarations                 | Render that documentation without maintaining a second copy     |
| HTTP operations         | Existing HTTP API definitions                            | Reuse the OpenAPI document generated from those definitions     |
| Working examples        | Executable TypeScript files                              | Include those exact files, rather than copied code blocks       |
| Business meaning        | [Intended system](system.md)                             | Link the relevant rule instead of restating it                  |
| Architectural ownership | [Architecture](architecture.md#ownership)                | Link the owner and dependency rules                             |
| Architectural rationale | A focused module explanation or existing decision record | Author and review the explanation against actual implementation |
| Delivery status         | [Mission state](../STATE.md)                             | Link acceptance records and unresolved work                     |

Mechanical facts come from source.
Humans author meaning that generation cannot recover reliably.
A generated explanation of intent is not authoritative merely because a tool produced it.

Internal documentation identifies implementation details explicitly.
It does not make private imports or database tables supported integration paths.

## Executable examples

Examples import supported public entry points.
They show the required composition, a meaningful operation, a relevant failure, and an observable result.
Their source files enter the owning TypeScript check explicitly.
A directory outside `src` does not automatically enter an existing package check.

The documentation renders or includes those same source files.
It does not maintain a second handwritten example with equivalent behavior.

Pure examples use the existing lightweight runtime or test tools.
Persistence examples use disposable resources where they claim persistence behavior.
A fake Service can illustrate composition, but it cannot establish transaction or database behavior.

Examples expose no real credentials and perform no external provider actions.
Their commands state required tools, configuration, cleanup, and evidence limits.

## Existing tooling and adoption

The repository already has a documentation entry point, system guides, package export maps, and generated HTTP artifacts.
The [documentation site](../apps/docs/site.ts) renders the repository's Markdown and MDX documents in place with Vocs.
It publishes existing documents; it is not a module reference or example-validation system.
The [HTTP generator](../packages/http-api/scripts/generate-openapi.ts) derives OpenAPI from the contract before each type check, so no committed copy can drift.

The pilot evaluated [Effect docgen](https://github.com/Effect-TS/docgen) before selecting a maintained alternative.
The [guide tool-choice record](../packages/placements/README.md#tool-choice) owns the qualification result and compatibility limits.
Future modules reuse the accepted tooling unless a concrete requirement needs another bounded qualification.
Tool availability alone does not establish compatibility with this repository.

If docgen does not fit, retain executable TypeScript examples and existing compiler/runtime checks.
Evaluate another maintained reference generator only for a concrete unmet requirement.
Publish a module guide by adding it to the documentation site. Do not start another documentation website or a custom compiler-based documentation generator.
Do not import temporary parity tooling into durable product documentation tools.

The [Diataxis framework](https://diataxis.fr/) separates tutorials, task guides, reference material, and explanations.
Use that distinction to keep reader tasks clear, without requiring a separate document for each category.

## First pilot: Placements

[Placements](../packages/placements/package.json) already separates portable `contracts` from the concrete `server` entry point.
Its [service declaration](../packages/placements/src/service.ts) records transaction ownership and precondition callback limits.
The [golden school-service gate](web-system-functional-testing.md#local-school-service-gate) provides real boundary evidence.

The pilot connects these existing sources into one consumer and maintainer guide.
It includes public-import examples, API reference material, a change task, and commands for the relevant checks.
It preserves the distinction between illustrative examples and real PostgreSQL acceptance.

The pilot does not redesign Placements, expand exports, or change business rules to simplify documentation.
It does not duplicate the golden runner or introduce a second acceptance implementation.

## Adopted extensions

The [Placements CI gate](../packages/placements/README.md#ci-and-retained-artifacts) implements the required-check slice locally.
It checks examples, generates one reference, and binds retained output to its clean source revision and file hashes.
Hosted execution and repository protection remain separate acceptance gates.

The [Substitutes guide](../packages/domain/src/substitutes/README.md) applies the same consumer and maintainer structure to the next operational boundary.
It links to an executable public-import example and the continuous coverage journey.
The generated API reference remains scoped to Placements. No second generator or documentation website is introduced.

The [Receipt guide](../packages/domain/src/receipt/README.md) extends the same pattern to claims, approval, settlement evidence, private files, and recovery.
Its [public-import example](../packages/domain/examples/receipt.ts) runs pure decisions and public encoding, not persistence or delivery.
The domain compiler includes the example. The continuous reimbursement gate supplies separate native runtime evidence.

## Acceptance

The pilot is complete only when all conditions hold:

1. A developer can find the guide from the repository documentation entry point.
2. Public imports in examples resolve without private source paths.
3. Examples type-check and run with the declared tools and isolated resources.
4. Reference material derives from supported exports and source documentation.
5. Generated material has an executable freshness check.
6. Local links and source references resolve.
7. Authority, transaction, retry, interruption, and lifecycle guarantees have explicit explanations where applicable.
8. A developer unfamiliar with the module can complete one use task and one bounded change task.
9. The acceptance record distinguishes automated checks from observed reader tasks.
10. The checks reject a broken public import, an invalid example, or stale generated output.

An independent developer or agent can perform the reader tasks.
The report identifies which kind of reader performed them.
Automated checks catch drift, but they do not prove semantic prose correct.
Review compares important explanations with implementation and behavioral evidence.

## Development sequence

| Slice                  | Deliverable                                                                        | Acceptance                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A: Placements pilot    | Consumer guide, maintainer guide, public-import examples, and reference generation | The pilot acceptance conditions hold                                 |
| B: Required checks     | Documentation checks in existing credential-free CI                                | Broken examples and stale reference material fail the required check |
| C: Capability coverage | Apply the accepted pattern to Recruitment, Identity, Receipts, and the SDK         | Each capability passes its own bounded contract                      |

Each slice receives its own implementation specification.
The roadmap does not authorize one repository-wide documentation rewrite.
Pilot findings determine which tooling and structure later modules reuse.

## Parallel workstream boundary

The E2E and documentation workstreams start from the same accepted source, in separate Git worktrees.
The [functional testing roadmap](web-system-functional-testing.md#development-sequence) owns the E2E sequence.
This document owns the documentation sequence.

Documentation can reference the accepted golden command without waiting for its CI integration.
E2E work does not depend on documentation generator adoption.
Neither branch changes the other branch's active specification or private tooling.

Each branch owns its specification and bounded implementation files.
Shared manifests, lockfiles, CI entry points, navigation, and mission state require an integration handoff.
Each author declares a shared-file change before making it.
The integrating owner resolves those changes and checks the combined committed artifact.

One heavy job runs at a time across both workstreams on this machine.
Read-only research and lightweight checks can run concurrently.
Neither workstream uses the operator's demonstration resources or gains deployment authority.
