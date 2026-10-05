[//]: # "guide: generated from docs/model/contexts.cml, the @construct tags, and package.json exports by just guides write; do not edit"

# apps/dashboard/app/foldkit/recruitment-maintenance

This folder holds Recruitment code under another name. Questionnaire and interview staffing maintenance.
The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.

The Recruitment context in other folders:

- [apps/backend/src/onboarding](../../../../backend/src/onboarding/AGENTS.md)
- [apps/backend/src/recruitment](../../../../backend/src/recruitment/AGENTS.md)
- [apps/dashboard/app/foldkit/interview](../interview/AGENTS.md)
- [apps/dashboard/app/foldkit/recruitment](../recruitment/AGENTS.md)
- [apps/dashboard/app/foldkit/scheduling](../scheduling/AGENTS.md)
- [packages/database/src/onboarding](../../../../../packages/database/src/onboarding/AGENTS.md)
- [packages/database/src/recruitment](../../../../../packages/database/src/recruitment/AGENTS.md)
- [packages/domain/src/onboarding](../../../../../packages/domain/src/onboarding/AGENTS.md)
- [packages/domain/src/recruitment](../../../../../packages/domain/src/recruitment/AGENTS.md)

## Bounded context: Recruitment

From [docs/model/contexts.cml](../../../../../docs/model/contexts.cml).

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
- `Person` and `Profile` of [People](../profile/AGENTS.md)
- `Department` of [Organization](../organization/AGENTS.md)
- `AdmissionApplication` and `AdmissionPeriod` of Admissions
- `AccountClaim` of Identity
- `OutboxEnvelope` of Delivery

### Upstream

| Context                                   | Relationship                                      | Integration                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AccessControl                             | open host service, published language, conformist | Recruitment implements the RelationshipFactPort for interview assignment (interviewer, co-interviewer); the named requirement recruitment.interviewer-appointment reads Organization's appointments |
| [People](../profile/AGENTS.md)            | open host service, published language, conformist |                                                                                                                                                                                                     |
| [Organization](../organization/AGENTS.md) | open host service, published language, conformist |                                                                                                                                                                                                     |
| Admissions                                | supplier, customer                                | Interview assignment reads the application and its admission period                                                                                                                                 |
| Identity                                  | supplier, customer                                | An onboarding invitation carries an Identity claim capability; claiming links an account and grants neither affiliation nor placement                                                               |
| Delivery                                  | open host service, published language, conformist |                                                                                                                                                                                                     |

### Downstream

| Context   | Relationship                                      | Exposes                             | Integration                                            |
| --------- | ------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Messaging | supplier, customer                                | `Interview`                         | Accept-interview reminders and staff interview digests |
| Reporting | open host service, published language, conformist | `Interview`, `OnboardingInvitation` |                                                        |

## Entry points

No `exports` entry of [apps/dashboard/package.json](../../../package.json) points into this folder, so other packages do not import it.

Local invariants, pitfalls, and recipes go below this generated part; `just guides write` keeps them.

[//]: # "guide: end"

## Correction windows

Staffing rows carry the server-owned `assessmentCorrection` observation. The existing
Staffing workflow opens and closes a correction window through the existing maintenance
command. A terminal interview disables staffing changes, not window controls. Use only
`canReopen` and `canClose` to show those controls; roles and client time grant nothing.

Eligible window openers stay enabled while the Dialog is open. Their disabled state
depends on mutation readiness and the server flag, not Dialog visibility. Native modal
isolation blocks background interaction, and the update guard rejects another open.
This keeps the same keyed opener eligible for native focus capture and restoration.

The Dialog owns focus, Escape handling, background isolation, and mount cleanup. Keep
its Commands lifted with `Command.mapMessages` and its view in `h.submodel`. A pending
save blocks dismissal and editing. An uncertain save keeps the whole decoded command,
command id, reason, end time, and observed sequence for an exact retry. A known refusal
keeps the draft but requires an explicit reload. A new edit after an uncertain save
uses `PrepareEdit` to obtain a new command id. Only a successful reload replaces drafts.

Decode the end input once with the domain `Instant` schema. Validate the command with
the existing maintenance variant; do not copy its reason or sequence validator. The
server checks current scope, sequence, semester, and separation of duties at commit.
