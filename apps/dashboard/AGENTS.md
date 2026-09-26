[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard

Authenticated React Router and Foldkit application.
Package `@monoweb/dashboard`.

## Context folders

Each folder of `app/foldkit` holds a bounded context of [docs/model/contexts.cml](../../docs/model/contexts.cml), the shared kernel, or code that the layout declaration excepts. Each has its own guide.

| Folder                    | Bounded context  | Guide                                                      |
| ------------------------- | ---------------- | ---------------------------------------------------------- |
| `content`                 | Content          | [AGENTS.md](app/foldkit/content/AGENTS.md)                 |
| `dashboard`               | none             | [AGENTS.md](app/foldkit/dashboard/AGENTS.md)               |
| `dated-school-service`    | Placements       | [AGENTS.md](app/foldkit/dated-school-service/AGENTS.md)    |
| `interview`               | Recruitment      | [AGENTS.md](app/foldkit/interview/AGENTS.md)               |
| `organization`            | Organization     | [AGENTS.md](app/foldkit/organization/AGENTS.md)            |
| `profile`                 | People           | [AGENTS.md](app/foldkit/profile/AGENTS.md)                 |
| `recruitment`             | Recruitment      | [AGENTS.md](app/foldkit/recruitment/AGENTS.md)             |
| `recruitment-maintenance` | Recruitment      | [AGENTS.md](app/foldkit/recruitment-maintenance/AGENTS.md) |
| `scheduling`              | Recruitment      | [AGENTS.md](app/foldkit/scheduling/AGENTS.md)              |
| `schools`                 | Schools          | [AGENTS.md](app/foldkit/schools/AGENTS.md)                 |
| `social-events`           | SocialEvents     | [AGENTS.md](app/foldkit/social-events/AGENTS.md)           |
| `team-applications`       | TeamApplications | [AGENTS.md](app/foldkit/team-applications/AGENTS.md)       |

## Entry points

The package has no `exports`, so other packages do not import it.

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../docs/constructs.md) indexes them all.

- [`isNativeRequest`](../../docs/constructs/request-ledger.md#isnativerequest) (request-ledger): Whether a dashboard-to-backend request stays on the native surface: an operation of the native HTTP contract or an email-password route of the identity engine.
- [`addressesAnyRoute`](../../docs/constructs/request-ledger.md#addressesanyroute) (request-ledger): Whether a request path addresses any of the routes, each matched by whole path segments.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
