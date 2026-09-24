# Enterprise models

**Status:** Draft target views. Revised 2026-09-24.

This document models the intended Vektorprogrammet replacement through 4EM and
ArchiMate viewpoints. It does not define a second business or architecture source.

- [system.md](system.md) defines business meaning and target behavior.
- [architecture.md](architecture.md) defines technical ownership and boundaries.
- [operational-responsibility-map.md](operational-responsibility-map.md) defines
  actors, end-to-end work, and replacement contracts.
- [STATE.md](../STATE.md) alone records current implementation and acceptance.

The diagrams use Mermaid for review in the repository. They use method vocabulary,
but they are not exports from a certified modeling tool.

## Shared capability keys

These keys connect both views. They identify business capabilities, not packages or
implementation status.

| Key       | Capability                                  |
| --------- | ------------------------------------------- |
| `CAP-ID`  | Identity, sessions, and profile             |
| `CAP-REC` | Recruitment and onboarding                  |
| `CAP-AFF` | Volunteer affiliation and placement         |
| `CAP-SVC` | School-demand planning and teaching service |
| `CAP-SUB` | Substitute coverage                         |
| `CAP-ORG` | Organization administration                 |
| `CAP-ECO` | Expense reimbursement                       |
| `CAP-SUR` | Surveys and school feedback                 |
| `CAP-PUB` | Public content, contact, and events         |
| `CAP-OPS` | Audit, delivery, migration, and recovery    |

## 4EM target model

The 4EM view uses its six connected submodels. The notation and submodel structure
follow _Overview of the 4EM Method_ by Sandkuhl, Stirna, Persson, and Wißotzki.

### Goals Model

```mermaid
flowchart TB
  G01["G-01 Deliver dependable mathematics tutoring"]
  G02["G-02 Join school demand with eligible volunteer supply"]
  G03["G-03 Keep accountable identity and service history"]
  G04["G-04 Enforce scoped and time-aware authority"]
  G05["G-05 Recover delivery and operational work"]
  G06["G-06 Replace legacy production without data or service loss"]
  G07["G-07 Protect private and financial information"]
  G08["G-08 Report recorded facts without invented meaning"]

  G02 -->|supports| G01
  G03 -->|supports| G01
  G04 -->|constrains safely| G02
  G04 -->|supports| G07
  G05 -->|supports| G01
  G08 -->|supports| G03
  G06 -->|must preserve| G01
  G06 -->|must preserve| G03
  G06 -->|must preserve| G04
```

`G-01` is the primary goal. `G-06` is a migration goal, not evidence that cutover
has started or is authorized.

### Business Rules Model

