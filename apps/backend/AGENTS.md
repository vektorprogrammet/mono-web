[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend

Native Effect HTTP process and workers.
Package `@vektorprogrammet/backend`.

## Context folders

Each folder of `src` holds a bounded context of [docs/model/contexts.cml](../../docs/model/contexts.cml), the shared kernel, or code that the layout declaration excepts. Each has its own guide.

| Folder              | Bounded context  | Guide                                        |
| ------------------- | ---------------- | -------------------------------------------- |
| `admission`         | Admissions       | [AGENTS.md](src/admission/AGENTS.md)         |
| `application`       | Admissions       | [AGENTS.md](src/application/AGENTS.md)       |
| `contact`           | Contact          | [AGENTS.md](src/contact/AGENTS.md)           |
| `content`           | Content          | [AGENTS.md](src/content/AGENTS.md)           |
| `delivery`          | Delivery         | [AGENTS.md](src/delivery/AGENTS.md)          |
| `directory`         | People           | [AGENTS.md](src/directory/AGENTS.md)         |
| `http-api`          | none             | [AGENTS.md](src/http-api/AGENTS.md)          |
| `mail`              | Delivery         | [AGENTS.md](src/mail/AGENTS.md)              |
| `onboarding`        | Recruitment      | [AGENTS.md](src/onboarding/AGENTS.md)        |
| `organization`      | Organization     | [AGENTS.md](src/organization/AGENTS.md)      |
| `password-recovery` | Identity         | [AGENTS.md](src/password-recovery/AGENTS.md) |
| `placements`        | Placements       | [AGENTS.md](src/placements/AGENTS.md)        |
| `profile`           | People           | [AGENTS.md](src/profile/AGENTS.md)           |
| `receipt`           | Economy          | [AGENTS.md](src/receipt/AGENTS.md)           |
| `recruitment`       | Recruitment      | [AGENTS.md](src/recruitment/AGENTS.md)       |
| `schools`           | Schools          | [AGENTS.md](src/schools/AGENTS.md)           |
| `social-events`     | SocialEvents     | [AGENTS.md](src/social-events/AGENTS.md)     |
| `team-application`  | TeamApplications | [AGENTS.md](src/team-application/AGENTS.md)  |
| `test`              | none             | [AGENTS.md](src/test/AGENTS.md)              |

## Entry points

| Import                                              | Module                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `@vektorprogrammet/backend`                         | [src/index.ts](src/index.ts)                                     |
| `@vektorprogrammet/backend/application/worker`      | [src/application/worker.ts](src/application/worker.ts)           |
| `@vektorprogrammet/backend/delivery/http`           | [src/delivery/http.ts](src/delivery/http.ts)                     |
| `@vektorprogrammet/backend/http-semantics`          | [src/http-semantics.ts](src/http-semantics.ts)                   |
| `@vektorprogrammet/backend/mail/http`               | [src/mail/http.ts](src/mail/http.ts)                             |
| `@vektorprogrammet/backend/onboarding/delivery`     | [src/onboarding/delivery.ts](src/onboarding/delivery.ts)         |
| `@vektorprogrammet/backend/receipt/delivery`        | [src/receipt/delivery.ts](src/receipt/delivery.ts)               |
| `@vektorprogrammet/backend/receipt/filesystem`      | [src/receipt/filesystem.ts](src/receipt/filesystem.ts)           |
| `@vektorprogrammet/backend/receipt/import-snapshot` | [src/receipt/import-snapshot.ts](src/receipt/import-snapshot.ts) |
| `@vektorprogrammet/backend/receipt/payment-account` | [src/receipt/payment-account.ts](src/receipt/payment-account.ts) |
| `@vektorprogrammet/backend/receipt/reviewed-import` | [src/receipt/reviewed-import.ts](src/receipt/reviewed-import.ts) |
| `@vektorprogrammet/backend/session-security`        | [src/session-security.ts](src/session-security.ts)               |

## Constructs

The shared constructs defined here. Each name links to its contract; [docs/constructs.md](../../docs/constructs.md) indexes them all.

- [`jcsBytes`](../../docs/constructs/http-transport.md#jcsbytes) (http-transport): Encodes one I-JSON value with the repository RFC 8785 encoder.
- [`parseJsonWithoutDuplicateMembers`](../../docs/constructs/http-transport.md#parsejsonwithoutduplicatemembers) (http-transport): Decodes UTF-8 JSON while rejecting duplicate member names before schema decoding.
- [`interpretMergePatchSource`](../../docs/constructs/http-transport.md#interpretmergepatchsource) (http-transport): Preserves absence, value, and explicit deletion before typed merge-patch decoding.
- [`parseIdempotencyKey`](../../docs/constructs/http-transport.md#parseidempotencykey) (http-transport): Decodes one non-combinable Idempotency-Key field.
- [`parseRequiredIfMatch`](../../docs/constructs/http-transport.md#parserequiredifmatch) (http-transport): Decodes the required single strong If-Match value for an item mutation.
- [`parseReadIfMatch`](../../docs/constructs/http-transport.md#parsereadifmatch) (http-transport): Canonicalizes an optional read If-Match wildcard or entity-tag list.
- [`parseIfNoneMatch`](../../docs/constructs/http-transport.md#parseifnonematch) (http-transport): Canonicalizes an optional If-None-Match wildcard or entity-tag list.
- [`encodePathIdentity`](../../docs/constructs/http-transport.md#encodepathidentity) (http-transport): Encodes one decoded identity as an uppercase RFC 3986 path segment.
- [`normalizeTarget`](../../docs/constructs/http-transport.md#normalizetarget) (http-transport): Fills a route template with its encoded identities; a missing identity is a malformed request.
- [`deriveHttpIdentity`](../../docs/constructs/http-transport.md#derivehttpidentity) (http-transport): Derives the private storage digest and domain command ID from the identity tuple.
- [`NativeAccessRejected`](../../docs/constructs/http-problem.md#nativeaccessrejected) (http-problem): An AccessSpec evaluation that did not grant the operation.
- [`pollForever`](../../docs/constructs/worker.md#pollforever) (worker): Runs `tick` at once, then again after each success.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
