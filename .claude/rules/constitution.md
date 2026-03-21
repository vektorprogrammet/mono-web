# Monoweb Project Conventions

## Available Skills

When working on PHP code in `apps/server/`, invoke the relevant skill:

- `php-conventions` — DDD patterns, Doctrine entities, Symfony DI, API Platform, PHP 8.5 style
- `symfony-testing` — test commands, base classes, known issues, OOM workarounds
- `ddd-namespace-migration` — moving files between namespaces, updating references

## SDK Conventions

When working on `packages/sdk/`:

- Domain methods speak the ubiquitous language: `approve()` not `updateStatus("refunded")`
- Types are Schema.Class — inferred via `Schema.Schema.Type`, never hand-written interfaces
- Effect is an internal detail — consumers see plain promises via `createClient()`
- Every new domain type needs a Schema round-trip test (`encode → decode === original`)
- Adapter transforms (Hydra unwrap, status mapping, date parsing) live in `src/adapter/`
- `src/domains/` contain the domain method factories — one file per domain
- Dual export: `@vektorprogrammet/sdk` (promises) + `@vektorprogrammet/sdk/effect`

## Key Rules

- Domain layer (`Domain/`): zero Symfony/Doctrine imports. Read entities OK, construct/mutate not OK.
- Doctrine entities: no native type declarations on collection properties. Use PHPDoc.
- `targetEntity`: always `::class` syntax.
- Cross-context Domain imports: never. Use local mirror constants.
- Tests: `dangerouslyDisableSandbox: true` always. Clear cache after namespace changes.
- After adding entity validation (state machines, NotNull, constraints): verify fixtures still load with `APP_ENV=test php bin/console doctrine:fixtures:load`. Broken fixtures cascade into 600+ silent test failures.
- When >50% of tests fail: suspect fixture loading or config error, not individual test bugs.
