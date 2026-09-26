[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# tools/e2e

Golden journeys, local journey drivers, and legacy migration commands.
Package `@monoweb/e2e`.

## Entry points

The package has no `exports`, so other packages do not import it.

## Constructs

The shared constructs defined here. [docs/constructs.md](../../docs/constructs.md) lists their consumers.

- [`journeyClock`](journey-clock.ts) (test-harness): A journey clock at a reference instant that the caller pins.
- [`admissionJourneyClock`](journey-clock.ts) (test-harness): The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.
- [`localBackendEnvironment`](local-backend-environment.ts) (test-harness): The environment of a disposable local native backend for one composition.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
