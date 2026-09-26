-- Reach and delegation (O8-11 to O8-15). Only a board's leader reaches a department, and a team
-- acts beyond itself only through an explicit, named, time-bounded delegation.
-- Which team is a department's board (Styret), which team is national, and which department is
-- independent are explicit reviewed facts. The defaults fail closed: an unclassified team is an
-- ordinary local team, and a department is not independent until it is recognised.

ALTER TABLE public.organization_teams
  ADD COLUMN kind text NOT NULL DEFAULT 'Team',
  ADD COLUMN team_scope text NOT NULL DEFAULT 'HomeDepartment',
  ADD CONSTRAINT organization_teams_kind CHECK (kind IN ('Team', 'DepartmentBoard')),
  ADD CONSTRAINT organization_teams_scope CHECK (team_scope IN ('HomeDepartment', 'National')),
  -- A department's board works for its department only.
  ADD CONSTRAINT organization_teams_board_scope CHECK (kind = 'Team' OR team_scope = 'HomeDepartment');

-- A department has at most one board.
CREATE UNIQUE INDEX organization_teams_one_department_board
  ON public.organization_teams (department_id) WHERE kind = 'DepartmentBoard';

ALTER TABLE public.organization_departments
  ADD COLUMN independent boolean NOT NULL DEFAULT false;

-- The national board has a leader: its leadership reaches every department.
ALTER TABLE public.organization_memberships
  DROP CONSTRAINT organization_memberships_target,
  ADD CONSTRAINT organization_memberships_target CHECK (
    (board_id IS NOT NULL AND team_id IS NULL AND deleted_team_name IS NULL)
    OR (board_id IS NULL AND ((team_id IS NOT NULL AND deleted_team_name IS NULL)
      OR (team_id IS NULL AND deleted_team_name IS NOT NULL AND btrim(deleted_team_name) <> '')))
  );

-- Classifying a team and recognising a department are lifecycle commands with the same history.
ALTER TABLE public.organization_lifecycle_history
  DROP CONSTRAINT organization_lifecycle_history_action_check,
  ADD CONSTRAINT organization_lifecycle_history_action_check CHECK (action IN (
    'Appoint', 'ReviseAppointment', 'EndAppointment', 'SuspendAppointment', 'ReinstateAppointment',
    'CreateNationalBoard', 'ChangeAccountAccess', 'ClassifyTeam', 'RecogniseDepartment')),
  DROP CONSTRAINT organization_lifecycle_history_target_kind_check,
  ADD CONSTRAINT organization_lifecycle_history_target_kind_check
    CHECK (target_kind IN ('Team', 'NationalBoard', 'Department'));

-- Team T holds capability C in area A from start_at until end_at. The capability registry is
-- packages/domain/src/authz/delegation.ts; the checks below repeat its structural rules.
CREATE TABLE public.organization_delegations (
  delegation_id text PRIMARY KEY CHECK (delegation_id ~ '^delegation-[a-f0-9]{64}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 250),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id) ON DELETE RESTRICT,
  capability text NOT NULL CHECK (capability IN (
    'admissions.periods', 'admissions.outcomes', 'recruitment.interviews', 'placements.coordinate',
    'schools.administer', 'appointments.manage', 'people.read', 'team-interest.read',
    'content.publish', 'receipts.approve', 'receipts.settle')),
  area text NOT NULL CHECK (area IN ('Department', 'Organization')),
  area_department_id text REFERENCES public.organization_departments(department_id) ON DELETE RESTRICT,
  holders text NOT NULL CHECK (holders IN ('AllMembers', 'LeadersOnly')),
  start_at timestamptz NOT NULL,
  end_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CONSTRAINT organization_delegations_area_department
    CHECK ((area = 'Department') = (area_department_id IS NOT NULL)),
  CONSTRAINT organization_delegations_interval CHECK (end_at IS NULL OR start_at < end_at),
  -- Settlement reaches the team's leaders only: the finance lead pays out.
  CONSTRAINT organization_delegations_settlement_leaders
    CHECK (capability <> 'receipts.settle' OR holders = 'LeadersOnly'),
  -- Receipt approval and settlement are national delegations.
  CONSTRAINT organization_delegations_receipt_area
    CHECK (capability NOT IN ('receipts.approve', 'receipts.settle') OR area = 'Organization'),
  CONSTRAINT organization_delegations_start_at_ms
    CHECK (start_at = date_trunc('milliseconds', start_at, 'UTC')),
  CONSTRAINT organization_delegations_end_at_ms
    CHECK (end_at = date_trunc('milliseconds', end_at, 'UTC'))
);
CREATE INDEX organization_delegations_team ON public.organization_delegations (team_id, delegation_id);

-- A delegation only ends: its name, team, capability, area, holders and start never change.
CREATE FUNCTION public.guard_organization_delegation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An organization delegation is never deleted';
  END IF;
  IF NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.capability IS DISTINCT FROM OLD.capability
    OR NEW.area IS DISTINCT FROM OLD.area
    OR NEW.area_department_id IS DISTINCT FROM OLD.area_department_id
    OR NEW.holders IS DISTINCT FROM OLD.holders
    OR NEW.start_at IS DISTINCT FROM OLD.start_at
    OR NEW.end_at IS NULL
    OR (OLD.end_at IS NOT NULL AND NEW.end_at > OLD.end_at)
    OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'An organization delegation allows only an earlier end';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_delegation_guard
  BEFORE UPDATE OR DELETE ON public.organization_delegations
  FOR EACH ROW EXECUTE FUNCTION public.guard_organization_delegation();

-- State, revision, command receipt and attributable history commit together.
CREATE TABLE public.organization_delegation_history (
  command_id text PRIMARY KEY CHECK (char_length(btrim(command_id)) BETWEEN 1 AND 250),
  command_digest text NOT NULL CHECK (command_digest ~ '^[a-f0-9]{64}$'),
  actor_person_id text NOT NULL REFERENCES public.person_profiles(person_id),
  delegation_id text NOT NULL REFERENCES public.organization_delegations(delegation_id),
  team_id text NOT NULL REFERENCES public.organization_teams(team_id),
  action text NOT NULL CHECK (action IN ('IssueDelegation', 'EndDelegation')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 250),
  occurred_at timestamptz NOT NULL,
  before_json jsonb,
  after_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  CONSTRAINT organization_delegation_history_occurred_at_ms
    CHECK (occurred_at = date_trunc('milliseconds', occurred_at, 'UTC'))
);
CREATE INDEX organization_delegation_history_order
  ON public.organization_delegation_history (occurred_at, command_id);
CREATE FUNCTION public.organization_delegation_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'organization delegation history is append-only'; END $$;
CREATE TRIGGER organization_delegation_history_immutable
  BEFORE UPDATE OR DELETE ON public.organization_delegation_history
  FOR EACH ROW EXECUTE FUNCTION public.organization_delegation_history_immutable();
CREATE TRIGGER organization_delegation_history_truncate_immutable
  BEFORE TRUNCATE ON public.organization_delegation_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.organization_delegation_history_immutable();
