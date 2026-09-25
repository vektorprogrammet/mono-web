module authority

/*
 * Vektorprogrammet authority as two algebras: roles and principals.
 *
 * This model states intended behaviour. docs/system.md is the product authority, in its sections
 * "Authority model", "Organization administration", "Recruitment and affiliation", "Substitute
 * coverage", "Team applications" and "Expense reimbursement". docs/model/contexts.cml places the
 * same concepts in their bounded contexts.
 *
 * ROLE ALGEBRA. A role instance is (holder, role type, scope, interval, status). The holder is a
 * Person. Teams, boards, departments and single resources are scopes, never holders. Each unit
 * sits at one scope: a team at itself, a department's board (Styret) at its department, and the
 * national board (Hovedstyret) at national scope, which covers every department. A team role
 * gets its capabilities from its role type. A board seat gets them from its position, which is
 * managed reference data. Every capability reaches the scope where the role's unit sits.
 *
 * PRINCIPAL ALGEBRA. A request presents credentials. Exactly one usable principal binds one
 * subject: an account (session cookie or account bearer), or a service principal, or a bearer
 * capability. The existing-account claim uses the session as its principal. Its token is a
 * named requirement: single-use and bound to one claim target. Global administration, payment
 * authority, receipt approval, settlement and machine grants are principal-side grants. A role
 * never implies one.
 *
 *   permit(q) = the one principal p of q is usable, and
 *     ( some role of p's Person, effective now, whose reach for the action covers the target,
 *       with the named requirements of that role and action met
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
sig Department, Team extends Scope {}
sig Styret extends Scope {}            -- the board of one department
one sig Hovedstyret extends Scope {}   -- the national board
sig Semester {}
sig SchoolSemester extends Scope { semester: one Semester }   -- one school in one semester, in one department
abstract sig Resource extends Scope {}
sig Interview, Receipt, Application, TeamApplication, ServiceCommitment, SubstituteOffer,
    ClaimTarget, InvitationTarget extends Resource {}

fact containment {
  no Organization.within
  all s: Department + Hovedstyret | s.within = Organization
  all s: Team + Styret + SchoolSemester + Interview + Receipt + Application + ClaimTarget |
    one s.within and s.within in Department
  all s: TeamApplication | one s.within and s.within in Team
  all s: ServiceCommitment | one s.within and s.within in SchoolSemester
  all s: SubstituteOffer | one s.within and s.within in ServiceCommitment
  all s: InvitationTarget | one s.within and s.within in Interview
  all d: Department | lone (Styret & within.d)
}

-- a department and everything inside it
fun Local: set Scope { Department.*~within }
fun departmentOf[s: Scope]: set Scope { s.*within & Department }
-- t covers s when some scope in t is s or contains s
pred covers[t: set Scope, s: Scope] { some (s.*within & t) }

-- the scope at which each unit sits (constrained by the policy)
one sig Seat { at: Scope -> one Scope }

pred boardsSitWhereTheyServe {
  all s: Scope | Seat.at[s] = ((s in Styret) => s.within else ((s in Hovedstyret) => Organization else s))
}
-- MUTANT (K1): every board sits at national scope, as if a board were national wherever it serves
pred everyBoardSitsNationally {
  all s: Scope | Seat.at[s] = ((s in Styret + Hovedstyret) => Organization else s)
}
-- MUTANT (K2): the national board sits at its own node, like any other unit
pred hovedstyretSitsAtItsOwnNode {
  all s: Scope | Seat.at[s] = ((s in Styret) => s.within else s)
}

--------------------------------------------------------------------------------------------
-- Role algebra
--------------------------------------------------------------------------------------------

sig Person {}

abstract sig RoleType {}
one sig Member, Leader, BoardSeat, Assistant, PlacedAssistant, SubstitutePool, RosterMember,
        OfferCandidate, Interviewer, CoInterviewer, ReceiptOwner, Applicant extends RoleType {}

-- appointments are the role types that Organization owns
fun Appointments: set RoleType { Member + Leader + BoardSeat }

-- a board position is managed reference data; it carries the capabilities of its seat
sig Position { carries: set Action }

sig Role {
  holder: one Person,
  type: one RoleType,
  scope: one Scope,
  position: lone Position,
  start: one Instant,
  var finish: lone Instant,
  gate: lone Role            -- a declared refinement whose parent must be effective (pool -> affiliation)
}
var sig Suspended in Role {}

fact roleShapes {
  all r: Role {
    r.type in Member + Leader implies r.scope in Team
    r.type = BoardSeat        implies r.scope in Styret + Hovedstyret
    r.type = Assistant        implies r.scope in Department
    r.type = PlacedAssistant  implies r.scope in SchoolSemester
    r.type = SubstitutePool   implies r.scope in Department
    r.type = RosterMember     implies r.scope in ServiceCommitment
    r.type = OfferCandidate   implies r.scope in SubstituteOffer
    r.type in Interviewer + CoInterviewer implies r.scope in Interview
    r.type = ReceiptOwner     implies r.scope in Receipt
    r.type = Applicant        implies r.scope in Application
  }
  -- only board seats hold a position that carries capabilities
  all r: Role | some r.position iff r.type = BoardSeat
  -- the pool is gated by the affiliation in the same department
  all r: Role | some r.gate iff r.type = SubstitutePool
  all r: Role | some r.gate implies
    (r.gate.type = Assistant and r.gate.holder = r.holder and r.gate.scope = r.scope)
  -- creation preconditions: checked when the fact is created, not afterwards
  all r: Role | r.type = PlacedAssistant implies
    some a: Role | a.type = Assistant and a.holder = r.holder and a.scope = departmentOf[r.scope]
  all r: Role | r.type = OfferCandidate implies
    some x: Role | x.type = SubstitutePool and x.holder = r.holder and x.scope = departmentOf[r.scope]
  -- one interviewer and one distinct co-interviewer per interview
  all i: Interview | lone (type.Interviewer & scope.i) and lone (type.CoInterviewer & scope.i)
  all a, b: Role | (a.type = Interviewer and b.type = CoInterviewer and a.scope = b.scope)
    implies a.holder != b.holder
  -- one owner per receipt, one addressed substitute per offer
  all x: Receipt | lone (type.ReceiptOwner & scope.x)
  all x: SubstituteOffer | lone (type.OfferCandidate & scope.x)
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

--------------------------------------------------------------------------------------------
-- Actions and capabilities
--------------------------------------------------------------------------------------------

abstract sig Kind {}
one sig CookieKind, UserBearerKind, MachineKind, CapabilityKind extends Kind {}

abstract sig Action { accepts: set Kind }
one sig ReadTeamApplications, ManageTeamApplications,
        ManageAppointments, MaintainInterviewStaffing, ScheduleInterview, CoordinatePlacements,
        ReportAbsence, ChangeAccountAccess, AdministerGrants, MaintainQuestionnaires,
        AssessInterview, CorrectAssessment, JoinPool, RespondToOffer, ReadOwnReceipt,
        ReadOwnProgress, SubmitReceipt, ApproveReceipt, SettleReceipt,
        ClaimNewAccount, ClaimExistingAccount, RespondToInvitation extends Action {}

-- organisational administration that a board position may carry
fun DepartmentAdministration: set Action {
  ManageAppointments + MaintainInterviewStaffing + ScheduleInterview + CoordinatePlacements + ReportAbsence
}
-- system administration: only the principal-side global-administrator grant confers it
fun SystemAdministration: set Action { ChangeAccountAccess + AdministerGrants + MaintainQuestionnaires }

-- the credential kinds that each endpoint accepts
fact endpointMechanisms {
  ClaimNewAccount.accepts = CapabilityKind
  RespondToInvitation.accepts = CapabilityKind
  ApproveReceipt.accepts = CookieKind + UserBearerKind + MachineKind
  all a: Action - (ClaimNewAccount + RespondToInvitation + ApproveReceipt) |
    a.accepts = CookieKind + UserBearerKind
}

one sig Capabilities { table: RoleType -> Action }

-- representative capabilities of role types (docs/system.md, "Authority model" and the workflows)
pred capabilityTable { Capabilities.table = intendedCapabilities }

fun intendedCapabilities: RoleType -> Action {
      Member -> ReadTeamApplications        -- a current member of the team reads its applications
    + Leader -> ReadTeamApplications
    + Leader -> ManageTeamApplications      -- the current leader changes intake and deletes applications
    + Assistant -> JoinPool                 -- an affiliated volunteer can opt into the substitute pool
    + RosterMember -> ReportAbsence         -- a scheduled volunteer reports their own absence
    + OfferCandidate -> RespondToOffer      -- only the addressed substitute accepts or declines
    + Interviewer -> ScheduleInterview      -- with the named requirement InterviewerAppointment
    + Interviewer -> AssessInterview        -- an interviewer assesses only an assigned interview
    + CoInterviewer -> CorrectAssessment    -- while the scoped correction capability is active
    + ReceiptOwner -> ReadOwnReceipt        -- a receipt owner reads their own file
    + Applicant -> ReadOwnProgress          -- an applicant reads their own application progress
}

pred positionsCarryDepartmentAdministration { all p: Position | p.carries in DepartmentAdministration }
-- MUTANT (K3): a position held on the national board may carry system administration, as if a
-- Hovedstyret seat implied the global-administrator grant
pred hovedstyretPositionsMayCarrySystemAdministration {
  all p: Position | p.carries in DepartmentAdministration + SystemAdministration
  all r: Role | some r.position implies
    r.position.carries in DepartmentAdministration + ((r.scope = Hovedstyret) => SystemAdministration else none)
}

fun caps[r: Role]: set Action { r.type.(Capabilities.table) + r.position.carries }

-- the units whose seats decide the reach of each role (constrained by the policy)
one sig ReachBasis { via: Role -> Scope }

pred reachFollowsTheUnit { ReachBasis.via = Role <: scope }
-- MUTANT (A): a board seat also reaches wherever a seat with the same position title sits
pred reachFollowsThePositionLabel {
  ReachBasis.via = (Role <: scope) + { r: Role, u: Scope |
    some r.position and some x: Role | x.position = r.position and u = x.scope }
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
sig CookieCredential, UserBearerCredential, MachineCredential, CapabilityCredential extends Credential {}

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

one sig Binding { boundPerson: Principal -> lone Person }

pred accountsBindPersons { Binding.boundPerson = Account <: person }
-- MUTANT (B): a machine runs as the person who operates it
pred machinesRunAsOperator { Binding.boundPerson = (Account <: person) + (ServicePrincipal <: operator) }

pred usable[p: Principal] { p not in Disabled + Revoked + Consumed }

--------------------------------------------------------------------------------------------
-- Named requirements
--------------------------------------------------------------------------------------------

abstract sig Requirement {}
one sig ClaimToken, InterviewerAppointment extends Requirement {}

-- the named requirements in force (constrained by the policy)
one sig InForce { rules: set Requirement }

pred everyRequirementInForce { InForce.rules = Requirement }
-- MUTANT (F3): the existing-account claim does not require its token
pred claimTokenNotRequired { InForce.rules = Requirement - ClaimToken }
-- MUTANT (I): an interviewer schedules without an appointment in the interview's department
pred interviewerAppointmentNotRequired { InForce.rules = Requirement - InterviewerAppointment }

-- the departments in which an appointment's unit serves
fun unitDepartments[r: Role]: set Scope { (r.scope.*within + Seat.at[r.scope].*~within) & Department }

pred appointedIn[p: set Person, d: set Scope, roles: set Role] {
  some r: roles | r.holder in p and r.type in Appointments and d in unitDepartments[r]
}

-- InterviewerAppointment: an interviewer schedules only while holding an appointment in the
-- interview's department
pred requirementsHoldAmong[r: Role, a: Action, s: Scope, roles: set Role] {
  (InterviewerAppointment in InForce.rules and r.type = Interviewer and a = ScheduleInterview)
    implies appointedIn[r.holder, departmentOf[s], roles]
}

-- ClaimToken: a usable claim capability, presented as evidence, binds the claim target
pred tokenValid[q: Request] { some c: q.evidence & ClaimCapability | usable[c] and q.target in c.binds }

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
sig GlobalAdministration, PaymentAuthority, ApprovalGrant, SettlementGrant, MachineGrant extends Grant {}

pred grantCapabilitiesExplicit {
  all g: GlobalAdministration | g.subject in Person and g.area = Organization
    and g.actions in SystemAdministration + ManageAppointments + MaintainInterviewStaffing + CoordinatePlacements
  all g: PaymentAuthority | g.subject in Person and g.actions = SubmitReceipt and g.area in Department
  all g: ApprovalGrant | g.subject in Person and g.actions = ApproveReceipt and g.area in Organization + Department
  all g: SettlementGrant | g.subject in Person and g.actions = SettleReceipt and g.area in Organization + Department
  all g: MachineGrant | g.subject in ServicePrincipal and g.actions = ApproveReceipt and g.area in Receipt
}
-- MUTANT (H): global administration as an implicit superuser
pred administrationGrantsEverything {
  all g: GlobalAdministration | g.subject in Person and g.area = Organization and g.actions = Action
  all g: PaymentAuthority | g.subject in Person and g.actions = SubmitReceipt and g.area in Department
  all g: ApprovalGrant | g.subject in Person and g.actions = ApproveReceipt and g.area in Organization + Department
  all g: SettlementGrant | g.subject in Person and g.actions = SettleReceipt and g.area in Organization + Department
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
-- permit
--------------------------------------------------------------------------------------------

fun witnessesAmong[p: Person, a: Action, s: Scope, roles: set Role]: set Role {
  { r: roles | r.holder = p and covers[reach[r, a], s] and requirementsHoldAmong[r, a, s, roles] }
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
  some p: Resolution.chosen[q] | usable[p] and (
       (some Binding.boundPerson[p] and
          (rolePermit[Binding.boundPerson[p], q.action, q.target]
           or grantCovers[Binding.boundPerson[p], q.action, q.target]))
    or (p in ServicePrincipal and grantCovers[p, q.action, q.target])
    or (p in BearerCapability and capabilityCovers[p, q.action, q.target])
    or existingAccountClaim[p, q])
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
}

pred unchangedExcept[roles: set Role, grants: set Grant] {
  all x: Role - roles | x.finish' = x.finish and (x in Suspended' iff x in Suspended)
  all g: Grant - grants | g.gfinish' = g.gfinish
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
  lt[r.start, Clock.now] and unfinished[r]
  r.finish' = Clock.now and (r in Suspended' iff r in Suspended)
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred suspendRole[r: Role] {
  r not in Suspended and Suspended' = Suspended + r and r.finish' = r.finish
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred reinstateRole[r: Role] {
  r in Suspended and Suspended' = Suspended - r and r.finish' = r.finish
  Clock.now' = Clock.now and unchangedExcept[r, none] and Consumed' = Consumed and no UsedNow
}

pred endGrant[g: Grant] {
  lt[g.gstart, Clock.now] and (no g.gfinish or lt[Clock.now, g.gfinish]) and g.gfinish' = Clock.now
  Clock.now' = Clock.now and unchangedExcept[none, g] and Consumed' = Consumed and no UsedNow
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
  lt[r.start, Clock.now] and unfinished[r]
  let doomed = r + { x: Role - r | r.type = Leader and x.holder = r.holder
                       and some (departmentOf[x.scope] & departmentOf[r.scope])
                       and lt[x.start, Clock.now] and unfinished[x] } | {
    all x: doomed | x.finish' = Clock.now and (x in Suspended' iff x in Suspended)
    unchangedExcept[doomed, none]
  }
  Clock.now' = Clock.now and Consumed' = Consumed and no UsedNow
}

-- MUTANT (D): suspending an affiliation also suspends the holder's placements in that department
pred suspendRoleCascading[r: Role] {
  r not in Suspended
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
        HovedstyretSitsAtItsOwnNode, HovedstyretSeatCarriesSystemAdministration extends Mutant {}

pred anyEventWith[m: lone Mutant] {
  tick or skip or (some g: Grant | endGrant[g])
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
  capabilityTable
  (m = HovedstyretSeatCarriesSystemAdministration) => hovedstyretPositionsMayCarrySystemAdministration
    else positionsCarryDepartmentAdministration
  (m = AdministrationGrantsEverything) => administrationGrantsEverything else grantCapabilitiesExplicit
  (m = EveryBoardSitsNationally) => everyBoardSitsNationally
    else ((m = HovedstyretSitsAtItsOwnNode) => hovedstyretSitsAtItsOwnNode else boardsSitWhereTheyServe)
  (m = ReachByPositionLabel) => reachFollowsThePositionLabel else reachFollowsTheUnit
  (m = ClaimWithoutToken) => claimTokenNotRequired
    else ((m = InterviewerWithoutAppointment) => interviewerAppointmentNotRequired else everyRequirementInForce)
  (m = StaleLeadership) => effectiveStaleLeadership else effectiveByOwnState
  (m = PreferSession) => resolvePreferSession
    else ((m = PreferBearer) => resolvePreferBearer else resolveExactlyOne)
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
--     refinements (the pool under its affiliation) may lose effect
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

-- (I) scheduling an interview needs an appointment in the interview's department
pred interviewerSchedulesOnlyWhileAppointed {
  always all q: Request | (permitted[q] and q.action = ScheduleInterview)
    implies appointedIn[Binding.boundPerson[Resolution.chosen[q]], departmentOf[q.target], Effective]
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
-- a pool entry loses effect with its affiliation while the placement stays
pred scenarioPoolGatedPlacementIndependent {
  policy
  some a, x, pl: Role | a.type = Assistant and x.gate = a and pl.type = PlacedAssistant and pl.holder = a.holder
    and a not in Effective and ownActive[x] and x not in Effective and pl in Effective
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

check S_IntervalsStayOrdered for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 0

run scenarioLeadershipHandover for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretSeatIsNotAdministrator for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioStyretSeatStaysInItsDepartment for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioHovedstyretSeatReachesATeam for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioEndingOneBoardSeatKeepsTheOther for 3 but 8 Scope, 6 Role, 3 Instant, 5 steps expect 1
run scenarioNewAccountClaimOnce for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioExistingAccountClaimOnce for 3 but 8 Scope, 6 Role, 3 Instant, 4 steps expect 1
run scenarioPoolGatedPlacementIndependent for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioDerivedCohort for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
run scenarioInterviewerSchedulesWhileAppointed for 3 but 8 Scope, 6 Role, 3 Instant, 3 steps expect 1
