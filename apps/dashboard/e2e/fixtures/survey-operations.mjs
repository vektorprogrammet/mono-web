export const password = "survey-operations-0113-password-0123456789";

export const ids = {
  department: "department-survey-operations-0113",
  foreignDepartment: "department-survey-operations-foreign-0113",
  semester: "semester-survey-operations-0113",
  period: "admission-period-survey-operations-0113",
  foreignPeriod: "admission-period-survey-operations-foreign-0113",
  team: "team-survey-operations-0113",
  foreignTeam: "team-survey-operations-foreign-0113",
  leaderMembership: "membership-survey-operations-leader-0113",
  foreignLeaderMembership: "membership-survey-operations-foreign-leader-0113",
  ordinaryMembership: "membership-survey-operations-member-0113",
  inactiveMembership: "membership-survey-operations-inactive-0113",
  volunteer: "person-survey-operations-volunteer-0113",
  school: 811301,
  schoolSecond: 811302,
};

export const personas = {
  leader: {
    personId: "person-survey-operations-leader-0113",
    firstName: "Lise",
    lastName: "Leder",
    email: "leader.survey-operations.0113@example.invalid",
    password,
  },
  foreignLeader: {
    personId: "person-survey-operations-foreign-leader-0113",
    firstName: "Finn",
    lastName: "Fremmed",
    email: "foreign.survey-operations.0113@example.invalid",
    password,
  },
  ordinary: {
    personId: "person-survey-operations-member-0113",
    firstName: "Mina",
    lastName: "Medlem",
    email: "member.survey-operations.0113@example.invalid",
    password,
  },
  inactive: {
    personId: "person-survey-operations-inactive-0113",
    firstName: "Ina",
    lastName: "Inaktiv",
    email: "inactive.survey-operations.0113@example.invalid",
    password,
  },
  administrator: {
    personId: "person-survey-operations-administrator-0113",
    firstName: "Ada",
    lastName: "Administrator",
    email: "administrator.survey-operations.0113@example.invalid",
    password,
  },
};

export const identitySeedPersons = Object.values(personas).map(
  ({ personId, firstName, lastName, email, password: personaPassword }) => ({
    personId,
    firstName,
    lastName,
    email,
    password: personaPassword,
  }),
);

export const createSurveyBody = (overrides = {}) => ({
  departmentId: ids.department,
  semesterId: ids.semester,
  title: "Skolenes tilbakemelding 0113",
  completionText: "Takk for at skolen delte erfaringene sine.",
  resultsVisibility: "DepartmentManagers",
  questions: [
    {
      kind: "Text",
      label: "Hva fungerte best?",
      help: "Beskriv en konkret erfaring.",
      required: true,
    },
    {
      kind: "List",
      label: "Vil skolen delta igjen?",
      help: null,
      required: true,
      alternatives: ["Ja", "Nei"],
    },
    {
      kind: "Radio",
      label: "Hvordan opplevdes samarbeidet?",
      help: null,
      required: true,
      alternatives: ["Godt", "Dårlig"],
    },
    {
      kind: "Check",
      label: "Hva ønsker skolen mer av?",
      help: "Velg alle som passer.",
      required: false,
      alternatives: ["Besøk", "Informasjon", "Materiell"],
    },
  ],
  ...overrides,
});

