-- Seed SQL for specs 0059/0060 native journeys.
-- Two departments, teams, active memberships (leader in dept A only),
-- person contacts for mailing-list content, and team-interest registrations.

BEGIN;

-- Departments
INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision)
VALUES
  ('department-0059-trondheim', 'Vektorprogrammet Trondheim', 'Trondheim', 'trondheim.0059@example.invalid', 'Trondheim', TRUE, 0),
  ('department-0059-bergen', 'Vektorprogrammet Bergen', 'Bergen', 'bergen.0059@example.invalid', 'Bergen', TRUE, 0)
ON CONFLICT (department_id) DO NOTHING;

-- Teams: two in Trondheim, one in Bergen
INSERT INTO organization_teams (team_id, department_id, name, active, revision)
VALUES
  ('team-0059-it', 'department-0059-trondheim', 'IT-Team 0059', TRUE, 0),
  ('team-0059-pr', 'department-0059-trondheim', 'PR-Team 0059', TRUE, 0),
  ('team-0059-skole', 'department-0059-bergen', 'SkoleTeam 0059', TRUE, 0)
ON CONFLICT (team_id) DO NOTHING;

-- Person profiles and contacts (mailing-list emails come from contacts only).
INSERT INTO person_profiles (person_id, first_name, last_name, revision)
VALUES
  ('person-0059-admin', 'Astrid', 'Adminsen', 0),
  ('person-0059-leader', 'Lars', 'Ledersen', 0),
  ('person-0059-member', 'Mona', 'Medlem', 0),
  ('person-0059-team1a', 'Tiril', 'Teamsen', 0),
  ('person-0059-team1b', 'Torunn', 'Teamto', 0),
  ('person-0059-team2a', 'Thea', 'Trondheim', 0),
  ('person-0059-assistant', 'Are', 'Assistent', 0)
ON CONFLICT (person_id) DO NOTHING;

INSERT INTO person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('person-0059-admin', 'astrid.admin@example.invalid', '+47 900 59 001', 0),
  ('person-0059-leader', 'lars.leader@example.invalid', '+47 900 59 002', 0),
  ('person-0059-member', 'mona.member@example.invalid', '+47 900 59 003', 0),
  ('person-0059-team1a', 'tiril.team@example.invalid', '+47 900 59 004', 0),
  ('person-0059-team1b', 'torunn.team@example.invalid', '+47 900 59 005', 0),
  ('person-0059-team2a', 'thea.crew@example.invalid', '+47 900 59 006', 0)
  -- person-0059-assistant deliberately has NO contact profile:
  -- spec 0060 law 4 says missing contacts shrink the list silently.
ON CONFLICT (person_id) DO NOTHING;

-- Memberships: all start 2026-01-01, open-ended (cover the real clock).
-- Leader: team-leader in IT-Team (Trondheim) only -> scope = Trondheim.
-- Member: plain member in PR-Team (Trondheim).
-- Bergen has its own leader + member so the admin/leader scoping is observable,
-- but no login persona is attached to Bergen's leader (read-only facts).
INSERT INTO organization_memberships (
  membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
  position_id, is_team_leader, is_suspended, revision
)
VALUES
  ('membership-0059-admin-it', 'person-0059-admin', 'team-0059-it', NULL, '2026-01-01T00:00:00Z', NULL, 'medlem', FALSE, FALSE, 0),
  ('membership-0059-leader-it', 'person-0059-leader', 'team-0059-it', NULL, '2026-01-01T00:00:00Z', NULL, 'teamleader', TRUE, FALSE, 0),
  ('membership-0059-member-pr', 'person-0059-member', 'team-0059-pr', NULL, '2026-01-01T00:00:00Z', NULL, 'medlem', FALSE, FALSE, 0),
  ('membership-0059-team1a-it', 'person-0059-team1a', 'team-0059-it', NULL, '2026-01-01T00:00:00Z', NULL, 'medlem', FALSE, FALSE, 0),
  ('membership-0059-team1b-pr', 'person-0059-team1b', 'team-0059-pr', NULL, '2026-01-01T00:00:00Z', NULL, 'medlem', FALSE, FALSE, 0),
  ('membership-0059-team2a-skole', 'person-0059-team2a', 'team-0059-skole', NULL, '2026-01-01T00:00:00Z', NULL, 'medlem', FALSE, FALSE, 0),
  ('membership-0059-bergen-leader', 'person-0059-assistant', 'team-0059-skole', NULL, '2026-01-01T00:00:00Z', NULL, 'teamleader', TRUE, FALSE, 0)
ON CONFLICT (membership_id) DO NOTHING;

-- Global administrator grant for the admin persona (active now).
INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at, revision)
VALUES ('grant-0059-admin', 'person-0059-admin', '2026-01-01T00:00:00Z', NULL, 0)
ON CONFLICT (grant_id) DO NOTHING;

-- Team-interest registrations (stand submissions; submitter has no person row).
-- Trondheim scope rows (leader + admin see these), Bergen row only for admin.
INSERT INTO organization_team_interest_registrations (
  submitter_name, submitter_email, team_id, department_id, semester_id, submitted_at, revision
) VALUES
  ('Sondre Soker', 'sondre.soker@example.invalid', 'team-0059-it', 'department-0059-trondheim', NULL, '2026-08-10T10:00:00Z', 0),
  ('Sigrid Storm', 'sigrid.storm@example.invalid', 'team-0059-it', 'department-0059-trondheim', NULL, '2026-08-11T11:30:00Z', 0),
  ('Sverre Strand', 'sverre.strand@example.invalid', 'team-0059-pr', 'department-0059-trondheim', NULL, '2026-08-12T09:15:00Z', 0),
  ('Bjornar Bergen', 'bjornar.bergen@example.invalid', 'team-0059-skole', 'department-0059-bergen', NULL, '2026-08-13T14:45:00Z', 0);

COMMIT;
