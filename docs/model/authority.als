module authority

/*
 * Vektorprogrammet authority as two algebras: roles and principals.
 *
 * This model states intended behaviour. docs/system.md is the product authority, in its sections
 * "Authority model", "Organization administration", "Recruitment and affiliation", "Team
 * applications" and "Expense reimbursement". docs/model/contexts.cml places the same concepts in
 * their bounded contexts.
 *
 * ROLE ALGEBRA. A role instance is (holder, role type, scope, interval, status). The holder is a
 * Person. Teams, boards, departments and single resources are scopes, never holders. Each unit
 * sits at one scope: a team at itself, a department's board (Styret) at its department, and the
 * national board (Hovedstyret) at national scope, which covers every department. A department's
 * board governs the department only while Hovedstyret recognises the department as independent; a
 * non-independent department and a team without a board fall under Hovedstyret. Authority comes
 * from a closed set of role types. A position is an informal title that one unit defines, and it
 * maps to exactly one role type. Every capability reaches the scope where the role's unit sits,
 * so an ordinary team leader acts within the team; only a board's leader reaches the board's area.
 *
 * BOARDS. A department's Styret holds its own positions, plus one derived seat for every leader
 * of a local team with its home in the department. Hovedstyret holds its own positions, plus one
 * derived seat for every leader of a national team. A derived seat follows its leadership: it
 * starts and ends with it, and it confers membership and certificate issuance, not
 * administration. Certificates come from the board of an independent department, from a
 * Hovedstyret seat for a department that is not independent, or from a global administrator.
 *
 * TEAMS. A team has a home department and a scope. The scope is the home, or national for a
 * national team that a department hosts.
 *
 * DELEGATIONS. A delegation is explicit, named and time-bounded: team T holds capability C in
 * area A. The area is the team's home, or, for a national team, a department or the whole
 * organization. While it is active, it gives C in A to the current members of T, or to its
 * current leaders only. Settlement reaches the leaders only: every member of the economy team
 * approves, and its leader, the finance lead, pays out. A delegation never carries system
 * administration. The leader of the governing board manages a team's delegations:
 * the Styret of an independent home department for a local team, Hovedstyret for every other
 * team; a global administrator can too. There are no roles by team kind.
 *
 * PRINCIPAL ALGEBRA. A request presents credentials. Exactly one usable principal binds one
 * subject: an account (session cookie or account bearer), or a service principal, or a bearer
 * capability. An account bearer is an OAuth client acting for the account's person. It never
 * exceeds the person's authority, its token scope narrows it, and a bot changes data only with
 * the person's confirmation. A client holds no standing capability. The existing-account claim
 * uses the session as its principal, and a bearer cannot make it. Its token is a named requirement: single-use and bound to
 * one claim target. Global administration, payment authority and machine grants are
 * principal-side grants. A role never implies one.
 *
 *   permit(q) = the one principal p of q is usable, an on-behalf request keeps to its token scope
 *     and to the confirmation rule, and
 *     ( some role of p's Person, effective now, whose reach for the action, or an active
 *       delegation of the action to the role's team, covers the target, with the named
 *       requirements of that role and action met
 *     or some grant of p's subject, active now, for the action, whose area covers the target
 *     or p is an unconsumed bearer capability for exactly this target and action
 *     or the action is the existing-account claim, p is an account, and its token is valid )
 *
 * CHECKING. Alloy 6, for example from nixpkgs:
 *   nix shell nixpkgs#alloy6 --command alloy6 exec -s glucose -c '*' -t text -o DIR -f authority.als
 * Each command states its expected result. A correct check expects no counterexample (expect 0).
 * A mutant check runs the same property under one deliberately broken rule and expects a
 * counterexample (expect 1): this shows that the property is not vacuous. A scenario run expects
 * an instance (expect 1). Checks are bounded: they cover every instance up to the stated scope,
 * and they are not proofs for larger instances.
 */

open util/ordering[Instant]

sig Instant {}

--------------------------------------------------------------------------------------------
-- Scopes
--------------------------------------------------------------------------------------------

-- containment is a forest under the organization
abstract sig Scope { within: lone Scope }
one sig Organization extends Scope {}
sig Department extends Scope {}
-- the departments that Hovedstyret recognises as independent (selvstendig)
sig Independent in Department {}
-- a team has a home department (within) and a scope: its home, or national
sig Team extends Scope { teamScope: one Scope }
sig Styret extends Scope {}            -- the board of one department
one sig Hovedstyret extends Scope {}   -- the national board
sig Semester {}
sig SchoolSemester extends Scope { semester: one Semester }   -- one school in one semester, in one department
abstract sig Resource extends Scope {}
sig Interview, Receipt, Application, TeamApplication, ServiceCommitment,
    ClaimTarget, InvitationTarget extends Resource {}

fact containment {
  no Organization.within
  all s: Department + Hovedstyret | s.within = Organization
  all s: Team + Styret + SchoolSemester + Interview + Receipt + Application + ClaimTarget |
    one s.within and s.within in Department
  all s: TeamApplication | one s.within and s.within in Team
  all s: ServiceCommitment | one s.within and s.within in SchoolSemester
  all s: InvitationTarget | one s.within and s.within in Interview
  all d: Department | lone (Styret & within.d)
  all t: Team | t.teamScope in t.within + Organization
  -- an independent department has a board; the statutes also require three elected board members
  -- and the recruitment and school coordination teams
  all d: Independent | some Styret & within.d
}

-- a department and everything inside it
fun Local: set Scope { Department.*~within }
fun departmentOf[s: Scope]: set Scope { s.*within & Department }
-- t covers s when some scope in t is s or contains s
pred covers[t: set Scope, s: Scope] { some (s.*within & t) }

-- the scopes at which each unit sits (constrained by the policy); the board of a department that
-- is not independent sits nowhere, so Hovedstyret governs that department
one sig Seat { at: Scope -> set Scope }

pred boardsSitWhereTheyServe {
  all s: Scope | Seat.at[s] =
    ((s in Styret) => (s.within & Independent) else ((s in Hovedstyret) => Organization else s))
}
-- MUTANT (K1): every board sits at national scope, as if a board were national wherever it serves
pred everyBoardSitsNationally {
  all s: Scope | Seat.at[s] = ((s in Styret + Hovedstyret) => Organization else s)
}
-- MUTANT (K2): the national board sits at its own node, like any other unit
pred hovedstyretSitsAtItsOwnNode {
  all s: Scope | Seat.at[s] = ((s in Styret) => (s.within & Independent) else s)
}
-- MUTANT (X1): a department's board governs the department whether or not it is independent
pred styretGovernsWithoutIndependence {
  all s: Scope | Seat.at[s] = ((s in Styret) => s.within else ((s in Hovedstyret) => Organization else s))
}
-- MUTANT (X2): Hovedstyret governs only the national teams, so a department without an
-- independent board is governed by nobody
pred hovedstyretGovernsOnlyNationalTeams {
  all s: Scope | Seat.at[s] = ((s in Styret) => (s.within & Independent)
    else ((s in Hovedstyret) => { t: Team | t.teamScope = Organization } else s))
}

-- the board on which the leader of each team holds a derived seat (constrained by the policy)
one sig DerivedBoards { of: Team -> lone Scope }

pred leadersSitOnTheGoverningBoard {
  DerivedBoards.of = { t: Team, b: Scope |
    (t.teamScope = Organization) => b = Hovedstyret else b in Styret & within.(t.within) }
}
-- MUTANT (Q3): a national team's leader sits on the Styret of the team's home department, like
-- the leader of a local team
pred nationalLeadersSitAtHome {
  DerivedBoards.of = { t: Team, b: Scope | b in Styret & within.(t.within) }
}

-- the area in which each team may act through delegations (constrained by the policy)
one sig TeamAreas { of: Team -> one Scope }

pred teamAreaIsItsScope { TeamAreas.of = teamScope }
-- MUTANT (T): a team counts as national when a national team shares its home department, as if
-- the scope were inferred from the home instead of stored per team
pred nationalByHome {
  TeamAreas.of = { t: Team, s: Scope |
    s = ((some u: Team | u.within = t.within and u.teamScope = Organization) => Organization else t.teamScope) }
}

--------------------------------------------------------------------------------------------
-- Role algebra
--------------------------------------------------------------------------------------------

sig Person {}

abstract sig RoleType {}
one sig Member, Leader, BoardLeader, BoardMember, Assistant, PlacedAssistant, RosterMember,
        Interviewer, CoInterviewer, ReceiptOwner, Applicant extends RoleType {}

-- appointments are the role types that Organization owns
fun Appointments: set RoleType { Member + Leader + BoardLeader + BoardMember }
fun BoardTypes: set RoleType { BoardLeader + BoardMember }

-- a position is an informal title that one unit defines (leder, nestleder, sekretaer, ...); it
-- maps to exactly one role type, and authority comes only from the role type
sig Title {}
sig Position { title: one Title, unit: one Scope, roleType: one RoleType }

sig Role {
  holder: one Person,
  type: one RoleType,
  scope: one Scope,
  position: lone Position,
  start: one Instant,
  var finish: lone Instant,
  gate: lone Role            -- a derived Styret seat: the team leadership that it follows
}
var sig Suspended in Role {}

fact positionShapes {
  all p: Position | p.unit in Team + Styret + Hovedstyret
  all p: Position | p.unit in Team implies p.roleType in Member + Leader
  all p: Position | p.unit in Styret + Hovedstyret implies p.roleType in BoardTypes
}

