# Design spec 0026 - Effect property-testing foundation

## Metadata

| Field           | Value                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Goal            | Add generated checks for migration invariants                                                                  |
| Lifecycle state | Building — implementation, workspace gates, and the real local interview journey pass; no one-to-one PR exists |
| Dependency      | 0023 integration baseline and current 0024 collector line                                                      |
| Scope           | SDK boundaries, tutor domain transitions, and Foldkit interview updates                                        |

## User journey

A maintainer changes a migration contract. The affected package test generates varied valid and invalid inputs. The test reports the seed and shrunk counterexample when an invariant fails.

## Goal

Use Effect v4 schema generators and fast-check to test invariants across the migration stack.

The first slice covers these boundaries:

1. Legacy API values decode to canonical SDK values and encode without information loss.
2. Tutor commands preserve stream, idempotency, and terminal-state invariants.
3. Foldkit interview messages preserve the model schema and command guards.

## Constraints

- Pin `@effect/vitest` and `fast-check` through the root catalog.
- Use the installed Effect v4 release as the schema authority.
- Use `Schema.toArbitrary` for schema-derived values.
- Use explicit arbitraries only for values that come from a legacy or browser boundary.
- Use deterministic seeds in committed tests.
- Keep the number of runs bounded.
- Do not replace real browser, HTTP, or database journeys with generated unit tests.
- Do not claim that generated tests prove complete parity.
- Keep failures reproducible from the reported seed and path.

## Properties

### SDK boundary

- Every legacy application status code decodes and encodes to the same code.
- Every legacy interview status code decodes and encodes to the same code.
- Every schema-generated transport payload survives an encode and decode cycle when the schema supports both directions.
- Unknown legacy status codes fail closed.

### Tutor domain

- Every schema-generated score set can complete an accepted interview stream.
- An accepted command appends one event and one receipt.
- Repeating the same command returns the same observation bytes and does not change state.
- Reusing a command ID with a different body fails with `DUPLICATE_COMMAND_CONFLICT`.
- A stale expected version never changes the input state.

### Foldkit interview update

- Every schema-generated valid model and message pair returns a model that satisfies `Model`.
- A submit message cannot emit a scheduling command without a selected interview and valid fields.
- A pending scheduling or acceptance operation suppresses duplicate commands.
- A department or semester change clears the selected interview.

## Falsifiers

The slice fails if one of these observations occurs:

- A status transform maps two distinct legacy values to the same encoded value.
- An SDK round trip changes an observable field.
- A duplicate tutor command changes state or observation bytes.
- A rejected tutor command changes state.
- A Foldkit update returns a value outside `Model`.
- A guarded submit emits a duplicate or unauthorized command.
- A property uses unbounded runs or a random seed that cannot be replayed.

## Definition of done

1. The root catalog contains one pinned version for each property-testing dependency.
2. The SDK package runs the status and schema properties.
3. The domain package runs the tutor transition properties.
4. The dashboard package runs the Foldkit update properties.
5. Each property uses a fixed seed and a bounded run count.
6. The focused property suites pass.
7. The affected package type checks, lint checks, builds, and tests pass.
8. The existing real tutor and dashboard journeys still run.

## Evidence boundary

These tests provide sampled evidence for stated invariants. They do not prove all inputs, real provider behavior, browser behavior, SQL behavior, or functional parity.
