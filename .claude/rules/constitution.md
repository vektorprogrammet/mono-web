# Monoweb Project Conventions

## Available Skills

When working on PHP code in `apps/server/`, invoke the relevant skill:

- `php-conventions` — DDD patterns, Doctrine entities, Symfony DI, API Platform, PHP 8.5 style
- `symfony-testing` — test commands, base classes, known issues, OOM workarounds
- `ddd-namespace-migration` — moving files between namespaces, updating references

## Key Rules

- Domain layer (`Domain/`): zero Symfony/Doctrine imports. Read entities OK, construct/mutate not OK.
- Doctrine entities: no native type declarations on collection properties. Use PHPDoc.
- `targetEntity`: always `::class` syntax.
- Cross-context Domain imports: never. Use local mirror constants.
- Tests: `dangerouslyDisableSandbox: true` always. Clear cache after namespace changes.
- After adding entity validation (state machines, NotNull, constraints): verify fixtures still load with `APP_ENV=test php bin/console doctrine:fixtures:load`. Broken fixtures cascade into 600+ silent test failures.
- When >50% of tests fail: suspect fixture loading or config error, not individual test bugs.