fact roleShapes {
  all r: Role {
    r.type in Member + Leader implies r.scope in Team
    r.type in BoardTypes      implies r.scope in Styret + Hovedstyret
    r.type = Assistant        implies r.scope in Department
    r.type = PlacedAssistant  implies r.scope in SchoolSemester
    r.type = RosterMember     implies r.scope in ServiceCommitment
    r.type in Interviewer + CoInterviewer implies r.scope in Interview
    r.type = ReceiptOwner     implies r.scope in Receipt
    r.type = Applicant        implies r.scope in Application
  }
  -- a stored appointment holds one position of its unit; a derived seat holds none
  all r: Role | some r.position iff (r.type in Appointments and no r.gate)
  all r: Role | some r.position implies r.scope = r.position.unit
  -- a derived seat: every leader of a team with a governing board holds one derived seat on it,
  -- which starts with the leadership, has no end of its own, and is never suspended by itself
  all r: Role | (r.type = Leader and some DerivedBoards.of[r.scope]) implies one gate.r
  all x: Role | some x.gate implies {
    x.gate.type = Leader and no x.gate.gate
    x.type = BoardMember and x.holder = x.gate.holder and x.start = x.gate.start
    x.scope = DerivedBoards.of[x.gate.scope]
    always (no x.finish and x not in Suspended)
  }
  -- creation preconditions: checked when the fact is created, not afterwards
  all r: Role | r.type = PlacedAssistant implies
    some a: Role | a.type = Assistant and a.holder = r.holder and a.scope = departmentOf[r.scope]
  -- one interviewer and one distinct co-interviewer per interview
  all i: Interview | lone (type.Interviewer & scope.i) and lone (type.CoInterviewer & scope.i)
  all a, b: Role | (a.type = Interviewer and b.type = CoInterviewer and a.scope = b.scope)
    implies a.holder != b.holder
  -- one owner per receipt
  all x: Receipt | lone (type.ReceiptOwner & scope.x)
}

-- a derived cohort, not a scope: the placed assistants of a department in a semester
fun assistantCohort[d: Department, y: Semester]: set Person {
  { p: Person | some r: Effective |
      r.holder = p and r.type = PlacedAssistant and r.scope.within = d and r.scope.semester = y }
}

one sig Clock { var now: one Instant }

pred started[r: Role] { lte[r.start, Clock.now] }
pred unfinished[r: Role] { no r.finish or lt[Clock.now, r.finish] }
pred ownActive[r: Role] { started[r] and unfinished[r] and r not in Suspended }

-- the role instances that confer authority in the current state (constrained by the policy)
var sig Effective in Role {}

pred effectiveByOwnState {
  always Effective = { r: Role | ownActive[r] and (no r.gate or ownActive[r.gate]) }
}
-- MUTANT (C): a leadership that has started stays effective, as a cached authority result would
pred effectiveStaleLeadership {
  always Effective = { r: Role |
    (r.type = Leader implies started[r] else ownActive[r]) and (no r.gate or ownActive[r.gate]) }
}
-- MUTANT (Q1): a derived Styret seat is stored as a copy with its own state, so it outlives the
-- team leadership that it came from
pred effectiveDerivedSeatAsCopy {
  always Effective = { r: Role | ownActive[r] }
}

--------------------------------------------------------------------------------------------
-- Actions and capabilities
--------------------------------------------------------------------------------------------

abstract sig Kind {}
one sig CookieKind, UserBearerKind, MachineKind, CapabilityKind extends Kind {}

abstract sig Action { accepts: set Kind }
one sig ReadTeamApplications, ManageTeamApplications,
        ManageAppointments, MaintainInterviewStaffing, ScheduleInterview, CoordinatePlacements,
        ReportAbsence, ChangeAccountAccess, AdministerGrants, MaintainQuestionnaires,
        AssessInterview, CorrectAssessment, ReadOwnReceipt, ReadOwnProgress, ReadOwnPlacement,
        SubmitReceipt, ApproveReceipt, SettleReceipt, ManageDelegations, RecordDaysServed, IssueCertificates,
        ClaimNewAccount, ClaimExistingAccount, RespondToInvitation extends Action {}

-- organisational administration of a department (from Hovedstyret: of every department)
fun DepartmentAdministration: set Action {
  ManageAppointments + MaintainInterviewStaffing + ScheduleInterview + CoordinatePlacements + ReportAbsence
  + RecordDaysServed
}
-- what a delegation may give a team: department administration, and receipt approval and
-- settlement (the national delegation to the economy team)
fun Delegable: set Action { DepartmentAdministration + ApproveReceipt + SettleReceipt }
-- system administration: only the principal-side global-administrator grant confers it
fun SystemAdministration: set Action { ChangeAccountAccess + AdministerGrants + MaintainQuestionnaires }
-- the actions that change nothing
fun ReadActions: set Action { ReadTeamApplications + ReadOwnReceipt + ReadOwnProgress + ReadOwnPlacement }

-- the credential kinds that each endpoint accepts
fact endpointMechanisms {
  ClaimNewAccount.accepts = CapabilityKind
  RespondToInvitation.accepts = CapabilityKind
  ApproveReceipt.accepts = CookieKind + UserBearerKind + MachineKind
  all a: Action - (ClaimNewAccount + RespondToInvitation + ClaimExistingAccount + ApproveReceipt) |
    a.accepts = CookieKind + UserBearerKind
}

-- the session is the principal of the existing-account claim
pred claimBySessionOnly { ClaimExistingAccount.accepts = CookieKind }
-- MUTANT (F4): the existing-account claim also accepts a delegated bearer
pred claimByAnyAccountCredential { ClaimExistingAccount.accepts = CookieKind + UserBearerKind }

one sig Capabilities { table: RoleType -> Action, extra: Role -> Action }

-- representative capabilities of role types (docs/system.md, "Authority model" and the workflows)
pred capabilityTable { Capabilities.table = intendedCapabilities }

fun intendedCapabilities: RoleType -> Action {
      Member -> ReadTeamApplications        -- a current member of the team reads its applications
    + Leader -> ReadTeamApplications
    + Leader -> ManageTeamApplications      -- the current leader changes intake and deletes applications
    + Leader -> ManageAppointments          -- the leader authorises the team's appointments
    + BoardLeader -> DepartmentAdministration   -- a board's leader administers where the board sits
    + BoardLeader -> ManageDelegations          -- and manages the delegations of teams in that area
    + BoardLeader -> IssueCertificates          -- a department board issues its assistants' certificates
    + BoardMember -> IssueCertificates          -- (requirement DepartmentBoardCertificates)
    + PlacedAssistant -> ReadOwnPlacement   -- an assistant reads their own placement
    + RosterMember -> ReportAbsence         -- a scheduled volunteer reports their own absence
    + Interviewer -> ScheduleInterview      -- with the named requirement InterviewerAppointment
    + Interviewer -> AssessInterview        -- an interviewer assesses only an assigned interview
    + CoInterviewer -> CorrectAssessment    -- while the scoped correction capability is active
    + ReceiptOwner -> ReadOwnReceipt        -- a receipt owner reads their own file
    + Applicant -> ReadOwnProgress          -- an applicant reads their own application progress
    -- BoardMember carries only certificate issuance: a board seat without leadership, derived or
    -- appointed, confers no administration
}

-- MUTANT (L): every team leader also administers its whole department ("department leader")
pred leadersAdministerTheirDepartment {
  Capabilities.table = intendedCapabilities + Leader -> DepartmentAdministration
  ReachBasis.via = (Role <: scope) + { r: Role, d: Department | r.type = Leader and d = departmentOf[r.scope] }
}
-- MUTANT (Q2): every Styret member, derived seats included, administers the department, as the
-- legacy "department leader" did
pred styretMembersAdministerTheDepartment {
  Capabilities.table = intendedCapabilities + BoardMember -> DepartmentAdministration
  reachFollowsTheUnit
}

pred noExtraCapabilities { no Capabilities.extra }
-- MUTANT (K3): a role on the national board carries system administration, as if a Hovedstyret
-- seat implied the global-administrator grant
pred hovedstyretSeatsCarrySystemAdministration {
  Capabilities.extra = { r: Role, a: SystemAdministration | r.scope = Hovedstyret }
}

fun caps[r: Role]: set Action { r.type.(Capabilities.table) + r.(Capabilities.extra) }

pred typeFollowsPosition { all r: Role | some r.position implies r.type = r.position.roleType }
-- MUTANT (P): a separate leadership flag sits beside a free-text title, as in today's code, so a
-- team role can be a leader whatever its position maps to
pred leadershipFlagBesidePosition {
  all r: Role | some r.position implies
    (r.type = r.position.roleType or (r.scope in Team and r.type in Member + Leader))
}

-- the units whose seats decide the reach of each role (constrained by the policy)
one sig ReachBasis { via: Role -> Scope }

pred reachFollowsTheUnit { ReachBasis.via = Role <: scope }
-- MUTANT (A): a seat also reaches wherever a seat with the same position title sits
pred reachFollowsThePositionLabel {
  ReachBasis.via = (Role <: scope) + { r: Role, u: Scope |
    some r.position and some x: Role | some x.position and x.position.title = r.position.title and u = x.scope }
}

fun reach[r: Role, a: Action]: set Scope {
  (a in caps[r]) => Seat.at[r.(ReachBasis.via)] else none
}

--------------------------------------------------------------------------------------------
-- Principal algebra
--------------------------------------------------------------------------------------------

abstract sig Principal {}
sig Account extends Principal { person: one Person }
sig ServicePrincipal extends Principal { operator: lone Person }   -- operator: only mutant B uses it
abstract sig BearerCapability extends Principal { binds: set Resource, allows: one Action }
-- an OAuth client; registeredAs: only mutant N1 uses it
sig Client { registeredAs: lone ServicePrincipal }
sig Bot in Client {}                               -- a natural-language agent
sig ClaimCapability, InvitationCapability extends BearerCapability {}

sig Disabled in Account + ServicePrincipal {}   -- disabled account access, or a disabled service principal
sig Revoked in BearerCapability {}              -- a revoked or superseded link
var sig Consumed in BearerCapability {}
var sig UsedNow in BearerCapability {}          -- the capability that the transition leaving this state uses

fact capabilityShapes {
  all c: ClaimCapability | c.allows = ClaimNewAccount and c.binds in ClaimTarget
  all c: InvitationCapability | c.allows = RespondToInvitation and c.binds in InvitationTarget
}

pred capabilityBindsOne { all c: BearerCapability | one c.binds }
-- MUTANT (F1): a capability may bind several resources
pred capabilityBindsSome { all c: BearerCapability | some c.binds }

abstract sig Credential { principal: one Principal }
sig CookieCredential, MachineCredential, CapabilityCredential extends Credential {}
-- an account bearer: an OAuth client acting for the account's person, narrowed by its token scope
sig UserBearerCredential extends Credential { client: one Client, tokenScope: set Action }

