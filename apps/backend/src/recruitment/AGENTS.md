[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/recruitment

This folder holds the Recruitment bounded context in `apps/backend/src`.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Recruitment context in other folders:

- [apps/backend/src/onboarding](../onboarding/AGENTS.md)
- [apps/dashboard/app/foldkit/interview](../../../dashboard/app/foldkit/interview/AGENTS.md)
- [apps/dashboard/app/foldkit/recruitment](../../../dashboard/app/foldkit/recruitment/AGENTS.md)
- [apps/dashboard/app/foldkit/recruitment-maintenance](../../../dashboard/app/foldkit/recruitment-maintenance/AGENTS.md)
- [apps/dashboard/app/foldkit/scheduling](../../../dashboard/app/foldkit/scheduling/AGENTS.md)
- [packages/database/src/onboarding](../../../../packages/database/src/onboarding/AGENTS.md)
- [packages/database/src/recruitment](../../../../packages/database/src/recruitment/AGENTS.md)
- [packages/domain/src/onboarding](../../../../packages/domain/src/onboarding/AGENTS.md)
- [packages/domain/src/recruitment](../../../../packages/domain/src/recruitment/AGENTS.md)

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

- `PrincipalAlgebra` and `CapabilityRegistry` of AccessControl
- `Person` and `Profile` of [People](../directory/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)
- `AdmissionApplication` and `AdmissionPeriod` of [Admissions](../admission/AGENTS.md)
- `AccountClaim` of [Identity](../password-recovery/AGENTS.md)
- `OutboxEnvelope` of [Delivery](../delivery/AGENTS.md)

### Upstream

| Context                                    | Relationship                                      | Integration                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                              | open host service, published language, conformist | Recruitment implements the RelationshipFactPort for interview assignment (interviewer, co-interviewer); the named requirement recruitment.interviewer-appointment reads Organization's appointments |
| [People](../directory/AGENTS.md)           | open host service, published language, conformist |                                                                                                                                                                                                     |
| [Organization](../organization/AGENTS.md)  | open host service, published language, conformist |                                                                                                                                                                                                     |
| [Admissions](../admission/AGENTS.md)       | supplier, customer                                | Interview assignment reads the application and its admission period                                                                                                                                 |
| [Identity](../password-recovery/AGENTS.md) | supplier, customer                                | An onboarding invitation carries an Identity claim capability; claiming links an account and grants neither affiliation nor placement                                                               |
| [Delivery](../delivery/AGENTS.md)          | open host service, published language, conformist |                                                                                                                                                                                                     |

### Downstream

| Context   | Relationship                                      | Exposes                             | Integration                                            |
| --------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Messaging | supplier, customer                                | `Interview`                         | Accept-interview reminders and staff interview digests |
| Reporting | open host service, published language, conformist | `Interview`, `OnboardingInvitation` |                                                        |

## Entry points

No `exports` entry of [apps/backend/package.json](../../package.json) points into this folder, so other packages do not import it.

## Constructs

The shared constructs defined here. [docs/constructs.md](../../../../docs/constructs.md) lists their consumers.

- [`authorizeInvitationOperation`](http-access.ts) (http-problem): Authorizes the holder of an invitation's response capability.
- [`interviewAuthorizationInTransaction`](http-access.ts) (http-problem): Resolves the current person and authorizes one interview inside the caller's transaction; a rejected credential is answered from the request's evidence.
- [`readRecruitmentBody`](http-decode.ts) (http-problem): Every recruitment request body is one bounded `application/json` document.
- [`recruitmentProblems`](http-problem.ts) (http-problem): The one answer for every recruitment failure.
- [`raceProblems`](http-problem.ts) (http-problem): A failure that lost a serialization or deadlock race answers transaction.conflict, whatever failure carried it.
- [`maintenanceProblems`](http-problem.ts) (http-problem): The maintenance API answers its own failures, an unknown interview, and an identity outage in its own vocabulary; everything else as recruitment does.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"
