;; ==========================================================================
;; Vektorprogrammet SDK Domain — PDDL 2.1
;;
;; Models the state space and valid transitions for the SDK abstraction
;; over API Platform routes. Purpose: make illegal actions unrepresentable.
;;
;; Each :action maps to an API endpoint. Preconditions define when the
;; SDK should expose the action. Effects define state changes.
;;
;; The SDK translates this into TypeScript discriminated unions where
;; actions are only available on states that satisfy preconditions.
;; ==========================================================================

(define (domain vektorprogrammet)
  (:requirements :typing :negative-preconditions :conditional-effects :equality)

  ;; ========================================================================
  ;; TYPES
  ;; ========================================================================

  (:types
    ;; Entities
    application interview receipt membership user - object
    admission-period department semester school team position - object
    interview-schema interview-score - object

    ;; Enum-like state markers
    app-status scheduling-status completion-status
    receipt-status role-level - object
  )

  ;; ========================================================================
  ;; CONSTANTS (enum values)
  ;; ========================================================================

  (:constants
    ;; Application status (computed, not stored)
    not-received received invited accepted completed assigned cancelled
      - app-status

    ;; Interview scheduling status (stored as int 0-4)
    no-contact pending accepted-interview request-new-time cancelled-interview
      - scheduling-status

    ;; Interview completion (derived from interviewed + score)
    not-conducted draft conducted - completion-status

    ;; Receipt status
    receipt-pending refunded rejected - receipt-status

    ;; Role hierarchy
    role-user role-team-member role-team-leader role-admin - role-level
  )

  ;; ========================================================================
  ;; PREDICATES
  ;; ========================================================================

  (:predicates
    ;; --- Application state (computed) ---
    (app-has-status ?a - application ?s - app-status)
    (app-has-interview ?a - application ?i - interview)
    (app-has-user ?a - application ?u - user)
    (app-in-period ?a - application ?p - admission-period)
    (app-exists-for-user-period ?u - user ?p - admission-period)

    ;; --- Interview state ---
    (interview-scheduling ?i - interview ?s - scheduling-status)
    (interview-completion ?i - interview ?c - completion-status)
    (interview-has-interviewer ?i - interview ?u - user)
    (interview-has-co-interviewer ?i - interview ?u - user)
    (interview-has-schema ?i - interview ?s - interview-schema)
    (interview-has-score ?i - interview ?sc - interview-score)
    (interview-scheduled ?i - interview)           ; datetime set
    (interview-has-response-code ?i - interview)   ; code generated
    (interview-belongs-to ?i - interview ?a - application)

    ;; --- Receipt state ---
    (receipt-has-status ?r - receipt ?s - receipt-status)
    (receipt-belongs-to ?r - receipt ?u - user)

    ;; --- Membership state (3 independent dimensions) ---
    (membership-active ?m - membership)            ; temporal: semester range
    (membership-suspended ?m - membership)         ; toggle
    (membership-is-leader ?m - membership)         ; leadership flag
    (membership-of-user ?m - membership ?u - user)
    (membership-in-team ?m - membership ?t - team)
    (membership-has-position ?m - membership ?p - position)
    (membership-has-end ?m - membership)           ; endSemester != null

    ;; --- User state ---
    (user-active ?u - user)
    (user-is-active-assistant ?u - user)           ; has current AssistantHistory
    (user-has-been-assistant ?u - user)            ; has any AssistantHistory
    (user-has-role ?u - role-level)
    (user-in-department ?u - user ?d - department)

    ;; --- Admission period state ---
    (period-active ?p - admission-period)
    (period-in-department ?p - admission-period ?d - department)
    (period-in-semester ?p - admission-period ?s - semester)

    ;; --- Department scoping (auth) ---
    (actor-in-department ?d - department)           ; logged-in user's department
    (actor-has-role ?r - role-level)
    (actor-is-admin)                               ; shorthand: bypasses dept scope
  )

  ;; ========================================================================
  ;; ACTIONS — Application Domain
  ;; ========================================================================

  ;; POST /api/applications
  (:action create-application
    :parameters (?u - user ?p - admission-period ?d - department)
    :precondition (and
      (period-active ?p)
      (period-in-department ?p ?d)
      (not (app-exists-for-user-period ?u ?p))     ; uniqueness
    )
    :effect (and
      ;; Creates application with status RECEIVED (computed: has period, no interview)
      (app-exists-for-user-period ?u ?p)
    )
  )

  ;; POST /api/applications/existing
  (:action create-application-existing-user
    :parameters (?u - user ?p - admission-period)
    :precondition (and
      (period-active ?p)
      (user-has-been-assistant ?u)                 ; returning assistant
      (not (app-exists-for-user-period ?u ?p))
    )
    :effect (and
      (app-exists-for-user-period ?u ?p)
      ;; NOTE: inherits previous interview — status may be COMPLETED immediately
    )
  )

  ;; DELETE /api/admin/applications/{id}
  (:action delete-application
    :parameters (?a - application ?d - department)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect ()                                     ; removes application
  )

  ;; ========================================================================
  ;; ACTIONS — Interview Domain
  ;; ========================================================================

  ;; POST /api/admin/interviews/assign
  (:action assign-interview
    :parameters (?a - application ?interviewer - user
                 ?schema - interview-schema ?d - department)
    :precondition (and
      (app-has-status ?a received)                 ; only uninterviewed applications
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      ;; Creates interview with scheduling=NO_CONTACT, completion=not-conducted
      ;; Application status remains RECEIVED until confirmation sent
    )
  )

  ;; POST /api/admin/interviews/{id}/schedule
  (:action schedule-interview
    :parameters (?i - interview ?d - department)
    :precondition (and
      (interview-scheduling ?i no-contact)
      (interview-has-interviewer ?i ?u)            ; must have interviewer
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-member) (actor-is-admin))
    )
    :effect (and
      (not (interview-scheduling ?i no-contact))
      (interview-scheduling ?i pending)
      (interview-scheduled ?i)
      (interview-has-response-code ?i)
      ;; Sends confirmation email
      ;; Application status becomes INVITED
    )
  )

  ;; POST /api/interview-responses/{code}/accept
  (:action accept-interview
    :parameters (?i - interview)
    :precondition (and
      (interview-scheduling ?i pending)
      (interview-has-response-code ?i)
      ;; Unauthenticated — uses response code
    )
    :effect (and
      (not (interview-scheduling ?i pending))
      (interview-scheduling ?i accepted-interview)
      ;; Application status becomes ACCEPTED
    )
  )

  ;; POST /api/interview-responses/{code}/request-new-time
  (:action request-new-time
    :parameters (?i - interview)
    :precondition (and
      (interview-scheduling ?i pending)
      (interview-has-response-code ?i)
    )
    :effect (and
      (not (interview-scheduling ?i pending))
      (interview-scheduling ?i request-new-time)
      ;; Application status reverts to RECEIVED
    )
  )

  ;; Reschedule: admin responds to REQUEST_NEW_TIME
  ;; POST /api/admin/interviews/{id}/schedule (same endpoint, different precondition)
  (:action reschedule-interview
    :parameters (?i - interview ?d - department)
    :precondition (and
      (interview-scheduling ?i request-new-time)
      (or (actor-in-department ?d) (actor-is-admin))
    )
    :effect (and
      (not (interview-scheduling ?i request-new-time))
      (interview-scheduling ?i pending)
      ;; Sends new confirmation email
      ;; Reschedule cycle: can repeat PENDING <-> REQUEST_NEW_TIME
    )
  )

  ;; POST /api/interview-responses/{code}/cancel
  (:action cancel-interview-applicant
    :parameters (?i - interview)
    :precondition (and
      (interview-scheduling ?i pending)
      (interview-completion ?i not-conducted)
    )
    :effect (and
      (not (interview-scheduling ?i pending))
      (interview-scheduling ?i cancelled-interview)
      ;; Application status becomes CANCELLED
    )
  )

  ;; DELETE /api/admin/interviews/{id} (admin cancel)
  (:action cancel-interview-admin
    :parameters (?i - interview ?d - department)
    :precondition (and
      (interview-completion ?i not-conducted)      ; can't cancel conducted
      (or (actor-in-department ?d) (actor-is-admin))
    )
    :effect (and
      (interview-scheduling ?i cancelled-interview)
    )
  )

  ;; POST /api/admin/interviews/{id}/conduct
  (:action conduct-interview
    :parameters (?i - interview ?sc - interview-score ?d - department)
    :precondition (and
      (interview-scheduling ?i accepted-interview) ; intended guard (currently unenforced)
      (interview-completion ?i not-conducted)
      (interview-has-schema ?i ?schema)            ; must have schema for answers
      (or (actor-in-department ?d) (actor-is-admin))
      ;; Score completeness: all 4 fields required
      ;; Answer completeness: len(answers) = len(schema.questions)
    )
    :effect (and
      (not (interview-completion ?i not-conducted))
      (interview-completion ?i conducted)
      (interview-has-score ?i ?sc)
      ;; Application status becomes COMPLETED
    )
  )

  ;; POST /api/admin/interviews/{id}/co-interviewer
  (:action assign-co-interviewer
    :parameters (?i - interview ?co - user ?d - department)
    :precondition (and
      (interview-completion ?i not-conducted)
      (or (actor-in-department ?d) (actor-is-admin))
    )
    :effect (and
      (interview-has-co-interviewer ?i ?co)
    )
  )

  ;; POST /api/admin/interviews/{id}/clear-co-interviewer
  (:action clear-co-interviewer
    :parameters (?i - interview ?d - department)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
    )
    :effect (and
      ;; Removes co-interviewer
    )
  )

  ;; POST /api/admin/interviews/{id}/status (arbitrary status set — medium risk)
  (:action set-interview-status
    :parameters (?i - interview ?s - scheduling-status ?d - department)
    :precondition (and
      (interview-completion ?i not-conducted)       ; guard: only non-conducted
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (interview-scheduling ?i ?s)
    )
  )

  ;; ========================================================================
  ;; ACTIONS — School Assignment (bridges Interview → Operations)
  ;; ========================================================================

  ;; Creates AssistantHistory — transitions application to ASSIGNED
  (:action assign-to-school
    :parameters (?u - user ?school - school ?sem - semester ?d - department)
    :precondition (and
      (app-has-status ?a completed)                ; must have completed interview
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (user-is-active-assistant ?u)
      ;; Application status becomes ASSIGNED (computed from isActiveAssistant)
    )
  )

  ;; ========================================================================
  ;; ACTIONS — Receipt Domain
  ;; ========================================================================

  ;; POST /api/receipts
  (:action create-receipt
    :parameters (?u - user)
    :precondition (and
      (user-active ?u)
      ;; sum > 0, receiptDate provided (validated by API)
    )
    :effect (and
      ;; receipt.status = pending, submitDate = now()
    )
  )

  ;; PUT /api/admin/receipts/{id}/status → refunded
  (:action approve-receipt
    :parameters (?r - receipt ?d - department)
    :precondition (and
      (receipt-has-status ?r receipt-pending)       ; only pending → refunded
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (not (receipt-has-status ?r receipt-pending))
      (receipt-has-status ?r refunded)
      ;; refundDate = now(). Terminal state.
    )
  )

  ;; PUT /api/admin/receipts/{id}/status → rejected
  (:action reject-receipt
    :parameters (?r - receipt ?d - department)
    :precondition (and
      (receipt-has-status ?r receipt-pending)       ; only pending → rejected
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (not (receipt-has-status ?r receipt-pending))
      (receipt-has-status ?r rejected)
      ;; Terminal state.
    )
  )

  ;; ========================================================================
  ;; ACTIONS — Team Membership Domain
  ;; ========================================================================

  ;; POST /api/admin/team-memberships
  (:action create-membership
    :parameters (?u - user ?t - team ?p - position ?d - department)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (membership-active ?m)
      (not (membership-suspended ?m))
      (not (membership-is-leader ?m))
      (membership-of-user ?m ?u)
      (membership-in-team ?m ?t)
      (membership-has-position ?m ?p)
      ;; endSemester = null (indefinite)
    )
  )

  ;; PUT /api/admin/team-memberships/{id} — suspend
  (:action suspend-membership
    :parameters (?m - membership ?d - department)
    :precondition (and
      (membership-active ?m)
      (not (membership-suspended ?m))
      (not (membership-is-leader ?m))              ; must demote first
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (membership-suspended ?m)
    )
  )

  ;; PUT /api/admin/team-memberships/{id} — unsuspend
  (:action unsuspend-membership
    :parameters (?m - membership ?d - department)
    :precondition (and
      (membership-suspended ?m)
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (not (membership-suspended ?m))
    )
  )

  ;; PUT /api/admin/team-memberships/{id} — end membership
  (:action end-membership
    :parameters (?m - membership ?end-sem - semester ?d - department)
    :precondition (and
      (membership-active ?m)
      (not (membership-is-leader ?m))              ; must demote first
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect (and
      (membership-has-end ?m)
      ;; membership-active may become false (depends on semester comparison)
    )
  )

  ;; PUT /api/admin/team-memberships/{id} — promote to leader
  (:action promote-to-leader
    :parameters (?m - membership ?d - department)
    :precondition (and
      (membership-active ?m)
      (not (membership-suspended ?m))              ; can't promote suspended
      (not (membership-is-leader ?m))
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-admin) (actor-is-admin))
    )
    :effect (and
      (membership-is-leader ?m)
      ;; Triggers role update: user gets ROLE_TEAM_LEADER
    )
  )

  ;; PUT /api/admin/team-memberships/{id} — demote from leader
  (:action demote-from-leader
    :parameters (?m - membership ?d - department)
    :precondition (and
      (membership-is-leader ?m)
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-admin) (actor-is-admin))
    )
    :effect (and
      (not (membership-is-leader ?m))
      ;; Triggers role update: user may lose ROLE_TEAM_LEADER
    )
  )

  ;; DELETE /api/admin/team-memberships/{id}
  (:action delete-membership
    :parameters (?m - membership ?d - department)
    :precondition (and
      (not (membership-is-leader ?m))              ; must demote first
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
    )
    :effect ()                                     ; removes membership
  )

  ;; ========================================================================
  ;; ACTIONS — Admission Period Management
  ;; ========================================================================

  ;; POST /api/admin/admission-periods
  (:action create-admission-period
    :parameters (?d - department ?s - semester)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
      ;; Uniqueness: one per department per semester (not enforced by DB — should be)
    )
    :effect (and
      ;; Creates admission period. Active if now() within date range.
    )
  )

  ;; PUT /api/admin/admission-periods/{id}
  (:action edit-admission-period
    :parameters (?p - admission-period ?d - department)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-team-leader) (actor-is-admin))
      ;; Constraint: startDate < endDate (currently unenforced — DATA-7)
    )
    :effect ()
  )

  ;; DELETE /api/admin/admission-periods/{id}
  (:action delete-admission-period
    :parameters (?p - admission-period ?d - department)
    :precondition (and
      (or (actor-in-department ?d) (actor-is-admin))
      (or (actor-has-role role-admin) (actor-is-admin))
      ;; NOTE: Currently only requires TEAM_MEMBER (AUTH-5). Should be ADMIN.
    )
    :effect ()
  )

  ;; ========================================================================
  ;; ACTIONS — User Management
  ;; ========================================================================

  ;; PUT /api/admin/users/{id}/activation
  (:action activate-user
    :parameters (?u - user)
    :precondition (and
      (not (user-active ?u))
      (actor-is-admin)
    )
    :effect (and
      (user-active ?u)
    )
  )

  (:action deactivate-user
    :parameters (?u - user)
    :precondition (and
      (user-active ?u)
      (actor-is-admin)
    )
    :effect (and
      (not (user-active ?u))
    )
  )

  ;; ========================================================================
  ;; ACTIONS — Survey Domain (CRUD, no state machine)
  ;; ========================================================================

  ;; Surveys are CRUD with no state transitions — omitted from PDDL.
  ;; The SDK exposes standard CRUD operations gated only by role + department.

  ;; POST /api/surveys/{id}/respond — public/anonymous for school surveys
  (:action respond-to-survey
    :parameters (?survey - object)
    :precondition ()                               ; varies by survey target audience
    :effect ()                                     ; creates SurveyTaken + SurveyAnswers
  )
)