fact credentialShapes {
  CookieCredential.principal in Account
  UserBearerCredential.principal in Account
  MachineCredential.principal in ServicePrincipal
  CapabilityCredential.principal in BearerCapability
}

fun kindOf: Credential -> Kind {
  CookieCredential -> CookieKind + UserBearerCredential -> UserBearerKind
  + MachineCredential -> MachineKind + CapabilityCredential -> CapabilityKind
}

-- evidence is a token presented as a named requirement, not as a principal
sig Request { presents: set Credential, evidence: lone BearerCapability, action: one Action, target: one Scope }

fact requestShapes {
  -- one request carries at most one session cookie, one Authorization header and one capability token
  all q: Request | lone (q.presents & CookieCredential)
    and lone (q.presents & (UserBearerCredential + MachineCredential))
    and lone (q.presents & CapabilityCredential)
  all q: Request | some q.evidence implies q.action = ClaimExistingAccount
}

-- the requests whose change the person confirmed
sig Confirmed in Request {}

one sig Resolution { chosen: Request -> lone Principal }

-- exactly one presented credential, of a kind that the endpoint accepts
pred resolveExactlyOne {
  all q: Request | Resolution.chosen[q] =
    ((one q.presents and q.presents.kindOf in q.action.accepts) => q.presents.principal else none)
}
-- MUTANT (E1): a session cookie silently wins when several credentials are presented
pred resolvePreferSession {
  all q: Request | Resolution.chosen[q] =
    ((one (q.presents & CookieCredential) and CookieKind in q.action.accepts)
       => (q.presents & CookieCredential).principal
       else ((one q.presents and q.presents.kindOf in q.action.accepts) => q.presents.principal else none))
}
-- MUTANT (E2): the Authorization header silently wins on person endpoints. Capability endpoints
-- read only the token. An endpoint that also accepts machines rejects a bearer with a cookie.
fun bearerFirst[q: Request]: set Principal {
  let tokens = q.presents & CapabilityCredential,
      bearers = q.presents & (UserBearerCredential + MachineCredential),
      cookies = q.presents & CookieCredential |
    (q.action.accepts = CapabilityKind) => tokens.principal
    else ((MachineKind in q.action.accepts and some bearers and some cookies) => none
    else ((some bearers) => ((bearers.kindOf in q.action.accepts) => bearers.principal else none)
    else cookies.principal))
}
pred resolvePreferBearer { all q: Request | Resolution.chosen[q] = bearerFirst[q] }
-- MUTANT (E3): an invitation endpoint reads only its token and ignores a second credential
pred resolveInvitationTokenOnly {
  all q: Request | Resolution.chosen[q] =
    ((q.action = RespondToInvitation) => (q.presents & CapabilityCredential).principal
     else ((one q.presents and q.presents.kindOf in q.action.accepts) => q.presents.principal else none))
}

one sig Binding { boundPerson: Principal -> lone Person }

pred accountsBindPersons { Binding.boundPerson = Account <: person }
-- MUTANT (B): a machine runs as the person who operates it
pred machinesRunAsOperator { Binding.boundPerson = (Account <: person) + (ServicePrincipal <: operator) }

pred usable[p: Principal] { p not in Disabled + Revoked + Consumed }

--------------------------------------------------------------------------------------------
-- Named requirements
--------------------------------------------------------------------------------------------

abstract sig Requirement {}
one sig ClaimToken, InterviewerAppointment, ChangeConfirmation, DepartmentBoardCertificates extends Requirement {}

-- the named requirements in force (constrained by the policy)
one sig InForce { rules: set Requirement }

pred everyRequirementInForce { InForce.rules = Requirement }
-- MUTANT (F3): the existing-account claim does not require its token
pred claimTokenNotRequired { InForce.rules = Requirement - ClaimToken }
-- MUTANT (I): an interviewer schedules without an appointment in the interview's department
pred interviewerAppointmentNotRequired { InForce.rules = Requirement - InterviewerAppointment }
-- MUTANT (N3): a bot changes data without the person's confirmation
pred changeConfirmationNotRequired { InForce.rules = Requirement - ChangeConfirmation }
-- MUTANT (W): any board seat issues certificates, a Hovedstyret seat included
pred certificatesFromAnyBoard { InForce.rules = Requirement - DepartmentBoardCertificates }

-- the departments in which an appointment's unit serves
fun unitDepartments[r: Role]: set Scope { (r.scope.*within + Seat.at[r.scope].*~within) & Department }

pred appointedIn[p: set Person, d: set Scope, roles: set Role] {
  some r: roles | r.holder in p and r.type in Appointments and d in unitDepartments[r]
}

-- InterviewerAppointment: an interviewer schedules only while holding an appointment in the
-- interview's department
-- DepartmentBoardCertificates: a board seat issues certificates only on the board of the target's
-- department, or on Hovedstyret for a department that is not independent
pred requirementsHoldAmong[r: Role, a: Action, s: Scope, roles: set Role] {
  (InterviewerAppointment in InForce.rules and r.type = Interviewer and a = ScheduleInterview)
    implies appointedIn[r.holder, departmentOf[s], roles]
  (DepartmentBoardCertificates in InForce.rules and r.type in BoardTypes and a = IssueCertificates)
    implies (r.scope in Styret
             or (HovedstyretIssuesNoCertificates not in Broken.rule                   -- MUTANT (W2)
                 and r.scope = Hovedstyret and some departmentOf[s] and departmentOf[s] not in Independent))
}

-- ClaimToken: a usable claim capability, presented as evidence, binds the claim target
pred tokenValid[q: Request] { some c: q.evidence & ClaimCapability | usable[c] and q.target in c.binds }

-- ChangeConfirmation, and the token scope: an on-behalf request stays inside its token scope, and
-- a bot changes nothing without the person's confirmation
pred onBehalfNarrowed[q: Request] {
  all c: q.presents & UserBearerCredential {
    TokenScopeIgnored not in Broken.rule implies q.action in c.tokenScope     -- MUTANT (N2)
    (ChangeConfirmation in InForce.rules and c.client in Bot and q.action not in ReadActions)
      implies q in Confirmed
  }
}

--------------------------------------------------------------------------------------------
-- Principal-side grants
--------------------------------------------------------------------------------------------

abstract sig Grant {
  subject: one (Person + ServicePrincipal),
  actions: some Action,
  area: one Scope,
  gstart: one Instant,
  var gfinish: lone Instant
}
sig GlobalAdministration, PaymentAuthority, MachineGrant extends Grant {}

pred grantCapabilitiesExplicit {
  all g: GlobalAdministration | g.subject in Person and g.area = Organization
    and g.actions in SystemAdministration + ManageAppointments + MaintainInterviewStaffing
                     + CoordinatePlacements + ManageDelegations + IssueCertificates
  all g: PaymentAuthority | g.subject in Person and g.actions = SubmitReceipt and g.area in Department
  all g: MachineGrant | g.subject in ServicePrincipal and g.actions = ApproveReceipt and g.area in Receipt
}
-- MUTANT (H): global administration as an implicit superuser
pred administrationGrantsEverything {
  all g: GlobalAdministration | g.subject in Person and g.area = Organization and g.actions = Action
  all g: PaymentAuthority | g.subject in Person and g.actions = SubmitReceipt and g.area in Department
  all g: MachineGrant | g.subject in ServicePrincipal and g.actions = ApproveReceipt and g.area in Receipt
}

pred grantActive[g: Grant] { lte[g.gstart, Clock.now] and (no g.gfinish or lt[Clock.now, g.gfinish]) }

one sig Veto { var vetoed: Person -> Action }

pred noVeto { always no Veto.vetoed }
-- MUTANT (G): a person whose global-administration grants have all ended loses the role
-- authority that a shared actor mapper decides (scheduling and placement coordination)
pred vetoByEndedAdministration {
  always Veto.vetoed = { p: Person, a: ScheduleInterview + CoordinatePlacements |
    some (GlobalAdministration & subject.p) and no g: GlobalAdministration & subject.p | grantActive[g] }
}

--------------------------------------------------------------------------------------------
-- Delegations
--------------------------------------------------------------------------------------------

-- team T holds capability C in area A, from dstart until dfinish; the atom is the name. The area
-- is the team's home, or, for a national team, a department or the whole organization.
sig Delegation {
  team: one Team,
  capability: one Action,
  area: one Scope,
  issuer: one Request,       -- the request that created it; permitted when the delegation starts
  dstart: one Instant,
  var dfinish: lone Instant
}
-- the delegations that reach only the current leaders of their team
sig LeaderDelegation in Delegation {}

-- the rule that the policy breaks, if any; the delegation and on-behalf rules read it
one sig Broken { rule: lone Mutant }

pred delegationsCarryDelegableActions { all g: Delegation | g.capability in Delegable }

-- settlement reaches only the leaders of the team that it names: the finance lead pays out
pred settlementReachesLeaders { all g: Delegation | g.capability = SettleReceipt implies g in LeaderDelegation }
-- MUTANT (R): a settlement delegation may reach every member of the team
pred settlementMayReachMembers {}
-- MUTANT (K3): a delegation may carry system administration
pred delegationsMayCarrySystemAdministration {
  all g: Delegation | g.capability in Delegable + SystemAdministration
}

-- a delegation stays inside its team's area
pred delegationsStayInTheirTeamArea {
  all g: Delegation | g.area in Department + Organization and covers[TeamAreas.of[g.team], g.area]
}
-- MUTANT (O1): the area of a delegation is not checked against its team's area
pred delegationAreaUnbounded { all g: Delegation | g.area in Department + Organization }

-- the manager of a delegation needs ManageDelegations over the team's area: a Styret leader for
-- a team of its department; Hovedstyret or a global administrator for a national team
pred delegationsIssuedOverTheTeamArea {
  all g: Delegation | g.issuer.action = ManageDelegations and g.issuer.target = TeamAreas.of[g.team]
}
-- MUTANT (O2): the manager is checked against the team's home department, not its area
pred delegationsIssuedAtTheHome {
  all g: Delegation | g.issuer.action = ManageDelegations and g.issuer.target = g.team.within
}

