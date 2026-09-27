[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# tools/e2e

Golden journeys, local journey drivers, and legacy migration commands.
Package `@monoweb/e2e`.

## Entry points

The package has no `exports`, so other packages do not import it.

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../docs/constructs.md) indexes them all.

- [`journeyClock`](../../docs/constructs/test-harness.md#journeyclock) (test-harness): A journey clock at a reference instant that the caller pins.
- [`admissionJourneyClock`](../../docs/constructs/test-harness.md#admissionjourneyclock) (test-harness): The backend's admission clock: ADMISSION_FIXED_NOW when the runner pins one, otherwise the current time.
- [`localBackendEnvironment`](../../docs/constructs/test-harness.md#localbackendenvironment) (test-harness): The environment of a disposable local native backend for one composition.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