export const seedSql = `
BEGIN;
INSERT INTO public.organization_departments
  (department_id, name, short_name, email, address, city, latitude, longitude, slack_channel, logo_path, active, revision)
VALUES
  ('${ids.department}', 'Undersøkelsesavdelingen', 'UND', 'survey-operations.0113@example.invalid', NULL, 'Oslo', NULL, NULL, NULL, NULL, TRUE, 0),
  ('${ids.foreignDepartment}', 'Fremmed undersøkelsesavdeling', 'FRE', 'foreign-survey-operations.0113@example.invalid', NULL, 'Bergen', NULL, NULL, NULL, NULL, TRUE, 0);
INSERT INTO public.admission_period_departments (department_id, name)
VALUES
  ('${ids.department}', 'Undersøkelsesavdelingen'),
  ('${ids.foreignDepartment}', 'Fremmed undersøkelsesavdeling');
INSERT INTO public.admission_period_semesters (semester_id, start_at, end_at)
VALUES ('${ids.semester}', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
INSERT INTO public.admission_periods
  (admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id)
VALUES
  ('${ids.period}', '${ids.department}', '${ids.semester}', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 0, 'survey-operations-period-command-0113'),
  ('${ids.foreignPeriod}', '${ids.foreignDepartment}', '${ids.semester}', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 0, 'survey-operations-foreign-period-command-0113');
INSERT INTO public.organization_teams (team_id, department_id, name, active, revision)
VALUES
  ('${ids.team}', '${ids.department}', 'Undersøkelsesteamet', TRUE, 0),
  ('${ids.foreignTeam}', '${ids.foreignDepartment}', 'Fremmed team', TRUE, 0);
INSERT INTO public.person_contact_profiles (person_id, email, phone, revision)
VALUES
  ('${personas.leader.personId}', '${personas.leader.email}', '+47 900 11 301', 0),
  ('${personas.foreignLeader.personId}', '${personas.foreignLeader.email}', '+47 900 11 302', 0),
  ('${personas.ordinary.personId}', '${personas.ordinary.email}', '+47 900 11 303', 0),
  ('${personas.inactive.personId}', '${personas.inactive.email}', '+47 900 11 304', 0),
  ('${personas.administrator.personId}', '${personas.administrator.email}', '+47 900 11 305', 0);
INSERT INTO public.organization_memberships
  (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision)
VALUES
  ('${ids.leaderMembership}', '${personas.leader.personId}', '${ids.team}', NULL, '2020-01-01T00:00:00.000Z', NULL, 'teamleader', TRUE, FALSE, 0),
  ('${ids.foreignLeaderMembership}', '${personas.foreignLeader.personId}', '${ids.foreignTeam}', NULL, '2020-01-01T00:00:00.000Z', NULL, 'teamleader', TRUE, FALSE, 0),
  ('${ids.ordinaryMembership}', '${personas.ordinary.personId}', '${ids.team}', NULL, '2020-01-01T00:00:00.000Z', NULL, 'member', FALSE, FALSE, 0),
  ('${ids.inactiveMembership}', '${personas.inactive.personId}', '${ids.team}', NULL, '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', 'teamleader', TRUE, FALSE, 0);
INSERT INTO public.organization_global_administrator_grants
  (grant_id, person_id, start_at, end_at, revision)
VALUES
  ('global-administrator-survey-operations-0113', '${personas.administrator.personId}', '2020-01-01T00:00:00.000Z', NULL, 0);
INSERT INTO public.person_profiles (person_id, first_name, last_name, revision)
VALUES ('${ids.volunteer}', 'Vera', 'Vikar', 0);
INSERT INTO public.organization_volunteer_affiliations (person_id, department_id, status, revision)
VALUES ('${ids.volunteer}', '${ids.department}', 'Active', 1);
INSERT INTO public.schools_directory_schools
  (school_id, name, contact_person, email, phone, language, active, revision)
OVERRIDING SYSTEM VALUE
VALUES
  (${ids.school}, 'Alfa skole', 'Kontakt Alfa', 'alfa-survey-operations.0113@example.invalid', '+47 90011301', 'Norwegian', TRUE, 0),
  (${ids.schoolSecond}, 'Beta skole', 'Kontakt Beta', 'beta-survey-operations.0113@example.invalid', '+47 90011302', 'Norwegian', TRUE, 0);
INSERT INTO public.schools_directory_departments (school_id, department_id, revision)
VALUES
  (${ids.school}, '${ids.department}', 0),
  (${ids.schoolSecond}, '${ids.department}', 0);
INSERT INTO public.assistant_placements
  (placement_id, person_id, department_id, semester_id, school_id, day, workdays, block, active, revision)
VALUES
  ('placement-survey-operations-0113-a', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.school}, 'Monday', 1, '1', TRUE, 0),
  ('placement-survey-operations-0113-b', '${ids.volunteer}', '${ids.department}', '${ids.semester}', ${ids.schoolSecond}, 'Tuesday', 1, '1', TRUE, 0);
COMMIT;
`;