-- the state in which a delegation is created: the first state at its start instant
pred issuance[g: Delegation] { Clock.now = g.dstart and not before Clock.now = g.dstart }
fun issuerPerson[g: Delegation]: set Person { Binding.boundPerson[Resolution.chosen[g.issuer]] }

pred delegationsPermittedWhenIssued { always all g: Delegation | issuance[g] implies permitted[g.issuer] }

pred delegationActive[g: Delegation] {
  lte[g.dstart, Clock.now]
  (no g.dfinish or lt[Clock.now, g.dfinish] or DelegationOutlivesItsEnd in Broken.rule)   -- MUTANT (M3)
}

-- the scopes where a team role holds action a through an active delegation
fun delegatedReach[r: Role, a: Action]: set Scope {
  { s: Scope | r.type in Member + Leader and some g: Delegation |
      delegationActive[g] and g.capability = a
      and (g in LeaderDelegation implies r.type = Leader)
      and (g.team = r.scope or (DelegationToDepartmentTeams in Broken.rule and g.team.within = r.scope.within))   -- MUTANT (M1)
      and s = ((DelegationReachesEveryDepartment in Broken.rule) => Organization else g.area) }               -- MUTANT (M2)
}

--------------------------------------------------------------------------------------------
-- permit
--------------------------------------------------------------------------------------------

fun witnessesAmong[p: Person, a: Action, s: Scope, roles: set Role]: set Role {
  { r: roles | r.holder = p and covers[reach[r, a] + delegatedReach[r, a], s] and requirementsHoldAmong[r, a, s, roles] }
}
fun witnesses[p: Person, a: Action, s: Scope]: set Role { witnessesAmong[p, a, s, Effective] }

pred rolePermit[p: Person, a: Action, s: Scope] { p -> a not in Veto.vetoed and some witnesses[p, a, s] }

pred grantCovers[subj: Person + ServicePrincipal, a: Action, s: Scope] {
  some g: Grant | g.subject = subj and a in g.actions and covers[g.area, s] and grantActive[g]
}

pred capabilityCovers[c: BearerCapability, a: Action, s: Scope] { a = c.allows and s in c.binds }

-- the existing-account claim: the session is the principal and the token is a requirement
pred existingAccountClaim[p: Principal, q: Request] {
  p in Account and q.action = ClaimExistingAccount and (ClaimToken in InForce.rules implies tokenValid[q])
}

pred permitted[q: Request] {
  some p: Resolution.chosen[q] | usable[p] and onBehalfNarrowed[q] and (
       (some Binding.boundPerson[p] and
          (rolePermit[Binding.boundPerson[p], q.action, q.target]
           or grantCovers[Binding.boundPerson[p], q.action, q.target]))
    or (p in ServicePrincipal and grantCovers[p, q.action, q.target])
    or (p in BearerCapability and capabilityCovers[p, q.action, q.target])
    or existingAccountClaim[p, q]
    or (ClientGrantLeaks in Broken.rule and                                            -- MUTANT (N1)
          some c: q.presents & UserBearerCredential | grantCovers[c.client.registeredAs, q.action, q.target]))
}

-- permitted through a principal-side grant
pred grantPermit[q: Request] {
  some p: Resolution.chosen[q] | usable[p] and
    ((some Binding.boundPerson[p] and grantCovers[Binding.boundPerson[p], q.action, q.target])
     or (p in ServicePrincipal and grantCovers[p, q.action, q.target]))
}

--------------------------------------------------------------------------------------------
-- Events
--------------------------------------------------------------------------------------------

pred init {
  Clock.now = first
  no Consumed
  all r: Role | some r.finish implies lt[r.start, r.finish]
  all g: Grant | some g.gfinish implies lt[g.gstart, g.gfinish]
  all g: Delegation | some g.dfinish implies lt[g.dstart, g.dfinish]
}

pred unchangedExcept[roles: set Role, grants: set Grant] {
  all x: Role - roles | x.finish' = x.finish and (x in Suspended' iff x in Suspended)
  all g: Grant - grants | g.gfinish' = g.gfinish
  all e: Delegation | e.dfinish' = e.dfinish
}

pred tick {
  some Clock.now.next and Clock.now' = Clock.now.next
  unchangedExcept[none, none] and Consumed' = Consumed and no UsedNow
}

pred skip {
  Clock.now' = Clock.now
  unchangedExcept[none, none] and Consumed' = Consumed and no UsedNow
}

pred endRole[r: Role] {
  no r.gate and lt[r.start, Clock.now] and unfinished[r]
  r.finish' = Clock.now and (r in Suspended' iff r in Suspended)
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred suspendRole[r: Role] {
  no r.gate and r not in Suspended and Suspended' = Suspended + r and r.finish' = r.finish
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred reinstateRole[r: Role] {
  no r.gate and r in Suspended and Suspended' = Suspended - r and r.finish' = r.finish
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred endGrant[g: Grant] {
  lt[g.gstart, Clock.now] and (no g.gfinish or lt[Clock.now, g.gfinish]) and g.gfinish' = Clock.now
  Clock.now' = Clock.now and unchangedExcept[none, g] and Consumed' = Consumed and no UsedNow
}

pred endDelegation[g: Delegation] {
  lt[g.dstart, Clock.now] and (no g.dfinish or lt[Clock.now, g.dfinish]) and g.dfinish' = Clock.now
  all e: Delegation - g | e.dfinish' = e.dfinish
  all x: Role | x.finish' = x.finish and (x in Suspended' iff x in Suspended)
  all h: Grant | h.gfinish' = h.gfinish
  Clock.now' = Clock.now and Consumed' = Consumed and no UsedNow
}

-- a new-account claim uses its token as the principal and consumes it
pred claimNewAccount[q: Request] {
  q.action = ClaimNewAccount and permitted[q]
  Consumed' = Consumed + Resolution.chosen[q] and UsedNow = Resolution.chosen[q]
  Clock.now' = Clock.now and unchangedExcept[none, none]
}
-- MUTANT (F2): the new-account claim does not record that its token is consumed
pred claimNewAccountForgets[q: Request] {
  q.action = ClaimNewAccount and permitted[q]
  Consumed' = Consumed and UsedNow = Resolution.chosen[q]
  Clock.now' = Clock.now and unchangedExcept[none, none]
}

-- an existing-account claim uses the session as the principal and consumes the token it presents
pred claimExistingAccount[q: Request] {
  q.action = ClaimExistingAccount and permitted[q]
  Consumed' = Consumed + q.evidence and UsedNow = q.evidence
  Clock.now' = Clock.now and unchangedExcept[none, none]
}
-- MUTANT (F2): the existing-account claim does not record that its token is consumed
pred claimExistingAccountForgets[q: Request] {
  q.action = ClaimExistingAccount and permitted[q]
  Consumed' = Consumed and UsedNow = q.evidence
  Clock.now' = Clock.now and unchangedExcept[none, none]
}

-- MUTANT (C): ending a leadership also ends the holder's other roles in that department
pred endRoleCascading[r: Role] {
  no r.gate and lt[r.start, Clock.now] and unfinished[r]
  let doomed = r + { x: Role - r | no x.gate and r.type = Leader and x.holder = r.holder
                       and some (departmentOf[x.scope] & departmentOf[r.scope])
                       and lt[x.start, Clock.now] and unfinished[x] } | {
    all x: doomed | x.finish' = Clock.now and (x in Suspended' iff x in Suspended)
    unchangedExcept[doomed, none]
  }
  Clock.now' = Clock.now and Consumed' = Consumed and no UsedNow
}

-- MUTANT (D): suspending an affiliation also suspends the holder's placements in that department
pred suspendRoleCascading[r: Role] {
  no r.gate and r not in Suspended
  let hit = r + { x: Role | r.type = Assistant and x.type = PlacedAssistant and x.holder = r.holder
                    and departmentOf[x.scope] = r.scope } | {
    Suspended' = Suspended + hit
    all x: hit | x.finish' = x.finish
    unchangedExcept[hit, none]
  }
  Clock.now' = Clock.now and Consumed' = Consumed and no UsedNow
}

--------------------------------------------------------------------------------------------
-- The policy, and the mutants that each break one rule
--------------------------------------------------------------------------------------------

abstract sig Mutant {}
one sig ReachByPositionLabel, MachinesRunAsOperator, StaleLeadership, CascadingEnd, CascadingSuspend,
        PreferSession, PreferBearer, CapabilityBindsSome, ForgetfulNewAccountClaim,
        ForgetfulExistingAccountClaim, ClaimWithoutToken, VetoByEndedAdministration,
        AdministrationGrantsEverything, InterviewerWithoutAppointment, EveryBoardSitsNationally,
        HovedstyretSitsAtItsOwnNode, HovedstyretSeatCarriesSystemAdministration, InvitationTokenOnly,
        LeadersReachTheirDepartment, DelegationToDepartmentTeams, DelegationReachesEveryDepartment,
        DelegationOutlivesItsEnd, DelegationCarriesSystemAdministration, StyretMembersAdministerTheDepartment,
        LeadershipFlagBesidePosition, DelegationAreaUnbounded, DelegationCheckedAtHome, NationalByHome,
        DerivedSeatOutlivesLeadership, ClientGrantLeaks, TokenScopeIgnored,
        BotChangeWithoutConfirmation, NationalLeaderSeatAtHome, StyretGovernsWithoutIndependence,
        HovedstyretGovernsOnlyNationalTeams, CertificatesFromAnyBoard, SettlementReachesMembers,
        HovedstyretIssuesNoCertificates, ClaimByBearer extends Mutant {}

pred anyEventWith[m: lone Mutant] {
  tick or skip or (some g: Grant | endGrant[g]) or (some g: Delegation | endDelegation[g])
  or (some q: Request |
        ((m = ForgetfulNewAccountClaim) => claimNewAccountForgets[q] else claimNewAccount[q])
     or ((m = ForgetfulExistingAccountClaim) => claimExistingAccountForgets[q] else claimExistingAccount[q]))
  or (some r: Role |
        ((m = CascadingEnd) => endRoleCascading[r] else endRole[r])
     or ((m = CascadingSuspend) => suspendRoleCascading[r] else suspendRole[r])
     or reinstateRole[r])
}