| ID      | Rule                                                                                                                      | Source                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `BR-01` | A Person is the stable human identity. Account, Profile, Appointment, Affiliation, and Placement remain separate.         | [Business facts](system.md#business-facts)                                                                |
| `BR-02` | Team membership must not imply volunteer affiliation.                                                                     | [Responsibility rules](operational-responsibility-map.md#responsibility-rules)                            |
| `BR-03` | Recommendation, invitation, account claim, affiliation, and placement are separate decisions.                             | [Recruitment and affiliation](system.md#recruitment-and-affiliation)                                      |
| `BR-04` | A coordinator confirms the roster and reviews its exceptions. A proposal does not create a placement or prove attendance. | [School demand and placement](system.md#school-demand-and-placement)                                      |
| `BR-05` | Authority requires a usable account, active relationship, covered scope, and allowed capability at the given instant.     | [Authority model](system.md#authority-model)                                                              |
| `BR-06` | The backend denies access by default. A hidden frontend action is not enforcement.                                        | [Authority model](system.md#authority-model)                                                              |
| `BR-07` | One transaction records current state, immutable history, command receipt, audit, and required outbox work.               | [Durable effects](system.md#durable-effects)                                                              |
| `BR-08` | External delivery starts after commit. Retry reuses the immutable first envelope and remains bounded.                     | [Delivery and providers](architecture.md#delivery-and-providers)                                          |
| `BR-09` | A report distinguishes current from historical, missing from unavailable, and recorded from inferred.                     | [Reporting](system.md#reporting)                                                                          |
| `BR-10` | A file path, team label, menu role, or pool membership does not grant business authority.                                 | [Expense reimbursement](system.md#expense-reimbursement) and [Authority model](system.md#authority-model) |
| `BR-11` | Receipt approval does not imply payment or bank-settlement authority.                                                     | [Reimburse an expense](operational-responsibility-map.md#reimburse-an-expense)                            |
| `BR-12` | Production data, providers, deployment, writer transfer, and destructive actions need explicit operator authority.        | [Cutover gates and authority](operational-responsibility-map.md#cutover-gates-and-authority)              |
| `BR-13` | A recommendation must not imply an admission decision. Add that decision only after the organization defines it.          | [Recruitment and affiliation](system.md#recruitment-and-affiliation)                                      |

```mermaid
flowchart LR
  BR05["BR-05 Scoped authority"] --> BR06["BR-06 Default deny"]
  BR01["BR-01 Separate identities and relationships"] --> BR02["BR-02 Membership is not affiliation"]
  BR01 --> BR03["BR-03 Separate recruitment decisions"]
  BR03 --> BR13["BR-13 No inferred admission decision"]
  BR04["BR-04 Human placement confirmation"] --> G02["G-02 Demand and supply"]
  BR07["BR-07 Atomic durable effects"] --> BR08["BR-08 Post-commit delivery"]
  BR10["BR-10 Labels and paths grant no authority"] --> BR05
  BR11["BR-11 Approval is not settlement"] --> G07["G-07 Protect financial information"]
  BR12["BR-12 Explicit production authority"] --> G06["G-06 Safe replacement"]
```

### Concepts Model

The model shows business concepts and their meaning-bearing links. It does not set
cardinalities that the canonical domain model does not define.

```mermaid
classDiagram
  class Person
  class Account
  class Profile
  class Appointment
  class VolunteerAffiliation
  class Placement
  class SemesterRef
  class SchoolDemand
  class SchoolServiceCommitment
  class ScheduledAssignment
  class ServiceOutcome
  class TeachingOccurrence
  class RecruitmentApplication
  class InterviewAssessment
  class Recommendation
  class OnboardingInvitation
  class ExpenseClaim
  class ReceiptFile
  class SettlementEvidence
  class DeliveryEnvelope
  class AuditEvent

  Person --> Account : authenticates through
  Person --> Profile : maintains
  Person --> Appointment : holds for interval
  Person --> VolunteerAffiliation : holds for chapter
  VolunteerAffiliation --> Placement : qualifies person for
  Placement --> SchoolDemand : provides planned supply
  Placement --> SemesterRef : is effective in
  SchoolDemand --> SemesterRef : belongs to
  Placement --> ScheduledAssignment : supplies recurring placement
  SchoolServiceCommitment --> ScheduledAssignment : schedules
  SchoolServiceCommitment --> ServiceOutcome : closes with evidence
  ServiceOutcome --> TeachingOccurrence : records actual attendance only
  Person --> RecruitmentApplication : submits
  RecruitmentApplication --> InterviewAssessment : receives
  InterviewAssessment --> Recommendation : records
  RecruitmentApplication --> OnboardingInvitation : may receive
  Person --> ExpenseClaim : submits
  ExpenseClaim --> ReceiptFile : contains private evidence
  ExpenseClaim --> SettlementEvidence : may record
  DeliveryEnvelope --> ExpenseClaim : communicates committed fact
  AuditEvent --> ExpenseClaim : records decision history
```

The [dated-service contract](system.md#dated-school-service) separates planned supply, dated commitments, terminal outcomes, and actual attendance.
Cancellation creates no occurrence. Unfulfilled service records an occurrence only when actual attendance exists.
Implementation and acceptance remain in [STATE.md](../STATE.md).

### Business Process Model

#### Recruit and affiliate a volunteer

```mermaid
flowchart LR
  BP01["BP-01 Submit application"]
  BP02["BP-02 Assign and schedule interview"]
  BP03["BP-03 Conduct interview"]
  BP04["BP-04 Record recommendation"]
  BP05["BP-05 Review and issue invitation"]
  BP06["BP-06 Claim or link account"]
  BP07["BP-07 Request affiliation"]
  BP08["BP-08 Establish affiliation"]
  BP09["BP-09 Confirm placement"]

  BP01 --> BP02 --> BP03 --> BP04 --> BP05 --> BP06 --> BP07 --> BP08 --> BP09
```

The sequence does not contain a generic accepted-applicant state. `BR-13` governs
any future admission decision.

#### Plan and deliver school service

```mermaid
flowchart LR
  BP10["BP-10 Capture school demand"]
  BP11["BP-11 Collect eligible supply and availability"]
  BP12["BP-12 Produce constrained roster proposal"]
  BP13["BP-13 Review exceptions"]
  BP14["BP-14 Confirm roster"]
  SVCPlan["Establish dated commitment and assignments"]
  BP15["BP-15 Notify participants"]
  BP17["BP-17 Resolve absence or substitution"]
  BP16["BP-16 Record actual attendance or no attendance"]
  BP18["BP-18 Record terminal decision and evidence"]
  Completed["Completed"]
  Cancelled["Cancelled"]
  Unfulfilled["Unfulfilled"]
  Occurrence["Attendance occurrence"]
  Closed["Immutable service history"]
  BP19["BP-19 Follow-up under explicit policy"]

  BP10 --> BP12
  BP11 --> BP12
  BP12 --> BP13 --> BP14 --> SVCPlan --> BP15 --> BP17 --> BP16 --> BP18
  BP18 --> Completed --> Occurrence --> Closed
  BP18 --> Cancelled --> Closed
  BP18 --> Unfulfilled
  Unfulfilled -->|actual attendance exists| Occurrence
  Unfulfilled -->|no attendance| Closed
  Closed -.->|required follow-up or optional certificate| BP19
```

This target process covers `CAP-SVC` and `CAP-SUB`. A terminal decision records its evidence atomically.
Covered and Uncovered describe an absence, not the whole service outcome.
Completion requires actual attendance that meets demand. Cancellation records no attendance.
Certificates are outside the mandatory core path. [State](../STATE.md#next) records unresolved operational obligations.

#### Reimburse an expense

```mermaid
flowchart LR
  BP20["BP-20 Submit claim and private receipt"]
  BP21["BP-21 Read within granted scope"]
  BP22["BP-22 Approve or reject"]
  BP23["BP-23 Reopen when policy permits"]
  BP24["BP-24 Settle through explicit external authority"]
  BP25["BP-25 Record settlement evidence"]

  BP20 --> BP21 --> BP22
  BP22 -->|authorized correction| BP23 --> BP22
  BP22 -->|approved| BP24 --> BP25
```

`BP-24` is outside the current product boundary. `BR-11` prevents approval from
being treated as settlement.

### Actors and Resources Model

```mermaid
flowchart TB
  subgraph HumanRoles["Human actors and roles"]
    AR01["AR-A01 Applicant"]
    AR02["AR-A02 Interviewer"]
    AR03["AR-A03 Recruitment coordinator"]
    AR04["AR-A04 Volunteer"]
    AR05["AR-A05 Team leader"]
    AR06["AR-A06 School contact"]
    AR07["AR-A07 Coordinator"]
    AR08["AR-A08 Receipt approver"]
    AR09["AR-A09 System operator"]
  end

  subgraph TechnicalActors["Technical actors"]
    AR10["AR-A10 Delivery worker"]
  end

  subgraph Resources["Resources"]
    RR01["AR-R01 Person and account records"]
    RR02["AR-R02 Recruitment records"]
    RR03["AR-R03 School demand and roster"]
    RR04["AR-R04 Affiliation and placement history"]
    RR05["AR-R05 Claim and private receipt"]
    RR06["AR-R06 Survey and feedback records"]
    RR07["AR-R07 Audit, command receipt, and outbox"]
    RR08["AR-R08 Semester reference"]
  end

  AR01 -->|owns contact and application input| RR01
  AR01 -->|submits| RR02
  AR02 -->|assesses assigned| RR02
  AR03 -->|coordinates scoped| RR02
  AR04 -->|maintains own| RR04
  AR05 -->|establishes scoped| RR04
  AR06 -->|provides narrow input| RR03
  AR07 -->|proposes and confirms scoped| RR03
  AR08 -->|decides within grant| RR05
  AR09 -->|operates migration and recovery| RR07
  AR10 -->|claims committed work| RR07
  RR03 -->|references| RR08
  RR04 -->|references| RR08
```

A Person can hold several roles. Assignment depends on relationship, scope, and
time. The arrows do not grant authority by themselves.

### Technical Components and Requirements Model

```mermaid
flowchart TB
  TC01["TR-C01 Public homepage"] --> TC03["TR-C03 Generated SDK and HTTP contract"]
  TC02["TR-C02 Authenticated dashboard"] --> TC03
  TC03 --> TC04["TR-C04 Effect backend runtime"]
  TC04 --> TC05["TR-C05 Domain services"]
  TC04 --> TC06["TR-C06 PostgreSQL ownership layer"]
  TC06 --> TC07["TR-C07 PostgreSQL system of record"]
  TC04 --> TC08["TR-C08 Outbox delivery workers"]
  TC08 --> TC09["TR-C09 External provider adapters"]
  TC10["TR-C10 Retained Symfony production source"] -. "excluded from target graph" .-> TC04
```

| ID       | Technical requirement                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| `TR-Q01` | Keep one modular backend until an observed operational need requires another deployment boundary.                 |
| `TR-Q02` | Keep business rules and capability requirements in the domain package.                                            |
| `TR-Q03` | Derive HTTP, OpenAPI, and SDK artifacts from one contract.                                                        |
| `TR-Q04` | Encode every external or durable boundary with Effect Schema.                                                     |
| `TR-Q05` | Use PostgreSQL constraints, transactions, locks, and compare-and-set revisions for owned invariants.              |
| `TR-Q06` | Enforce the same relationship-based authority for commands and queries.                                           |
| `TR-Q07` | Commit business facts and outbox work atomically. Deliver external effects after commit.                          |
| `TR-Q08` | Make provider, credential, schema, and storage configuration explicit. Fail before production serving.            |
| `TR-Q09` | Protect private files with ownership checks, no-follow traversal, restricted permissions, and lifecycle handling. |
| `TR-Q10` | Make one Foldkit Model own each stateful dashboard journey.                                                       |
| `TR-Q11` | Exercise the real browser, HTTP, and PostgreSQL path before accepting a journey.                                  |
| `TR-Q12` | Fence legacy writers before native ownership starts. Prove backup, recovery, reconciliation, and rollback.        |

The component graph comes from [Product shape](architecture.md#product-shape).
The requirements derive from the remaining architecture sections and production
gates.

### 4EM inter-model links

| From                      | Link                     | To                                                |
| ------------------------- | ------------------------ | ------------------------------------------------- |
| `G-01`, `G-02`            | motivate                 | `BP-10` through `BP-18` and `CAP-SVC`             |
| `G-03`, `G-08`            | motivate                 | `BR-01`, `BR-07`, `BR-09`, and history resources  |
| `G-04`, `G-07`            | motivate                 | `BR-05`, `BR-06`, `BR-10`, `TR-Q06`, and `TR-Q09` |
| `BR-03`, `BR-13`          | govern                   | `BP-01` through `BP-09`                           |
| `BR-04`                   | governs                  | `BP-12` through `BP-14`                           |
| Human roles               | perform within authority | Business processes                                |
| Business processes        | create or use            | Concepts and resources                            |
| `TR-C01` through `TR-C09` | support                  | `CAP-ID` through `CAP-OPS`                        |
| `G-06`, `BR-12`, `TR-Q12` | constrain                | production migration                              |

## ArchiMate target model

This section uses ArchiMate 3 vocabulary and relationship labels. It separates
motivation, strategy, business, application, technology, and migration views.

### Motivation and strategy viewpoint

```mermaid
flowchart LR
  STK01["MOT-STK01 Stakeholder: volunteer"]
  STK02["MOT-STK02 Stakeholder: partner school"]
  STK03["MOT-STK03 Stakeholder: Vektorprogrammet operations"]
  STK04["MOT-STK04 Stakeholder: system operator"]

  DR01["MOT-DRV01 Mathematics tutoring demand"]
  DR02["MOT-DRV02 Eligible volunteer supply"]
  DR03["MOT-DRV03 Accountable operational history"]
  DR04["MOT-DRV04 Legacy ownership and cutover risk"]

  GL01["MOT-GOL01 Deliver dependable teaching service"]
  GL02["MOT-GOL02 Preserve identity, authority, and history"]
  GL03["MOT-GOL03 Complete an authorized recoverable replacement"]

  REQ01["MOT-REQ01 Human-confirmed placement"]
  REQ02["MOT-REQ02 Scoped time-aware authority"]
  REQ03["MOT-REQ03 Atomic facts, audit, receipts, and outbox"]
  REQ04["MOT-REQ04 Reconciled data and fenced writer transfer"]

  CST01["MOT-CON01 No inferred affiliation, placement, admission, or settlement"]
  CST02["MOT-CON02 Production effects need operator authority"]

  OUT01["MOT-OUT01 Delivered teaching occurrence with accountable history"]
  OUT02["MOT-OUT02 Authorized native production ownership"]

  STK01 -->|association| DR02
  STK02 -->|association| DR01
  STK03 -->|association| DR03
  STK04 -->|association| DR04
  DR01 -->|influence| GL01
  DR02 -->|influence| GL01
  DR03 -->|influence| GL02
  DR04 -->|influence| GL03
  REQ01 -->|realization| GL01
  REQ02 -->|realization| GL02
  REQ03 -->|realization| GL02
  REQ04 -->|realization| GL03
  CST01 -->|influence| REQ01
  CST02 -->|influence| REQ04
  OUT01 -->|realization| GL01
  OUT02 -->|realization| GL03
```

The strategy capabilities are the shared `CAP-*` keys. They group the behavior
needed to achieve these goals. They do not map one-to-one to deployable components.

### Business service viewpoint

```mermaid
flowchart TB
  subgraph Roles["Business roles"]
    BROL01["BUS-ROL01 Applicant"]
    BROL02["BUS-ROL02 Interviewer"]
    BROL03["BUS-ROL03 Recruitment coordinator"]
    BROL04["BUS-ROL04 Volunteer"]
    BROL05["BUS-ROL05 Team leader"]
    BROL06["BUS-ROL06 School contact"]
    BROL07["BUS-ROL07 Coordinator"]
    BROL08["BUS-ROL08 Receipt approver"]
  end

  subgraph Processes["Business processes"]
    BPR01["BUS-PRC01 Recruit and onboard volunteer"]
    BPR02["BUS-PRC02 Establish affiliation"]
    BPR03["BUS-PRC03 Plan and deliver school service"]
    BPR04["BUS-PRC04 Resolve substitute coverage"]
    BPR05["BUS-PRC05 Reimburse expense"]
  end

  subgraph Services["Business services"]
    BSV01["BUS-SVC01 Recruitment service"]
    BSV02["BUS-SVC02 Affiliation service"]
    BSV03["BUS-SVC03 Teaching service"]
    BSV04["BUS-SVC04 Coverage service"]
    BSV05["BUS-SVC05 Reimbursement service"]
  end

  subgraph Objects["Business objects"]
    BOBJ01["BUS-OBJ01 Application and assessment"]
    BOBJ02["BUS-OBJ02 Affiliation and placement"]
    BOBJ03["BUS-OBJ03 School demand and roster"]
    BOBJ04["BUS-OBJ04 Teaching occurrence"]
    BOBJ05["BUS-OBJ05 Claim, receipt, and settlement evidence"]
  end

  BROL01 -->|assignment| BPR01
  BROL02 -->|assignment| BPR01
  BROL03 -->|assignment| BPR01
  BROL04 -->|assignment| BPR02
  BROL05 -->|assignment| BPR02
  BROL06 -->|assignment| BPR03
  BROL07 -->|assignment| BPR03
  BROL04 -->|assignment| BPR04
  BROL07 -->|assignment| BPR04
  BROL04 -->|assignment| BPR05
  BROL08 -->|assignment| BPR05

  BPR01 -->|realization| BSV01
  BPR02 -->|realization| BSV02
  BPR03 -->|realization| BSV03
  BPR04 -->|realization| BSV04
  BPR05 -->|realization| BSV05

  BPR01 -->|access| BOBJ01
  BPR02 -->|access| BOBJ02
  BPR03 -->|access| BOBJ03
  BPR03 -->|access write| BOBJ04
  BPR05 -->|access| BOBJ05

  BSV01 -->|serving| BROL01
  BSV02 -->|serving| BROL04
  BSV03 -->|serving| BROL06
  BSV04 -->|serving| BROL04
  BSV05 -->|serving| BROL04
```

Role assignment is conditional. The authority relationship remains a separate
business fact and applies at the interaction time.

### Application cooperation viewpoint

```mermaid
flowchart LR
  AC01["APP-CMP01 Public homepage"]
  AC02["APP-CMP02 Authenticated dashboard"]
  AI01["APP-INT01 Generated native API interface"]
  AC03["APP-CMP03 Native Effect backend"]

  AF01["APP-FNC01 Public journey handling"]
  AF02["APP-FNC02 Authenticated journey handling"]
  AF03["APP-FNC03 Domain command and query handling"]
  AF04["APP-FNC04 Authority interpretation"]
  AF05["APP-FNC05 Durable transaction coordination"]
  AF06["APP-FNC06 Delivery processing"]

  AS01["APP-SVC01 Public application service"]
  AS02["APP-SVC02 Authenticated operations service"]
  AS03["APP-SVC03 Business capability API service"]
  AS04["APP-SVC04 Notification delivery service"]

  AC01 -->|assignment| AF01
  AC02 -->|assignment| AF02
  AC03 -->|assignment| AF03
  AC03 -->|assignment| AF04
  AC03 -->|assignment| AF05
  AC03 -->|assignment| AF06

  AF01 -->|realization| AS01
  AF02 -->|realization| AS02
  AF03 -->|realization| AS03
  AF06 -->|realization| AS04

  AI01 -->|assignment| AS03
  AC03 -->|composition| AI01
  AS03 -->|serving| AC01
  AS03 -->|serving| AC02
  AF04 -->|serving| AF03
  AF05 -->|serving| AF03
  AS03 -->|serving| BPR01["BUS-PRC01 Recruitment"]
  AS03 -->|serving| BPR03["BUS-PRC03 School service"]
  AS03 -->|serving| BPR04["BUS-PRC04 Substitute coverage"]
  AS03 -->|serving| BPR05["BUS-PRC05 Expense reimbursement"]
```

`packages/domain`, `packages/database`, `packages/http-api`, and `packages/sdk` are
implementation modules within these components and interfaces. Their exact
dependency graph remains authoritative in [architecture.md](architecture.md).

### Technology viewpoint

```mermaid
flowchart TB
  TN01["TEC-NOD01 Browser runtime"]
  TN02["TEC-NOD02 Native application runtime"]
  TN03["TEC-NOD03 Database runtime"]
  TN04["TEC-NOD04 External provider environment"]

  TS01["TEC-SYS01 Browser system software"]
  TS02["TEC-SYS02 Bun and Effect runtime"]
  TS03["TEC-SYS03 PostgreSQL"]
  TS04["TEC-SYS04 External provider systems"]

  TV01["TEC-SVC01 Browser execution service"]
  TV02["TEC-SVC02 HTTP execution service"]
  TV03["TEC-SVC03 Transactional persistence service"]
  TV04["TEC-SVC04 OAuth, storage, and notification provider services"]

  TN01 -->|composition| TS01
  TN02 -->|composition| TS02
  TN03 -->|composition| TS03
  TN04 -->|composition| TS04
  TS01 -->|realization| TV01
  TS02 -->|realization| TV02
  TS03 -->|realization| TV03
  TS04 -->|realization| TV04

  TV01 -->|serving| AC01["APP-CMP01 Homepage"]
  TV01 -->|serving| AC02["APP-CMP02 Dashboard"]
  TV02 -->|serving| AC03["APP-CMP03 Backend"]
  TV03 -->|serving| AC03
  TV04 -->|serving| AC03
```

The target documents do not define a final production topology. This view therefore
stops at runtime responsibilities and explicit external provider seams.

### Implementation and migration viewpoint

```mermaid
flowchart LR
  PL01["MIG-PLT01 Legacy production active"]
  PL02["MIG-PLT02 Native target with local observed journeys"]
  PL03["MIG-PLT03 Reconciled production candidate"]
  PL04["MIG-PLT04 Native production ownership"]

  GAP01["MIG-GAP01 Incomplete operating journeys"]
  GAP02["MIG-GAP02 Real identity, files, affiliation, and placement reconciliation"]
  GAP03["MIG-GAP03 Real providers, recovery, and operational proof"]
  GAP04["MIG-GAP04 Writer transfer and cutover authority"]

  WP01["MIG-WP01 Close required maintenance and active operational journeys"]
  WP02["MIG-WP02 Reconcile retained production data"]
  WP03["MIG-WP03 Prove providers, backup, restore, recovery, and rollback"]
  WP04["MIG-WP04 Rehearse writer transfer"]
  WP05["MIG-WP05 Execute separately authorized cutover"]

  DEL01["MIG-DEL01 Closed operational journeys"]
  DEL02["MIG-DEL02 Reconciled import candidate"]
  DEL03["MIG-DEL03 Recovery and transfer evidence"]
  DEL04["MIG-DEL04 Authorized native ownership"]

  PL01 -.->|association| PL02
  PL02 -.->|association| GAP01
  GAP01 -.->|association| PL03
  PL02 -.->|association| GAP02
  GAP02 -.->|association| PL03
  PL02 -.->|association| GAP03
  GAP03 -.->|association| PL03
  PL03 -.->|association| GAP04
  GAP04 -.->|association| PL04

  WP01 -.->|association| GAP01
  WP02 -.->|association| GAP02
  WP03 -.->|association| GAP03
  WP04 -.->|association| GAP04
  WP05 -.->|association| GAP04

  WP01 -->|realization| DEL01
  WP02 -->|realization| DEL02
  WP03 -->|realization| DEL03
  WP04 -->|realization| DEL03
  WP05 -->|realization| DEL04
  DEL01 -->|realization| PL03
  DEL02 -->|realization| PL03
  DEL03 -->|realization| PL03
  DEL04 -->|realization| PL04
```

`MIG-PLT01` and the local observations in `MIG-PLT02` are current facts from
[STATE.md](../STATE.md). All later plateaus are targets. `MIG-WP05` requires new
operator authority and does not follow automatically from technical completion.

## Cross-model traceability

| Capability | 4EM anchors                                         | ArchiMate anchors                     | Canonical source                                                                                             |
| ---------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CAP-ID`   | `G-03`, `BR-01`, `AR-R01`, `TR-Q06`                 | `MOT-GOL02`, `APP-FNC04`              | [Business facts](system.md#business-facts), [Identity and authority](architecture.md#identity-and-authority) |
| `CAP-REC`  | `BR-03`, `BR-13`, `BP-01`–`BP-09`                   | `BUS-PRC01`, `BUS-SVC01`              | [Recruitment and affiliation](system.md#recruitment-and-affiliation)                                         |
| `CAP-AFF`  | `BR-02`, `BP-07`–`BP-09`, `AR-R04`                  | `BUS-PRC02`, `BUS-SVC02`, `BUS-OBJ02` | [Return an existing volunteer](operational-responsibility-map.md#return-an-existing-volunteer)               |
| `CAP-SVC`  | `G-01`, `G-02`, `BR-04`, `BP-10`–`BP-18`            | `MOT-GOL01`, `BUS-PRC03`, `BUS-SVC03` | [Plan and deliver school service](operational-responsibility-map.md#plan-and-deliver-school-service)         |
| `CAP-SUB`  | `BP-17`, `AR-A04`, `AR-A07`                         | `BUS-PRC04`, `BUS-SVC04`              | [Substitute coverage](system.md#substitute-coverage)                                                         |
| `CAP-ECO`  | `G-07`, `BR-10`, `BR-11`, `BP-20`–`BP-25`           | `BUS-PRC05`, `BUS-SVC05`, `BUS-OBJ05` | [Expense reimbursement](system.md#expense-reimbursement)                                                     |
| `CAP-OPS`  | `G-05`, `G-06`, `BR-07`, `BR-08`, `BR-12`, `TR-Q12` | `MOT-GOL03`, `MIG-*`                  | [Cutover gates and authority](operational-responsibility-map.md#cutover-gates-and-authority)                 |

Capabilities without detailed diagrams still remain in the shared key list. Their
canonical behavior stays in the three source documents.

## Open model decisions

1. Define a coordinator admission decision only if it is a real business fact with
   named authority and lifecycle.
2. Define payment and settlement ownership before adding a finance integration.
3. Select the final production topology only after operational requirements justify
   it.
4. Promote the ArchiMate draft to an exchange file only if a maintained modeling tool
   becomes part of the workflow.

## Method references

- Sandkuhl, Stirna, Persson, and Wißotzki, [Overview of the 4EM Method](https://doi.org/10.1007/978-3-662-43725-4_7), 2014.
- The Open Group, [The ArchiMate Enterprise Architecture Modeling Language](https://www.opengroup.org/archimate-forum/archimate-overview).
- The Open Group, [ArchiMate 3.2 Specification](https://pubs.opengroup.org/architecture/archimate32-doc/).

## Maintenance rule

Change the canonical source document first. Update these views in the same change
when the modeled meaning changes. Record implementation progress only in
[STATE.md](../STATE.md). This prevents a target view from becoming false runtime
evidence.
