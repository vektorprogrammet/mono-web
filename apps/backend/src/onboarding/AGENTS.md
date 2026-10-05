[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/backend/src/onboarding

This folder holds Recruitment code under another name. Onboarding invitation and account claim; decision D7 splits them between Recruitment and Identity.
The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.

The Recruitment context in other folders:

- [apps/backend/src/recruitment](../recruitment/AGENTS.md)
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

| Import                                          | Module                     |
| ----------------------------------------------- | -------------------------- |
| `@vektorprogrammet/backend/onboarding/delivery` | [delivery.ts](delivery.ts) |

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Mixed HTTP ownership

Recruitment declares only `onboarding.readBoard` and `onboarding.command` in `onboarding.effx.ts`.
The original `OnboardingApi` combines their generated endpoints with Identity's handwritten `ClaimOnboardingEndpoint`.
The generated raw factory returns a typed continuation. Its completion callback must register the original claim before it produces the group layer.
The claim token, account linking, and credential rules remain Identity-owned.

Each generated guard runs in the original request-local authority frame.
The read frame shares the board transaction. Command preparation resolves current Person authority and evaluates the guard before HTTP receipt replay.
The deeper department reach, application custody, readiness, and validator checks remain in their existing owners.

A command receipt records committed acceptance, not provider delivery.
Only a newly committed command attempts admitted delivery after commit. An HTTP replay returns the stored capsule and performs no delivery attempt.

`endpoint-problems.ts` owns the spread-composed `OnboardingCommandCodes`.
The declaration adapter supplies a flat tuple because the compiler cannot resolve those spreads.
Its type constraint and adapter tests require exact ordered equality. A reordered negative control must fail that equality.
The compiler's support for const-tuple spreads retires the flat copy.
Identity's migration of `claim` retires the handwritten completion.

Native Effect completion rejects ordinary omitted and duplicate claim registrations.
Its ValidateReturn diagnostic marker can still be explicitly annotated as a callback result;
the type control records this expected pass, not a workaround or a completion guarantee.
The real binding registers claim with handleRaw and never returns that diagnostic marker.