-- the intended policy, or the intended policy with exactly the rule of mutant m broken
pred policyWith[m: lone Mutant] {
  Broken.rule = m
  (m = LeadersReachTheirDepartment) => leadersAdministerTheirDepartment
    else ((m = StyretMembersAdministerTheDepartment) => styretMembersAdministerTheDepartment
    else (capabilityTable and ((m = ReachByPositionLabel) => reachFollowsThePositionLabel else reachFollowsTheUnit)))
  (m = LeadershipFlagBesidePosition) => leadershipFlagBesidePosition else typeFollowsPosition
  (m = HovedstyretSeatCarriesSystemAdministration) => hovedstyretSeatsCarrySystemAdministration
    else noExtraCapabilities
  (m = DelegationCarriesSystemAdministration) => delegationsMayCarrySystemAdministration
    else delegationsCarryDelegableActions
  (m = DelegationAreaUnbounded) => delegationAreaUnbounded else delegationsStayInTheirTeamArea
  (m = DelegationCheckedAtHome) => delegationsIssuedAtTheHome else delegationsIssuedOverTheTeamArea
  (m = NationalByHome) => nationalByHome else teamAreaIsItsScope
  (m = SettlementReachesMembers) => settlementMayReachMembers else settlementReachesLeaders
  (m = ClaimByBearer) => claimByAnyAccountCredential else claimBySessionOnly
  delegationsPermittedWhenIssued
  (m = AdministrationGrantsEverything) => administrationGrantsEverything else grantCapabilitiesExplicit
  (m = EveryBoardSitsNationally) => everyBoardSitsNationally
    else ((m = HovedstyretSitsAtItsOwnNode) => hovedstyretSitsAtItsOwnNode
    else ((m = StyretGovernsWithoutIndependence) => styretGovernsWithoutIndependence
    else ((m = HovedstyretGovernsOnlyNationalTeams) => hovedstyretGovernsOnlyNationalTeams
    else boardsSitWhereTheyServe)))
  (m = NationalLeaderSeatAtHome) => nationalLeadersSitAtHome else leadersSitOnTheGoverningBoard
  (m = ClaimWithoutToken) => claimTokenNotRequired
    else ((m = InterviewerWithoutAppointment) => interviewerAppointmentNotRequired
    else ((m = BotChangeWithoutConfirmation) => changeConfirmationNotRequired
    else ((m = CertificatesFromAnyBoard) => certificatesFromAnyBoard else everyRequirementInForce)))
  (m = StaleLeadership) => effectiveStaleLeadership
    else ((m = DerivedSeatOutlivesLeadership) => effectiveDerivedSeatAsCopy else effectiveByOwnState)
  (m = PreferSession) => resolvePreferSession
    else ((m = PreferBearer) => resolvePreferBearer
    else ((m = InvitationTokenOnly) => resolveInvitationTokenOnly else resolveExactlyOne))
  (m = MachinesRunAsOperator) => machinesRunAsOperator else accountsBindPersons
  (m = CapabilityBindsSome) => capabilityBindsSome else capabilityBindsOne
  (m = VetoByEndedAdministration) => vetoByEndedAdministration else noVeto
  init
  always anyEventWith[m]
}

pred policy { policyWith[none] }

--------------------------------------------------------------------------------------------
-- Properties
--------------------------------------------------------------------------------------------

-- (A) no local label confers national scope
pred noLocalLabelConfersNationalScope {
  all r: Role, a: Action | r.scope in Local implies reach[r, a] in Local
}

-- (B) a service principal never acquires a human role
pred servicePrincipalAcquiresNoHumanRole {
  no Binding.boundPerson[ServicePrincipal]
  always all q: Request | (some (Resolution.chosen[q] & ServicePrincipal) and permitted[q])
    implies grantCovers[Resolution.chosen[q], q.action, q.target]
}

