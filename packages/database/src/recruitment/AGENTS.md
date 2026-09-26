[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# packages/database/src/recruitment

This folder holds the Recruitment bounded context in `packages/database/src`.
The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.

The Recruitment context in other folders:

- [apps/backend/src/onboarding](../../../../apps/backend/src/onboarding/AGENTS.md)
- [apps/backend/src/recruitment](../../../../apps/backend/src/recruitment/AGENTS.md)
- [apps/dashboard/app/foldkit/interview](../../../../apps/dashboard/app/foldkit/interview/AGENTS.md)
- [apps/dashboard/app/foldkit/recruitment](../../../../apps/dashboard/app/foldkit/recruitment/AGENTS.md)
- [apps/dashboard/app/foldkit/recruitment-maintenance](../../../../apps/dashboard/app/foldkit/recruitment-maintenance/AGENTS.md)
- [apps/dashboard/app/foldkit/scheduling](../../../../apps/dashboard/app/foldkit/scheduling/AGENTS.md)
- [packages/database/src/onboarding](../onboarding/AGENTS.md)
- [packages/domain/src/onboarding](../../../domain/src/onboarding/AGENTS.md)
- [packages/domain/src/recruitment](../../../domain/src/recruitment/AGENTS.md)

## Bounded context: Recruitment

From [docs/model/contexts.cml](../../../../docs/model/contexts.cml).

Interview staffing, scheduling, invitations and responses, conduct, recommendation, corrections and onboarding invitations. Recommendation, invitation, account claim, affiliation and placement stay separate decisions.

Responsibilities:

- Interviews
- Questionnaires
- Onboarding invitations

### Owns

- `Interview`
- `Questionnaire`
- `OnboardingInvitation`

### Uses but does not own

- `PrincipalAlgebra` and `CapabilityRegistry` of [AccessControl](../authz/AGENTS.md)
- `Person` and `Profile` of [People](../profile/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)
- `AdmissionApplication` and `AdmissionPeriod` of [Admissions](../admissions/AGENTS.md)
- `AccountClaim` of Identity
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AccessControl](../authz/AGENTS.md)       | open host service, published language, conformist | Recruitment implements the RelationshipFactPort for interview assignment (interviewer, co-interviewer); the named requirement recruitment.interviewer-appointment reads Organization's appointments |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |                                                                                                                                                                                                     |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                                     |
| [Admissions](../admissions/AGENTS.md)     | supplier, customer                                | Interview assignment reads the application and its admission period                                                                                                                                 |
| Identity                                  | supplier, customer                                | An onboarding invitation carries an Identity claim capability; claiming links an account and grants neither affiliation nor placement                                                               |
| Delivery                                  | open host service, published language, conformist |                                                                                                                                                                                                     |

### Downstream

| Context   | Relationship                                      | Exposes                             | Integration                                            |
| --------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Messaging | supplier, customer                                | `Interview`                         | Accept-interview reminders and staff interview digests |
| Reporting | open host service, published language, conformist | `Interview`, `OnboardingInvitation` |                                                        |

## Entry points

| Import                                   | Module               |
| ---------------------------------------- | -------------------- |
| `@vektorprogrammet/database/recruitment` | [index.ts](index.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