pred ends[r: Role] { unfinished[r] and r.finish' = Clock.now }
pred suspends[r: Role] { r not in Suspended and r in Suspended' }
pred reinstates[r: Role] { r in Suspended and r not in Suspended' }

-- (C) ending a role revokes only the authority that depended on it: afterwards a permit holds
--     exactly when another witness remains whose requirements hold without the ended role. This
--     includes "the end of the last leadership appointment revokes only its scope".
pred endingARoleRevokesOnlyItsScope {
  always all x: Role | ends[x] implies
    (all p: Person, a: Action, s: Scope |
       (after rolePermit[p, a, s]) iff some witnessesAmong[p, a, s, Effective - x - gate.x])
}

-- (D) suspending, reinstating or ending one role changes no other role; only declared
--     refinements (a derived Styret seat under its team leadership) may lose effect
pred roleEventTouchesOnlyThatRole {
  always all r: Role | (ends[r] or suspends[r] or reinstates[r]) implies {
    all x: Role - r | x.finish' = x.finish and (x in Suspended' iff x in Suspended)
    all x: Role - r - gate.r | (x in Effective') iff (x in Effective)
  }
}

-- (E) exactly one principal per permitted request; a requirement token is not a credential
pred exactlyOnePrincipalPerRequest {
  always all q: Request | permitted[q] implies (one q.presents and Resolution.chosen[q] = q.presents.principal)
}

-- the claim token of a request: the principal of a new-account claim, the evidence of an
-- existing-account claim
fun claimTokenOf[q: Request]: set BearerCapability {
  (q.action = ClaimNewAccount) => (Resolution.chosen[q] & ClaimCapability) else (q.evidence & ClaimCapability)
}

-- (F1) a claim capability binds one resource and authorizes only that resource, in both modes
pred claimCapabilityBindsOneResource {
  all c: ClaimCapability | one c.binds
  always all q: Request | (permitted[q] and q.action in ClaimNewAccount + ClaimExistingAccount)
    implies (one claimTokenOf[q] and q.target = claimTokenOf[q].binds)
}

-- (F2) a claim capability is single-use, in both modes
pred claimCapabilityIsSingleUse {
  always all c: ClaimCapability | c in UsedNow implies after always c not in UsedNow
}

-- (F3) the existing-account claim acts for the session's account and needs a valid token
pred existingAccountClaimNeedsSessionAndToken {
  always all q: Request | (permitted[q] and q.action = ClaimExistingAccount)
    implies (Resolution.chosen[q] in Account and tokenValid[q])
}

pred endsGrant[g: Grant] { (no g.gfinish or lt[Clock.now, g.gfinish]) and g.gfinish' = Clock.now }

-- (G) ending a principal-side grant never removes role-derived authority
pred endingAGrantKeepsRoleAuthority {
  always all g: Grant | endsGrant[g] implies
    (all p: Person, a: Action, s: Scope | rolePermit[p, a, s] implies after rolePermit[p, a, s])
}

-- (H) global administration grants no team-application authority and no assessment authority
pred administrationGrantsNoTeamApplicationOrAssessmentAuthority {
  always all q: Request |
    (permitted[q] and q.action in ReadTeamApplications + ManageTeamApplications + AssessInterview + CorrectAssessment)
      implies rolePermit[Binding.boundPerson[Resolution.chosen[q]], q.action, q.target]
}

-- (I) an interviewer who schedules holds an appointment in the interview's department
pred interviewerSchedulesOnlyWhileAppointed {
  always all r: Effective, i: Interview | (r.type = Interviewer and r in witnesses[r.holder, ScheduleInterview, i])
    implies appointedIn[r.holder, departmentOf[i], Effective]
}

-- (L) a team role reaches only its own team: an ordinary team leader acts within the team
pred teamRolesStayInTheirTeam {
  all r: Role, a: Action | r.type in Member + Leader implies reach[r, a] in r.scope.*~within
}

-- (M1) a delegation serves only the members of the team that it names
pred delegationServesOnlyItsTeam {
  always all r: Effective, a: Action | some delegatedReach[r, a] implies
    some g: Delegation | g.team = r.scope and g.capability = a
}

-- (M2) a delegation reaches only the area that it names
pred delegationReachesOnlyItsArea {
  always all r: Effective, a: Action, s: Scope | covers[delegatedReach[r, a], s] implies
    some g: Delegation | g.capability = a and covers[g.area, s]
}

-- (M3) a delegation confers nothing outside its interval
pred delegationConfersNothingOutsideItsInterval {
  always all r: Effective, a: Action | some delegatedReach[r, a] implies
    some g: Delegation | g.capability = a and lte[g.dstart, Clock.now] and (no g.dfinish or lt[Clock.now, g.dfinish])
}

-- (K1) a Styret role never reaches another department
pred styretNeverReachesAnotherDepartment {
  all r: Role, a: Action | r.scope in Styret implies
    no d: Department - departmentOf[r.scope] | covers[reach[r, a], d]
}

-- (K2) a Hovedstyret role reaches every department
pred hovedstyretReachesEveryDepartment {
  all r: Role, a: Action | (r.scope = Hovedstyret and a in caps[r]) implies
    all d: Department | covers[reach[r, a], d]
}

-- (K3) a Hovedstyret role confers no principal-side grant: system administration is permitted
--      only through an active grant, whatever seats the person holds
pred hovedstyretConfersNoPrincipalSideGrant {
  always all q: Request | (permitted[q] and q.action in SystemAdministration) implies grantPermit[q]
}

-- (P) authority follows the position's one role type: every stored appointment has the type that
--     its position maps to, so the holders of one position hold the same authority
pred authorityFollowsThePositionsRoleType {
  all r: Role | some r.position implies r.type = r.position.roleType
  all r1, r2: Role | (some r1.position and r1.position = r2.position) implies caps[r1] = caps[r2]
}

-- (Q1) a derived Styret seat ends when the team leadership that it follows ends
pred derivedSeatEndsWithTheLeadership {
  always all x: Role | some x.gate implies (x in Effective implies x.gate in Effective)
}

-- (Q2) a derived Styret seat confers no department administration: an ordinary team leader acts
--      within the team, also through the seat
pred derivedSeatConfersNoAdministration {
  all x: Role | some x.gate implies no caps[x] & (DepartmentAdministration + ManageDelegations)
}

-- (T) a team's home and its scope are separate: only a national team acts beyond its home
--     department through a delegation
pred onlyNationalTeamsReachBeyondTheirHome {
  always all r: Effective, a: Action, s: Scope |
    (r.scope in Team and r.scope.teamScope != Organization and covers[delegatedReach[r, a], s])
      implies covers[r.scope.within, s]
}

-- (O1) a Styret leader never delegates outside its department
pred styretLeaderDelegatesOnlyInItsDepartment {
  always all g: Delegation | issuance[g] implies
    (all r: witnesses[issuerPerson[g], ManageDelegations, g.issuer.target] | r.scope in Styret implies
       (g.team.teamScope = departmentOf[r.scope] and g.area = departmentOf[r.scope]))
}

-- (O2) a delegation to a national team needs national authority: a Hovedstyret role or a
--      global-administrator grant
pred nationalTeamDelegationNeedsNationalAuthority {
  always all g: Delegation | (issuance[g] and g.team.teamScope = Organization) implies
    ((some r: witnesses[issuerPerson[g], ManageDelegations, Organization] | r.scope = Hovedstyret)
     or grantCovers[issuerPerson[g], ManageDelegations, Organization])
}

-- (N1) an OAuth client acting for a person never exceeds the person's authority
pred onBehalfNeverExceedsThePerson {
  always all q: Request, c: q.presents & UserBearerCredential | permitted[q] implies
    (rolePermit[c.principal.person, q.action, q.target] or grantCovers[c.principal.person, q.action, q.target])
}

-- (N2) its token scope narrows it: a permitted on-behalf request stays inside the token scope
pred onBehalfStaysInTheTokenScope {
  always all q: Request, c: q.presents & UserBearerCredential | permitted[q] implies q.action in c.tokenScope
}

-- (N3) a bot changes nothing without the person's confirmation; it reads without one
pred botChangesOnlyWithConfirmation {
  always all q: Request, c: q.presents & UserBearerCredential |
    (permitted[q] and c.client in Bot and q.action not in ReadActions) implies q in Confirmed
}

-- (Q3) a national team's leader sits on Hovedstyret through a derived seat, not on the Styret of
--      the team's home department
pred nationalLeaderSitsOnHovedstyret {
  all r: Role | (r.type = Leader and r.scope in Team and r.scope.teamScope = Organization) implies
    ((some x: gate.r | x.scope = Hovedstyret) and (no x: gate.r | x.scope in Styret))
}

-- (X1) a department's board governs only an independent department: its roles reach nothing
--      while the department is not independent, and never another department
pred styretGovernsOnlyAnIndependentDepartment {
  all r: Role, a: Action | (r.scope in Styret and some reach[r, a]) implies
    (departmentOf[r.scope] in Independent and reach[r, a] = departmentOf[r.scope])
}

-- (X2) the teams of a department that is not independent, or that has no board, fall under
--      Hovedstyret: a Hovedstyret role that manages delegations reaches them
pred hovedstyretReachesTheTeamsOfDependentDepartments {
  all r: Role, t: Team |
    (r.scope = Hovedstyret and ManageDelegations in caps[r]
      and (t.within not in Independent or no (Styret & within.(t.within))))
    implies covers[reach[r, ManageDelegations], t]
}

-- (W) certificates come from the board of an independent department, from a Hovedstyret seat for a
--     department that is not independent, or from a global-administrator grant
pred certificatesComeFromTheDepartmentBoard {
  always all q: Request | (permitted[q] and q.action = IssueCertificates) implies
    (grantPermit[q]
     or some r: witnesses[Binding.boundPerson[Resolution.chosen[q]], IssueCertificates, q.target] |
          r.scope in Styret or (r.scope = Hovedstyret and departmentOf[q.target] not in Independent))
}

-- (W2) a Hovedstyret seat issues certificates for a department that is not independent
pred hovedstyretIssuesCertificatesForDependentDepartments {
  always all r: Effective, d: Department | (r.scope = Hovedstyret and r.type in BoardTypes and d not in Independent)
    implies rolePermit[r.holder, IssueCertificates, d]
}

-- (R) only a leader of the delegated team records settlement: every member of the economy team
--     approves, and its leader, the finance lead, pays out
pred settlementNeedsTheTeamLeader {
  always all q: Request | (permitted[q] and q.action = SettleReceipt) implies
    (grantPermit[q]
     or some r: witnesses[Binding.boundPerson[Resolution.chosen[q]], SettleReceipt, q.target] | r.type = Leader)
}

-- (F4) only a session cookie makes the existing-account claim; a bearer cannot
pred existingAccountClaimBySessionOnly {
  always all q: Request | (permitted[q] and q.action = ClaimExistingAccount) implies q.presents in CookieCredential
}

-- sanity: the events keep every role interval ordered
pred intervalsStayOrdered { always all r: Role | some r.finish implies lt[r.start, r.finish] }

--------------------------------------------------------------------------------------------
-- Assertions: correct checks expect 0, mutant checks expect 1
--------------------------------------------------------------------------------------------

assert A_NoLocalLabelConfersNationalScope { policy implies noLocalLabelConfersNationalScope }
assert A_NoLocalLabelConfersNationalScope_mutantPositionLabel {
  policyWith[ReachByPositionLabel] implies noLocalLabelConfersNationalScope
}

assert B_ServicePrincipalAcquiresNoHumanRole { policy implies servicePrincipalAcquiresNoHumanRole }
assert B_ServicePrincipalAcquiresNoHumanRole_mutantRunAs {
  policyWith[MachinesRunAsOperator] implies servicePrincipalAcquiresNoHumanRole
}

assert C_EndingARoleRevokesOnlyItsScope { policy implies endingARoleRevokesOnlyItsScope }
assert C_EndingARoleRevokesOnlyItsScope_mutantStale {
  policyWith[StaleLeadership] implies endingARoleRevokesOnlyItsScope
}
assert C_EndingARoleRevokesOnlyItsScope_mutantCascade {
  policyWith[CascadingEnd] implies endingARoleRevokesOnlyItsScope
}

assert D_RoleEventTouchesOnlyThatRole { policy implies roleEventTouchesOnlyThatRole }
assert D_RoleEventTouchesOnlyThatRole_mutantCascade {
  policyWith[CascadingSuspend] implies roleEventTouchesOnlyThatRole
}

assert E_ExactlyOnePrincipalPerRequest { policy implies exactlyOnePrincipalPerRequest }
assert E_ExactlyOnePrincipalPerRequest_mutantPreferSession {
  policyWith[PreferSession] implies exactlyOnePrincipalPerRequest
}
assert E_ExactlyOnePrincipalPerRequest_mutantPreferBearer {
  policyWith[PreferBearer] implies exactlyOnePrincipalPerRequest
}
assert E_ExactlyOnePrincipalPerRequest_mutantInvitationTokenOnly {
  policyWith[InvitationTokenOnly] implies exactlyOnePrincipalPerRequest
}

assert F1_ClaimCapabilityBindsOneResource { policy implies claimCapabilityBindsOneResource }
assert F1_ClaimCapabilityBindsOneResource_mutantBindsSome {
  policyWith[CapabilityBindsSome] implies claimCapabilityBindsOneResource
}

assert F2_ClaimCapabilityIsSingleUse { policy implies claimCapabilityIsSingleUse }
assert F2_ClaimCapabilityIsSingleUse_mutantForgetsNewAccount {
  policyWith[ForgetfulNewAccountClaim] implies claimCapabilityIsSingleUse
}
assert F2_ClaimCapabilityIsSingleUse_mutantForgetsExistingAccount {
  policyWith[ForgetfulExistingAccountClaim] implies claimCapabilityIsSingleUse
}

assert F3_ExistingAccountClaimNeedsSessionAndToken { policy implies existingAccountClaimNeedsSessionAndToken }
assert F3_ExistingAccountClaimNeedsSessionAndToken_mutantWithoutToken {
  policyWith[ClaimWithoutToken] implies existingAccountClaimNeedsSessionAndToken
}

assert G_EndingAGrantKeepsRoleAuthority { policy implies endingAGrantKeepsRoleAuthority }
assert G_EndingAGrantKeepsRoleAuthority_mutantVeto {
  policyWith[VetoByEndedAdministration] implies endingAGrantKeepsRoleAuthority
}

assert H_AdministrationGrantsNoTeamApplicationOrAssessmentAuthority {
  policy implies administrationGrantsNoTeamApplicationOrAssessmentAuthority
}
assert H_AdministrationGrantsNoTeamApplicationOrAssessmentAuthority_mutantEverything {
  policyWith[AdministrationGrantsEverything] implies administrationGrantsNoTeamApplicationOrAssessmentAuthority
}

assert I_InterviewerSchedulesOnlyWhileAppointed { policy implies interviewerSchedulesOnlyWhileAppointed }
assert I_InterviewerSchedulesOnlyWhileAppointed_mutantNoRequirement {
  policyWith[InterviewerWithoutAppointment] implies interviewerSchedulesOnlyWhileAppointed
}

assert K1_StyretNeverReachesAnotherDepartment { policy implies styretNeverReachesAnotherDepartment }
assert K1_StyretNeverReachesAnotherDepartment_mutantBoardsSitNationally {
  policyWith[EveryBoardSitsNationally] implies styretNeverReachesAnotherDepartment
}

assert K2_HovedstyretReachesEveryDepartment { policy implies hovedstyretReachesEveryDepartment }
assert K2_HovedstyretReachesEveryDepartment_mutantOwnNode {
  policyWith[HovedstyretSitsAtItsOwnNode] implies hovedstyretReachesEveryDepartment
}

assert K3_HovedstyretConfersNoPrincipalSideGrant { policy implies hovedstyretConfersNoPrincipalSideGrant }
assert K3_HovedstyretConfersNoPrincipalSideGrant_mutantSeatCarriesAdministration {
  policyWith[HovedstyretSeatCarriesSystemAdministration] implies hovedstyretConfersNoPrincipalSideGrant
}
assert K3_HovedstyretConfersNoPrincipalSideGrant_mutantDelegationCarriesAdministration {
  policyWith[DelegationCarriesSystemAdministration] implies hovedstyretConfersNoPrincipalSideGrant
}

assert L_TeamRolesStayInTheirTeam { policy implies teamRolesStayInTheirTeam }
assert L_TeamRolesStayInTheirTeam_mutantLeadersReachTheirDepartment {
  policyWith[LeadersReachTheirDepartment] implies teamRolesStayInTheirTeam
}

assert M1_DelegationServesOnlyItsTeam { policy implies delegationServesOnlyItsTeam }
assert M1_DelegationServesOnlyItsTeam_mutantDepartmentTeams {
  policyWith[DelegationToDepartmentTeams] implies delegationServesOnlyItsTeam
}

assert M2_DelegationReachesOnlyItsArea { policy implies delegationReachesOnlyItsArea }
assert M2_DelegationReachesOnlyItsArea_mutantEveryDepartment {
  policyWith[DelegationReachesEveryDepartment] implies delegationReachesOnlyItsArea
}

assert M3_DelegationConfersNothingOutsideItsInterval { policy implies delegationConfersNothingOutsideItsInterval }
assert M3_DelegationConfersNothingOutsideItsInterval_mutantOutlivesItsEnd {
  policyWith[DelegationOutlivesItsEnd] implies delegationConfersNothingOutsideItsInterval
}

assert O1_StyretLeaderDelegatesOnlyInItsDepartment { policy implies styretLeaderDelegatesOnlyInItsDepartment }
assert O1_StyretLeaderDelegatesOnlyInItsDepartment_mutantAreaUnbounded {
  policyWith[DelegationAreaUnbounded] implies styretLeaderDelegatesOnlyInItsDepartment
}

assert O2_NationalTeamDelegationNeedsNationalAuthority { policy implies nationalTeamDelegationNeedsNationalAuthority }
assert O2_NationalTeamDelegationNeedsNationalAuthority_mutantCheckedAtHome {
  policyWith[DelegationCheckedAtHome] implies nationalTeamDelegationNeedsNationalAuthority
}

assert P_AuthorityFollowsThePositionsRoleType { policy implies authorityFollowsThePositionsRoleType }
assert P_AuthorityFollowsThePositionsRoleType_mutantLeadershipFlag {
  policyWith[LeadershipFlagBesidePosition] implies authorityFollowsThePositionsRoleType
}

assert Q1_DerivedSeatEndsWithTheLeadership { policy implies derivedSeatEndsWithTheLeadership }
assert Q1_DerivedSeatEndsWithTheLeadership_mutantStoredCopy {
  policyWith[DerivedSeatOutlivesLeadership] implies derivedSeatEndsWithTheLeadership
}

assert Q2_DerivedSeatConfersNoAdministration { policy implies derivedSeatConfersNoAdministration }
assert Q2_DerivedSeatConfersNoAdministration_mutantStyretAdministers {
  policyWith[StyretMembersAdministerTheDepartment] implies derivedSeatConfersNoAdministration
}

assert T_OnlyNationalTeamsReachBeyondTheirHome { policy implies onlyNationalTeamsReachBeyondTheirHome }
assert T_OnlyNationalTeamsReachBeyondTheirHome_mutantNationalByHome {
  policyWith[NationalByHome] implies onlyNationalTeamsReachBeyondTheirHome
}

assert N1_OnBehalfNeverExceedsThePerson { policy implies onBehalfNeverExceedsThePerson }
assert N1_OnBehalfNeverExceedsThePerson_mutantClientGrantLeaks {
  policyWith[ClientGrantLeaks] implies onBehalfNeverExceedsThePerson
}

assert N2_OnBehalfStaysInTheTokenScope { policy implies onBehalfStaysInTheTokenScope }
assert N2_OnBehalfStaysInTheTokenScope_mutantScopeIgnored {
  policyWith[TokenScopeIgnored] implies onBehalfStaysInTheTokenScope
}

assert N3_BotChangesOnlyWithConfirmation { policy implies botChangesOnlyWithConfirmation }
assert N3_BotChangesOnlyWithConfirmation_mutantNoConfirmation {
  policyWith[BotChangeWithoutConfirmation] implies botChangesOnlyWithConfirmation
}

assert Q3_NationalLeaderSitsOnHovedstyret { policy implies nationalLeaderSitsOnHovedstyret }
assert Q3_NationalLeaderSitsOnHovedstyret_mutantSeatAtHome {
  policyWith[NationalLeaderSeatAtHome] implies nationalLeaderSitsOnHovedstyret
}

assert X1_StyretGovernsOnlyAnIndependentDepartment { policy implies styretGovernsOnlyAnIndependentDepartment }
assert X1_StyretGovernsOnlyAnIndependentDepartment_mutantWithoutIndependence {
  policyWith[StyretGovernsWithoutIndependence] implies styretGovernsOnlyAnIndependentDepartment
}

assert X2_HovedstyretReachesTheTeamsOfDependentDepartments { policy implies hovedstyretReachesTheTeamsOfDependentDepartments }
assert X2_HovedstyretReachesTheTeamsOfDependentDepartments_mutantOnlyNationalTeams {
  policyWith[HovedstyretGovernsOnlyNationalTeams] implies hovedstyretReachesTheTeamsOfDependentDepartments
}

assert W_CertificatesComeFromTheDepartmentBoard { policy implies certificatesComeFromTheDepartmentBoard }
assert W_CertificatesComeFromTheDepartmentBoard_mutantAnyBoard {
  policyWith[CertificatesFromAnyBoard] implies certificatesComeFromTheDepartmentBoard
}

assert W2_HovedstyretIssuesCertificatesForDependentDepartments {
  policy implies hovedstyretIssuesCertificatesForDependentDepartments
}
assert W2_HovedstyretIssuesCertificatesForDependentDepartments_mutantStyretOnly {
  policyWith[HovedstyretIssuesNoCertificates] implies hovedstyretIssuesCertificatesForDependentDepartments
}

assert R_SettlementNeedsTheTeamLeader { policy implies settlementNeedsTheTeamLeader }
assert R_SettlementNeedsTheTeamLeader_mutantMembersSettle {
  policyWith[SettlementReachesMembers] implies settlementNeedsTheTeamLeader
}

assert F4_ExistingAccountClaimBySessionOnly { policy implies existingAccountClaimBySessionOnly }
assert F4_ExistingAccountClaimBySessionOnly_mutantBearer {
  policyWith[ClaimByBearer] implies existingAccountClaimBySessionOnly
}

assert S_IntervalsStayOrdered { policy implies intervalsStayOrdered }

--------------------------------------------------------------------------------------------
-- Scenarios: each shows that the policy has the instances that the assertions quantify over
--------------------------------------------------------------------------------------------

-- a leadership handover can appoint the successor before the predecessor leaves
pred scenarioLeadershipHandover {
  policy
  some disj r1, r2: Effective | r1.type = Leader and r2.type = Leader and r1.scope = r2.scope and r1.holder != r2.holder
}
-- a Hovedstyret seat with capabilities, held by a person with no active administration grant
pred scenarioHovedstyretSeatIsNotAdministrator {
  policy
  some r: Effective | r.scope = Hovedstyret and some caps[r]
    and no g: GlobalAdministration | g.subject = r.holder and grantActive[g]
}
-- a Styret seat administers its own department and not another one
pred scenarioStyretSeatStaysInItsDepartment {
  policy
  some r: Effective, d: Department | r.scope in Styret and ManageAppointments in caps[r]
    and d not in departmentOf[r.scope]
    and rolePermit[r.holder, ManageAppointments, departmentOf[r.scope]]
    and not rolePermit[r.holder, ManageAppointments, d]
}
-- a Hovedstyret seat administers a team in a department
pred scenarioHovedstyretSeatReachesATeam {
  policy
  some r: Effective, t: Team | r.scope = Hovedstyret and r in witnesses[r.holder, ManageAppointments, t]
}
-- a person with seats on two departments' boards leaves one; the other keeps its authority
pred scenarioEndingOneBoardSeatKeepsTheOther {
  policy
  some p: Person, disj d1, d2: Department |
    rolePermit[p, ManageAppointments, d1] and rolePermit[p, ManageAppointments, d2]
    and eventually (not rolePermit[p, ManageAppointments, d1] and rolePermit[p, ManageAppointments, d2])
}
-- a new-account claim succeeds once and is then denied
pred scenarioNewAccountClaimOnce {
  policy
  some c: ClaimCapability, q: Request | q.action = ClaimNewAccount and Resolution.chosen[q] = c
    and eventually (c in UsedNow and after always not permitted[q])
}
-- an existing-account claim succeeds once with a session and a token, and is then denied
pred scenarioExistingAccountClaimOnce {
  policy
  some q: Request | q.action = ClaimExistingAccount and Resolution.chosen[q] in Account and some q.evidence
    and eventually (q.evidence in UsedNow and after always not permitted[q])
}
-- a team leader's derived Styret seat follows the leadership and ends with it
pred scenarioDerivedSeatEndsWithTheLeadership {
  policy
  some x: Effective | some x.gate and eventually (x.gate not in Effective and x not in Effective)
}
-- the assistants of a department in a semester are a derived cohort
pred scenarioDerivedCohort {
  policy
  some d: Department, y: Semester | #assistantCohort[d, y] = 2
}
-- an appointed interviewer schedules their interview
pred scenarioInterviewerSchedulesWhileAppointed {
  policy
  some r: Effective, i: Interview | r.type = Interviewer and r.scope = i
    and r in witnesses[r.holder, ScheduleInterview, i]
}

-- a member of a named team acts in the named department through a delegation, and not in another
pred scenarioDelegatedMemberActsInNamedDepartment {
  policy
  some r: Effective, g: Delegation, d: Department | r.type = Member and r.scope = g.team and delegationActive[g]
    and r in witnesses[r.holder, g.capability, g.area]
    and d != g.area and not rolePermit[r.holder, g.capability, d]
}
-- a delegation ends, and the authority that it conferred ends with it
pred scenarioDelegationEndsWithItsAuthority {
  policy
  some r: Effective, g: Delegation | r.scope = g.team and r in witnesses[r.holder, g.capability, g.area]
    and eventually (not delegationActive[g] and not rolePermit[r.holder, g.capability, g.area])
}
-- a national team with its home in one department acts in another through a national delegation
pred scenarioNationalTeamHostedInADepartment {
  policy
  some r: Effective, g: Delegation, d: Department |
    r.scope = g.team and g.team.teamScope = Organization and d != g.team.within
    and delegationActive[g] and r in witnesses[r.holder, g.capability, d]
}
-- a Styret leader creates a delegation for a team of its department
pred scenarioStyretLeaderDelegatesInItsDepartment {
  policy
  some g: Delegation | eventually (issuance[g] and
    some r: witnesses[issuerPerson[g], ManageDelegations, g.issuer.target] | r.scope in Styret)
}
-- Hovedstyret creates a delegation for a national team
pred scenarioHovedstyretDelegatesToANationalTeam {
  policy
  some g: Delegation | g.team.teamScope = Organization and eventually (issuance[g] and
    some r: witnesses[issuerPerson[g], ManageDelegations, Organization] | r.scope = Hovedstyret)
}
-- one title means different role types in different units, and each holder gets its unit's type
pred scenarioTitlesAreDefinedPerUnit {
  policy
  some disj p1, p2: Position | p1.title = p2.title and p1.roleType != p2.roleType
    and some r1, r2: Role | r1.position = p1 and r2.position = p2
}
-- the leader of a national team sits on Hovedstyret through a derived seat
pred scenarioNationalLeaderSitsOnHovedstyret {
  policy
  some r, x: Effective | r.type = Leader and r.scope.teamScope = Organization and x.gate = r
    and x.scope = Hovedstyret
}
-- Hovedstyret creates a delegation for a team of a department that is not independent
pred scenarioHovedstyretDelegatesInADependentDepartment {
  policy
  some g: Delegation | g.team.teamScope != Organization and g.team.within not in Independent
    and eventually (issuance[g] and
      some r: witnesses[issuerPerson[g], ManageDelegations, g.issuer.target] | r.scope = Hovedstyret)
}
-- a team leader's derived Styret seat issues certificates in the department and not in another
pred scenarioDerivedSeatIssuesCertificates {
  policy
  some x: Effective, d: Department | some x.gate and x.scope in Styret
    and rolePermit[x.holder, IssueCertificates, departmentOf[x.scope]]
    and d not in departmentOf[x.scope] and not rolePermit[x.holder, IssueCertificates, d]
}
-- a bot reads for a person without confirmation, and changes data only with it
pred scenarioBotReadsAndChangesWithConfirmation {
  policy
  some disj q1, q2: Request | some c1: q1.presents & UserBearerCredential, c2: q2.presents & UserBearerCredential |
    c1.client in Bot and c2.client in Bot and permitted[q1] and permitted[q2]
    and q1.action in ReadActions and q1 not in Confirmed and q2.action not in ReadActions and q2 in Confirmed
}

-- a member of the economy team approves a claim but cannot record its settlement
pred scenarioEconomyMemberApprovesButDoesNotSettle {
  policy
  some r: Effective, disj ga, gs: Delegation | r.type = Member and r.scope = ga.team and ga.team = gs.team
    and ga.capability = ApproveReceipt and gs.capability = SettleReceipt
    and delegationActive[ga] and delegationActive[gs]
    and rolePermit[r.holder, ApproveReceipt, ga.area] and not rolePermit[r.holder, SettleReceipt, gs.area]
}
-- a Hovedstyret seat issues certificates for a department that is not independent
pred scenarioHovedstyretIssuesCertificatesForADependentDepartment {
  policy
  some r: Effective, d: Department | r.scope = Hovedstyret and d not in Independent
    and rolePermit[r.holder, IssueCertificates, d]
}

--------------------------------------------------------------------------------------------
-- Commands
--------------------------------------------------------------------------------------------

check A_NoLocalLabelConfersNationalScope for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check A_NoLocalLabelConfersNationalScope_mutantPositionLabel for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check B_ServicePrincipalAcquiresNoHumanRole for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check B_ServicePrincipalAcquiresNoHumanRole_mutantRunAs for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check C_EndingARoleRevokesOnlyItsScope for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check C_EndingARoleRevokesOnlyItsScope_mutantStale for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1
check C_EndingARoleRevokesOnlyItsScope_mutantCascade for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check D_RoleEventTouchesOnlyThatRole for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check D_RoleEventTouchesOnlyThatRole_mutantCascade for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check E_ExactlyOnePrincipalPerRequest for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check E_ExactlyOnePrincipalPerRequest_mutantPreferSession for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
check E_ExactlyOnePrincipalPerRequest_mutantPreferBearer for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
check E_ExactlyOnePrincipalPerRequest_mutantInvitationTokenOnly for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check F1_ClaimCapabilityBindsOneResource for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check F1_ClaimCapabilityBindsOneResource_mutantBindsSome for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check F2_ClaimCapabilityIsSingleUse for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check F2_ClaimCapabilityIsSingleUse_mutantForgetsNewAccount for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1
check F2_ClaimCapabilityIsSingleUse_mutantForgetsExistingAccount for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check F3_ExistingAccountClaimNeedsSessionAndToken for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check F3_ExistingAccountClaimNeedsSessionAndToken_mutantWithoutToken for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check G_EndingAGrantKeepsRoleAuthority for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check G_EndingAGrantKeepsRoleAuthority_mutantVeto for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check H_AdministrationGrantsNoTeamApplicationOrAssessmentAuthority for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check H_AdministrationGrantsNoTeamApplicationOrAssessmentAuthority_mutantEverything for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check I_InterviewerSchedulesOnlyWhileAppointed for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check I_InterviewerSchedulesOnlyWhileAppointed_mutantNoRequirement for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check K1_StyretNeverReachesAnotherDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check K1_StyretNeverReachesAnotherDepartment_mutantBoardsSitNationally for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check K2_HovedstyretReachesEveryDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check K2_HovedstyretReachesEveryDepartment_mutantOwnNode for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check K3_HovedstyretConfersNoPrincipalSideGrant for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check K3_HovedstyretConfersNoPrincipalSideGrant_mutantSeatCarriesAdministration for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
check K3_HovedstyretConfersNoPrincipalSideGrant_mutantDelegationCarriesAdministration for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check L_TeamRolesStayInTheirTeam for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check L_TeamRolesStayInTheirTeam_mutantLeadersReachTheirDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check M1_DelegationServesOnlyItsTeam for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check M1_DelegationServesOnlyItsTeam_mutantDepartmentTeams for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check M2_DelegationReachesOnlyItsArea for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check M2_DelegationReachesOnlyItsArea_mutantEveryDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check M3_DelegationConfersNothingOutsideItsInterval for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check M3_DelegationConfersNothingOutsideItsInterval_mutantOutlivesItsEnd for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check O1_StyretLeaderDelegatesOnlyInItsDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check O1_StyretLeaderDelegatesOnlyInItsDepartment_mutantAreaUnbounded for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check O2_NationalTeamDelegationNeedsNationalAuthority for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check O2_NationalTeamDelegationNeedsNationalAuthority_mutantCheckedAtHome for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check P_AuthorityFollowsThePositionsRoleType for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check P_AuthorityFollowsThePositionsRoleType_mutantLeadershipFlag for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check Q1_DerivedSeatEndsWithTheLeadership for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0
check Q1_DerivedSeatEndsWithTheLeadership_mutantStoredCopy for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1

check Q2_DerivedSeatConfersNoAdministration for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check Q2_DerivedSeatConfersNoAdministration_mutantStyretAdministers for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check T_OnlyNationalTeamsReachBeyondTheirHome for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check T_OnlyNationalTeamsReachBeyondTheirHome_mutantNationalByHome for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check N1_OnBehalfNeverExceedsThePerson for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check N1_OnBehalfNeverExceedsThePerson_mutantClientGrantLeaks for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check N2_OnBehalfStaysInTheTokenScope for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check N2_OnBehalfStaysInTheTokenScope_mutantScopeIgnored for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check N3_BotChangesOnlyWithConfirmation for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check N3_BotChangesOnlyWithConfirmation_mutantNoConfirmation for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check Q3_NationalLeaderSitsOnHovedstyret for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check Q3_NationalLeaderSitsOnHovedstyret_mutantSeatAtHome for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check X1_StyretGovernsOnlyAnIndependentDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check X1_StyretGovernsOnlyAnIndependentDepartment_mutantWithoutIndependence for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check X2_HovedstyretReachesTheTeamsOfDependentDepartments for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check X2_HovedstyretReachesTheTeamsOfDependentDepartments_mutantOnlyNationalTeams for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check W_CertificatesComeFromTheDepartmentBoard for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check W_CertificatesComeFromTheDepartmentBoard_mutantAnyBoard for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check W2_HovedstyretIssuesCertificatesForDependentDepartments for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 0
check W2_HovedstyretIssuesCertificatesForDependentDepartments_mutantStyretOnly for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1

check R_SettlementNeedsTheTeamLeader for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check R_SettlementNeedsTheTeamLeader_mutantMembersSettle for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check F4_ExistingAccountClaimBySessionOnly for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 0
check F4_ExistingAccountClaimBySessionOnly_mutantBearer for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1

check S_IntervalsStayOrdered for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0

run scenarioLeadershipHandover for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretSeatIsNotAdministrator for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioStyretSeatStaysInItsDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretSeatReachesATeam for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioEndingOneBoardSeatKeepsTheOther for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1
run scenarioNewAccountClaimOnce for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioExistingAccountClaimOnce for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioDerivedSeatEndsWithTheLeadership for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioDerivedCohort for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioInterviewerSchedulesWhileAppointed for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioDelegatedMemberActsInNamedDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioDelegationEndsWithItsAuthority for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioNationalTeamHostedInADepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioStyretLeaderDelegatesInItsDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretDelegatesToANationalTeam for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioTitlesAreDefinedPerUnit for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1
run scenarioBotReadsAndChangesWithConfirmation for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioNationalLeaderSitsOnHovedstyret for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1
run scenarioHovedstyretDelegatesInADependentDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioDerivedSeatIssuesCertificates for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1
run scenarioEconomyMemberApprovesButDoesNotSettle for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretIssuesCertificatesForADependentDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 1 steps expect 1
