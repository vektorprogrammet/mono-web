/**
 * Prerequisite fixtures and independent PostgreSQL observations for the golden
 * team-application journey.
 *
 * Fixtures create people, departments, teams, and memberships only. Every
 * application, intake setting, deletion, and delivery outcome is runtime work.
 * Each checkpoint reads one REPEATABLE READ snapshot, derives the expected state
 * from what the browser recorded, and fails on any difference.
 */
import assert from "node:assert/strict";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { Effect, Option, Schema } from "effect";
import type { Pool, PoolClient } from "pg";
import type {
  ApplicantInput,
  FixturePerson,
  FixtureTeam,
  JourneyRecord,
  StaffRole,
  Submission,
  TeamApplicationFixture,
  TeamApplicationStep,
} from "../../apps/dashboard/e2e/golden-team-application-browser";
import { failure, type ProviderAttempt, readOnlySnapshot, selectRows } from "./golden-harness";

export const mailSender = "noreply.syntetisk@example.invalid";

const departmentId = "ta-department";

const personIds: Readonly<Record<StaffRole, string>> = {
  leaderAlfa: "ta-leader-alfa",
  memberAlfa: "ta-member-alfa",
  sessionAlfa: "ta-session-alfa",
  suspendedAlfa: "ta-suspended-alfa",
  formerAlfa: "ta-former-alfa",
  leaderBeta: "ta-leader-beta",
  memberBeta: "ta-member-beta",
};

const person = (role: StaffRole, lastName: string, password: string): FixturePerson => ({
  personId: personIds[role],
  firstName: "Syntetisk",
  lastName,
  email: `${personIds[role]}@example.invalid`,
  password,
  membershipId: `${personIds[role]}-membership`,
});

const firstApplicant: ApplicantInput = {
  name: "Ada Søker",
  email: "ada.soker@example.invalid",
  phone: "90000001",
  yearOfStudy: "3. klasse",
  fieldOfStudy: "Informatikk",
  biography: "Første søknad: jeg liker å forklare matematikk.",
  motivation: "Første søknad: jeg vil bidra i Team Alfa.",
};

export const teamApplicationFixture = (password: string): TeamApplicationFixture => ({
  departmentSlug: "syntetisk",
  departmentEmail: "avdeling.syntetisk@example.invalid",
  alfa: { teamId: "ta-team-alfa", name: "Team Alfa", email: "alfa@example.invalid" },
  beta: { teamId: "ta-team-beta", name: "Team Beta", email: null },
  gamma: { teamId: "ta-team-gamma", name: "Team Gamma", email: "gamma@example.invalid" },
  inactive: { teamId: "ta-team-inactive", name: "Team Inaktiv", email: "inaktiv@example.invalid" },
  unknownTeamId: "ta-team-unknown",
  persons: {
    leaderAlfa: person("leaderAlfa", "Leder Alfa", password),
    memberAlfa: person("memberAlfa", "Medlem Alfa", password),
    sessionAlfa: person("sessionAlfa", "Økt Alfa", password),
    suspendedAlfa: person("suspendedAlfa", "Suspendert Alfa", password),
    formerAlfa: person("formerAlfa", "Tidligere Alfa", password),
    leaderBeta: person("leaderBeta", "Leder Beta", password),
    memberBeta: person("memberBeta", "Medlem Beta", password),
  },
  first: firstApplicant,
  // The same person applies again with distinct free text, so deletion can be traced.
  second: {
    ...firstApplicant,
    biography: "Andre søknad: oppdatert biografi etter høstsemesteret.",
    motivation: "Andre søknad: ny motivasjon for vervet.",
  },
  fallback: {
    name: "Bo Søker",
    email: "bo.soker@example.invalid",
    phone: "90000002",
    yearOfStudy: "1. klasse",
    fieldOfStudy: "Matematikk",
    biography: "Reserveadresse: jeg studerer matematikk.",
    motivation: "Reserveadresse: jeg vil hjelpe Team Beta.",
  },
});

/** Identity seed input: people and credentials only. */
export const identitySeedPersons = (fixture: TeamApplicationFixture) =>
  Object.values(fixture.persons).map(({ personId, firstName, lastName, email, password }) => ({
    personId,
    firstName,
    lastName,
    email,
    password,
  }));

type Membership = {
  readonly role: StaffRole;
  readonly team: FixtureTeam;
  readonly leader: boolean;
  readonly suspended: boolean;
  readonly endAt: string | null;
};

const memberships = (fixture: TeamApplicationFixture): ReadonlyArray<Membership> => [
  { role: "leaderAlfa", team: fixture.alfa, leader: true, suspended: false, endAt: null },
  { role: "memberAlfa", team: fixture.alfa, leader: false, suspended: false, endAt: null },
  { role: "sessionAlfa", team: fixture.alfa, leader: false, suspended: false, endAt: null },
  { role: "suspendedAlfa", team: fixture.alfa, leader: false, suspended: true, endAt: null },
  {
    role: "formerAlfa",
    team: fixture.alfa,
    leader: false,
    suspended: false,
    endAt: "2021-01-01T00:00:00Z",
  },
  { role: "leaderBeta", team: fixture.beta, leader: true, suspended: false, endAt: null },
  { role: "memberBeta", team: fixture.beta, leader: false, suspended: false, endAt: null },
];

/** Prerequisites only: no application, intake setting, deletion, or delivery outcome. */
export const seedTeamApplicationFixture = (pool: Pool, fixture: TeamApplicationFixture) =>
  Effect.forEach(
    [
      {
        text: "INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES($1,'Vektorprogrammet Syntetisk','Syntetisk',$2,'Trondheim',true,0)",
        values: [departmentId, fixture.departmentEmail],
      },
      ...[fixture.alfa, fixture.beta, fixture.gamma, fixture.inactive].map((team) => ({
        text: "INSERT INTO organization_teams(team_id,department_id,name,email,active,revision) VALUES($1,$2,$3,$4,$5,0)",
        values: [team.teamId, departmentId, team.name, team.email, team !== fixture.inactive],
      })),
      ...Object.values(fixture.persons).map((staff) => ({
        text: "INSERT INTO person_contact_profiles(person_id,email,phone,revision) VALUES($1,$2,'90000000',0)",
        values: [staff.personId, staff.email],
      })),
      ...memberships(fixture).map((membership) => ({
        text: "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,end_at,is_team_leader,is_suspended,revision) VALUES($1,$2,$3,'2020-01-01T00:00:00Z',$4,$5,$6,0)",
        values: [
          fixture.persons[membership.role].membershipId,
          fixture.persons[membership.role].personId,
          membership.team.teamId,
          membership.endAt,
          membership.leader,
          membership.suspended,
        ],
      })),
    ],
    ({ text, values }) =>
      Effect.tryPromise({ try: () => pool.query(text, values), catch: failure("fixture") }),
    { discard: true },
  );

const utc = (column: string) =>
  `to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TeamRow = Schema.Struct({
  team_id: Schema.String,
  accept_application: Schema.NullOr(Schema.Boolean),
  deadline: Schema.NullOr(Schema.String),
  revision: Schema.Int,
});

const MembershipRow = Schema.Struct({
  membership_id: Schema.String,
  is_suspended: Schema.Boolean,
  revision: Schema.Int,
});

const LifecycleRow = Schema.Struct({
  actor_person_id: Schema.String,
  subject_id: Schema.String,
  action: Schema.String,
});

const ApplicationRow = Schema.Struct({
  application_id: Schema.String,
  team_id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  year_of_study: Schema.String,
  field_of_study: Schema.String,
  biography: Schema.String,
  motivation: Schema.String,
  submitted_at: Schema.String,
});

const CommandRow = Schema.Struct({
  command_id: Schema.String,
  operation: Schema.String,
  team_id: Schema.NullOr(Schema.String),
  application_id: Schema.NullOr(Schema.String),
  row_json: Schema.String,
});

const AuditRow = Schema.Struct({
  command_id: Schema.String,
  action: Schema.String,
  actor_person_id: Schema.String,
  team_id: Schema.String,
  application_id: Schema.NullOr(Schema.String),
  accept_application_before: Schema.NullOr(Schema.Boolean),
  accept_application_after: Schema.NullOr(Schema.Boolean),
  deadline_before: Schema.NullOr(Schema.String),
  deadline_after: Schema.NullOr(Schema.String),
  team_revision_before: Schema.NullOr(Schema.Int),
  team_revision_after: Schema.NullOr(Schema.Int),
  row_json: Schema.String,
});

const OutboxRow = Schema.Struct({
  effect_id: Schema.String,
  effect_type: Schema.String,
  team_id: Schema.String,
  application_id: Schema.String,
  command_id: Schema.String,
  ordinal: Schema.Int,
  payload: Schema.String,
  status: Schema.String,
  attempts: Schema.Int,
  last_failure_tag: Schema.NullOr(Schema.String),
});

const ReceiptRow = Schema.Struct({
  identity_sha256: Schema.String,
  operation_id: Schema.String,
  state: Schema.String,
  status: Schema.NullOr(Schema.Int),
  body: Schema.NullOr(Schema.String),
});

/** The submit result an HTTP replay receipt stores and every replay returns. */
const ConfirmationJson = Schema.fromJsonString(
  Schema.Struct({
    applicationId: Schema.String,
    teamId: Schema.String,
    submittedAt: Schema.String,
  }),
);

const decodeConfirmation = Schema.decodeSync(ConfirmationJson, { onExcessProperty: "error" });

/** The private mail envelope an undelivered outbox row retains. */
const Envelope = Schema.Struct({
  deliveryId: Schema.String,
  recipient: Schema.String,
  replyTo: Schema.String,
  subject: Schema.String,
  text: Schema.String,
});

type Envelope = typeof Envelope.Type;

/** The provider request body: the envelope plus the configured sender. */
const MailRequest = Schema.Struct({ ...Envelope.fields, sender: Schema.String });

const EnvelopeJson = Schema.fromJsonString(Envelope);

type Facts = {
  readonly teams: ReadonlyArray<typeof TeamRow.Type>;
  readonly memberships: ReadonlyArray<typeof MembershipRow.Type>;
  readonly lifecycle: ReadonlyArray<typeof LifecycleRow.Type>;
  readonly applications: ReadonlyArray<typeof ApplicationRow.Type>;
  readonly commands: ReadonlyArray<typeof CommandRow.Type>;
  readonly audit: ReadonlyArray<typeof AuditRow.Type>;
  readonly outbox: ReadonlyArray<typeof OutboxRow.Type>;
  readonly receipts: ReadonlyArray<typeof ReceiptRow.Type>;
};

const readFacts = (client: PoolClient) =>
  Effect.gen(function* () {
    const read = <Row>(label: string, text: string, row: Schema.Decoder<Row>) =>
      selectRows(client, label, text, [], row);

    return {
      teams: yield* read(
        "teams",
        `SELECT team_id, accept_application, ${utc("deadline")} AS deadline, revision FROM organization_teams WHERE department_id='${departmentId}' ORDER BY team_id`,
        TeamRow,
      ),
      memberships: yield* read(
        "memberships",
        "SELECT membership_id, is_suspended, revision FROM organization_memberships WHERE membership_id LIKE 'ta-%' ORDER BY membership_id",
        MembershipRow,
      ),
      lifecycle: yield* read(
        "lifecycle",
        "SELECT actor_person_id, subject_id, action FROM organization_lifecycle_history ORDER BY occurred_at, command_id",
        LifecycleRow,
      ),
      applications: yield* read(
        "applications",
        `SELECT application_id, team_id, name, email, phone, year_of_study, field_of_study, biography, motivation, ${utc("submitted_at")} AS submitted_at FROM team_applications ORDER BY submitted_at, application_id`,
        ApplicationRow,
      ),
      commands: yield* read(
        "commands",
        "SELECT command_id, operation, team_id, application_id, to_jsonb(c)::text AS row_json FROM team_application_command_receipts c ORDER BY committed_at, command_id",
        CommandRow,
      ),
      audit: yield* read(
        "audit",
        `SELECT command_id, action, actor_person_id, team_id, application_id, accept_application_before, accept_application_after, ${utc("deadline_before")} AS deadline_before, ${utc("deadline_after")} AS deadline_after, team_revision_before, team_revision_after, to_jsonb(a)::text AS row_json FROM team_application_audit a ORDER BY occurred_at, command_id`,
        AuditRow,
      ),
      outbox: yield* read(
        "outbox",
        "SELECT effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json::text AS payload, status, attempts, last_failure_tag FROM team_application_outbox ORDER BY committed_at, command_id, ordinal",
        OutboxRow,
      ),
      receipts: yield* read(
        "receipts",
        "SELECT identity_sha256, operation_id, state, status, convert_from(body_bytes,'UTF8') AS body FROM native_http_idempotency_receipts WHERE operation_id LIKE 'team-applications.%' ORDER BY committed_at, identity_sha256",
        ReceiptRow,
      ),
    } satisfies Facts;
  });

/** Snapshot of the journey's persistent facts in one read-only transaction. */
export const snapshotFacts = (pool: Pool) => readOnlySnapshot(pool, readFacts);

/** Outbox rows of one application, for delivery waits. */
export const notificationStates = (pool: Pool, applicationId: string) =>
  readOnlySnapshot(pool, (client) =>
    selectRows(
      client,
      "notification states",
      "SELECT status, attempts FROM team_application_outbox WHERE application_id=$1 ORDER BY ordinal",
      [applicationId],
      Schema.Struct({ status: Schema.String, attempts: Schema.Int }),
    ),
  );

/** Total delivery attempts of undelivered notifications; a restarted worker must raise it. */
export const retainedAttempts = (pool: Pool) =>
  readOnlySnapshot(pool, (client) =>
    selectRows(
      client,
      "retained attempts",
      "SELECT coalesce(sum(attempts),0)::int AS attempts FROM team_application_outbox WHERE status IN ('Pending','Processing','Failed')",
      [],
      Schema.Struct({ attempts: Schema.Int }),
    ),
  ).pipe(Effect.map((rows) => rows[0]?.attempts ?? 0));

type Intake = readonly [accept: boolean | null, deadline: string | null, revision: number];

type ExpectedAudit = {
  readonly action: "TeamApplicationIntakeRevised" | "TeamApplicationDeleted";
  readonly actor: string;
  readonly team: string;
  readonly application: string | null;
  readonly accept: readonly [boolean | null, boolean | null];
  readonly deadline: readonly [string | null, string | null];
  readonly revision: readonly [number | null, number | null];
};

const stepIndex = (step: TeamApplicationStep, steps: ReadonlyArray<TeamApplicationStep>) =>
  steps.indexOf(step);

/**
 * Asserts one checkpoint against the expected state and returns the digested
 * facts recorded in `evidence.json`.
 */
export const teamApplicationObserver = (input: {
  readonly pool: Pool;
  readonly fixture: TeamApplicationFixture;
  readonly steps: ReadonlyArray<TeamApplicationStep>;
  readonly attempts: Effect.Effect<ReadonlyArray<ProviderAttempt>>;
}) => {
  const { fixture, steps } = input;
  const leaderAlfa = fixture.persons.leaderAlfa.personId;
  const leaderBeta = fixture.persons.leaderBeta.personId;
  let prior: { readonly step: TeamApplicationStep; readonly facts: Facts } | undefined;
  let deliveredAtSubmitted: ReadonlyArray<string> = [];

  const expectations = (step: TeamApplicationStep, record: JourneyRecord) => {
    const at = (name: TeamApplicationStep) => stepIndex(step, steps) >= stepIndex(name, steps);
    const { first: d1, second: d2, expired: d3 } = record.deadlines;

    const alfa: Intake = at("intake-expired")
      ? [true, d3, 7]
      : at("intake-closed")
        ? [false, d2, 5]
        : at("intake-stale")
          ? [true, d2, 4]
          : at("intake-revised")
            ? [true, null, 3]
            : at("intake-opened")
              ? [true, null, 1]
              : [null, null, 0];

    const revised = (
      actor: string,
      team: FixtureTeam,
      accept: readonly [boolean | null, boolean],
      deadline: readonly [string | null, string | null],
      revision: number,
    ): ExpectedAudit => ({
      action: "TeamApplicationIntakeRevised",
      actor,
      team: team.teamId,
      application: null,
      accept,
      deadline,
      revision: [revision - 1, revision],
    });

    const audit: Array<ExpectedAudit> = [];

    if (at("intake-opened"))
      audit.push(
        revised(leaderAlfa, fixture.alfa, [null, true], [null, null], 1),
        revised(leaderBeta, fixture.beta, [null, true], [null, null], 1),
      );

    if (at("intake-revised"))
      audit.push(
        revised(leaderAlfa, fixture.alfa, [true, true], [null, d1], 2),
        revised(leaderAlfa, fixture.alfa, [true, true], [d1, null], 3),
      );

    if (at("intake-stale"))
      audit.push(revised(leaderAlfa, fixture.alfa, [true, true], [null, d2], 4));

    if (at("intake-closed"))
      audit.push(revised(leaderAlfa, fixture.alfa, [true, false], [d2, d2], 5));

    if (at("intake-expired"))
      audit.push(
        revised(leaderAlfa, fixture.alfa, [false, true], [d2, d2], 6),
        revised(leaderAlfa, fixture.alfa, [true, true], [d2, d3], 7),
      );

    for (const deletion of record.deletions)
      audit.push({
        action: "TeamApplicationDeleted",
        actor: leaderAlfa,
        team: fixture.alfa.teamId,
        application: deletion.applicationId,
        accept: [null, null],
        deadline: [null, null],
        revision: [null, null],
      });

    return {
      teams: [
        [fixture.alfa.teamId, alfa],
        [fixture.beta.teamId, at("intake-opened") ? [true, null, 1] : [null, null, 0]],
        [fixture.gamma.teamId, [null, null, 0]],
        [fixture.inactive.teamId, [null, null, 0]],
      ] satisfies ReadonlyArray<readonly [string, Intake]>,
      audit,
      revisions: audit.filter(({ action }) => action === "TeamApplicationIntakeRevised").length,
      suspended: at("session-revocation"),
    };
  };

  const teamOf = (submission: Submission) =>
    [fixture.alfa, fixture.beta].find(({ teamId }) => teamId === submission.teamId) ?? fixture.alfa;

  const identity = (subject: string, operation: string, target: string, key: string) =>
    sha256Hex(canonicalJsonBytes([subject, `team-applications.${operation}`, target, key]));

  const verifyEnvelope = (
    submission: Submission,
    row: typeof OutboxRow.Type,
    envelope: Envelope,
  ) => {
    const team = teamOf(submission);
    const mailbox = team.email ?? fixture.departmentEmail;

    assert.equal(envelope.deliveryId, row.effect_id, "deliveryId is the outbox effect");

    if (row.effect_type === "SendTeamApplicationReceipt") {
      assert.equal(envelope.recipient, submission.input.email, "receipt goes to the applicant");
      assert.equal(envelope.replyTo, mailbox, "receipt replies to the team mailbox");
      assert.equal(envelope.subject, `Søknad til ${team.name} mottatt`);
    } else {
      assert.equal(envelope.recipient, mailbox, "notification goes to the team mailbox");
      assert.equal(
        envelope.replyTo,
        submission.input.email,
        "notification replies to the applicant",
      );
      assert.equal(envelope.subject, `Ny søker til ${team.name}`);

      for (const line of [
        `Navn: ${submission.input.name}`,
        `E-post: ${submission.input.email}`,
        `Telefon: ${submission.input.phone}`,
        `Studieår: ${submission.input.yearOfStudy}`,
        `Linje: ${submission.input.fieldOfStudy}`,
        submission.input.biography,
        submission.input.motivation,
      ])
        assert.ok(envelope.text.includes(line), `team notification contains ${line}`);
    }
  };

  const verify = (
    step: TeamApplicationStep,
    record: JourneyRecord,
    facts: Facts,
    attempts: ReadonlyArray<ProviderAttempt>,
  ) => {
    const expected = expectations(step, record);
    const deleted = new Set(record.deletions.map(({ applicationId }) => applicationId));
    const live = record.submissions.filter(({ applicationId }) => !deleted.has(applicationId));

    // Fixture boundary and intake settings.
    assert.deepEqual(
      Object.fromEntries(
        facts.teams.map(({ team_id, accept_application, deadline, revision }) => [
          team_id,
          [accept_application, deadline, revision],
        ]),
      ),
      Object.fromEntries(expected.teams),
      "team intake settings",
    );
    assert.deepEqual(
      Object.fromEntries(
        facts.memberships.map(({ membership_id, is_suspended, revision }) => [
          membership_id,
          [is_suspended, revision],
        ]),
      ),
      Object.fromEntries(
        memberships(fixture).map((membership) => {
          const revoked = expected.suspended && membership.role === "sessionAlfa";

          return [
            fixture.persons[membership.role].membershipId,
            [membership.suspended || revoked, revoked ? 1 : 0],
          ];
        }),
      ),
      "memberships",
    );
    assert.deepEqual(
      facts.lifecycle,
      expected.suspended
        ? [
            {
              actor_person_id: leaderAlfa,
              subject_id: fixture.persons.sessionAlfa.membershipId,
              action: "SuspendAppointment",
            },
          ]
        : [],
      "attributable suspension history",
    );

    // Stored applications: exactly the live submissions, field for field.
    assert.deepEqual(
      facts.applications.map((row) => ({
        applicationId: row.application_id,
        teamId: row.team_id,
        input: {
          name: row.name,
          email: row.email,
          phone: row.phone,
          yearOfStudy: row.year_of_study,
          fieldOfStudy: row.field_of_study,
          biography: row.biography,
          motivation: row.motivation,
        },
      })),
      live.map(({ applicationId, teamId, input: applicant }) => ({
        applicationId,
        teamId,
        input: applicant,
      })),
      "stored applications",
    );

    // Item 6: each stored instant is exactly the one the visitor's confirmation stated.
    for (const submission of live)
      assert.equal(
        facts.applications.find(({ application_id }) => application_id === submission.applicationId)
          ?.submitted_at,
        submission.submittedAt,
        `${submission.label} stored submission instant`,
      );

    // Command receipts: one per committed command, no rejected command recorded.
    const submits = facts.commands.filter(({ operation }) => operation === "SubmitTeamApplication");

    assert.deepEqual(
      submits.map(({ application_id, team_id }) => [application_id, team_id]),
      record.submissions.map(({ applicationId, teamId }) => [applicationId, teamId]),
      "submit command receipts",
    );
    assert.deepEqual(
      facts.commands
        .filter(({ operation }) => operation === "DeleteTeamApplication")
        .map(({ application_id }) => application_id),
      record.deletions.map(({ applicationId }) => applicationId),
      "delete command receipts",
    );
    assert.equal(
      facts.commands.filter(({ operation }) => operation === "ReviseTeamApplicationIntake").length,
      expected.revisions,
      "intake command receipts",
    );
    assert.equal(
      facts.commands.length,
      record.submissions.length + record.deletions.length + expected.revisions,
      "no other command receipt",
    );

    // HTTP replay receipts bind the browser's idempotency keys.
    const receipts = new Map(facts.receipts.map((row) => [row.identity_sha256, row]));

    for (const submission of record.submissions) {
      const stored = receipts.get(
        identity(
          "Anonymous",
          "submitTeamApplication",
          `/api/teams/${submission.teamId}/applications`,
          submission.key,
        ),
      );

      assert.ok(stored !== undefined, `HTTP receipt for the ${submission.label} form key`);
      assert.equal(stored.status, 201);
      assert.ok(stored.body !== null, `${submission.label} receipt keeps the original result`);
      assert.deepEqual(
        decodeConfirmation(stored.body),
        {
          applicationId: submission.applicationId,
          teamId: submission.teamId,
          submittedAt: submission.submittedAt,
        },
        `${submission.label} receipt replays the original confirmation`,
      );
    }

    for (const deletion of record.deletions)
      assert.ok(
        receipts.has(
          identity(
            `Person:${leaderAlfa}`,
            "deleteTeamApplication",
            `/api/team-applications/${deletion.applicationId}`,
            deletion.key,
          ),
        ),
        "HTTP receipt for the dashboard delete key",
      );
    assert.deepEqual(
      [...new Set(facts.receipts.map(({ operation_id }) => operation_id))]
        .sort()
        .map((operation) => [
          operation,
          facts.receipts.filter((row) => row.operation_id === operation).length,
        ]),
      [
        ["team-applications.deleteTeamApplication", record.deletions.length],
        ["team-applications.reviseTeamApplicationIntake", expected.revisions],
        ["team-applications.submitTeamApplication", record.submissions.length],
      ].filter(([, count]) => count !== 0),
      "HTTP receipts only for committed commands",
    );

    // Audit: attributable, ordered, and free of applicant contact details or text.
    assert.deepEqual(
      facts.audit.map((row) => ({
        action: row.action,
        actor: row.actor_person_id,
        team: row.team_id,
        application: row.application_id,
        accept: [row.accept_application_before, row.accept_application_after],
        deadline: [row.deadline_before, row.deadline_after],
        revision: [row.team_revision_before, row.team_revision_after],
      })),
      expected.audit,
      "audit history",
    );

    const applicantValues = record.submissions.flatMap(({ input: applicant }) => [
      applicant.name,
      applicant.email,
      applicant.phone,
      applicant.biography,
      applicant.motivation,
    ]);

    for (const row of facts.audit)
      for (const value of applicantValues)
        assert.ok(
          !row.row_json.includes(value),
          `audit row ${row.command_id} retains applicant data`,
        );

    // Outbox: two notifications per submission, committed with it, delivered only after commit.
    const effects = new Set(facts.outbox.map(({ effect_id }) => effect_id));

    assert.equal(
      facts.outbox.length,
      record.submissions.length * 2,
      "two notifications per submission",
    );

    for (const submission of record.submissions) {
      const command = submits.find(
        ({ application_id }) => application_id === submission.applicationId,
      );

      const rows = facts.outbox.filter(
        ({ application_id }) => application_id === submission.applicationId,
      );

      assert.deepEqual(
        rows.map(({ ordinal, effect_type, command_id, team_id }) => [
          ordinal,
          effect_type,
          command_id,
          team_id,
        ]),
        [
          [0, "SendTeamApplicationReceipt", command?.command_id, submission.teamId],
          [1, "NotifyTeamOfApplication", command?.command_id, submission.teamId],
        ],
        `${submission.label} notifications share the submit transaction`,
      );

      const settled = deleted.has(submission.applicationId)
        ? "Cancelled"
        : submission.label === "first" ||
            (submission.label === "fallback" && step === "unattended-recovery")
          ? "Delivered"
          : null;

      for (const row of rows) {
        assert.equal(row.effect_id, `${row.command_id}:${row.effect_type}`);

        if (settled === null) {
          assert.ok(
            ["Pending", "Processing", "Failed"].includes(row.status),
            `${row.effect_id} retained`,
          );
          assert.ok(row.attempts > 0, `${row.effect_id} attempted while the provider fails`);
          verifyEnvelope(submission, row, Schema.decodeSync(EnvelopeJson)(row.payload));
        } else {
          assert.equal(row.status, settled, `${row.effect_id} status`);
          assert.equal(row.payload, "{}", `${row.effect_id} private envelope removed`);
        }

        if (settled === "Cancelled") assert.equal(row.last_failure_tag, "TeamApplicationDeleted");
      }
    }

    // Provider: acknowledged bodies are the committed envelopes; retries never change them.
    const byDelivery = new Map<string, Array<ProviderAttempt>>();

    for (const attempt of attempts) {
      assert.equal(attempt.rejection, null, `provider rejected attempt ${attempt.sequence}`);

      const mail = Schema.decodeUnknownSync(MailRequest)(attempt.body);

      assert.equal(attempt.idempotencyKey, mail.deliveryId, "idempotency key is the delivery id");
      assert.equal(mail.sender, mailSender);
      assert.ok(effects.has(mail.deliveryId), `provider saw unknown delivery ${mail.deliveryId}`);
      byDelivery.set(mail.deliveryId, [...(byDelivery.get(mail.deliveryId) ?? []), attempt]);
    }

    for (const [deliveryId, delivered] of byDelivery)
      assert.equal(
        new Set(delivered.map(({ bodySha256 }) => bodySha256)).size,
        1,
        `${deliveryId} envelope changed between attempts`,
      );

    for (const row of facts.outbox) {
      const accepted = (byDelivery.get(row.effect_id) ?? []).filter(({ status }) => status === 204);

      const submission = record.submissions.find(
        ({ applicationId }) => applicationId === row.application_id,
      );

      // Delivery is at least once; a retained or cancelled notification was never acknowledged.
      if (row.status === "Delivered")
        assert.ok(accepted.length > 0, `${row.effect_id} acknowledged`);
      else if (row.status !== "Processing")
        assert.equal(accepted.length, 0, `${row.effect_id} acknowledged without delivery`);

      if (submission !== undefined && accepted[0] !== undefined)
        verifyEnvelope(submission, row, Schema.decodeUnknownSync(MailRequest)(accepted[0].body));
    }

    if (step === "submitted") deliveredAtSubmitted = [...byDelivery.keys()].sort();

    if (step === "submission-replay")
      assert.deepEqual(
        [...byDelivery.keys()].sort(),
        deliveredAtSubmitted,
        "replay queued no notification",
      );

    // Deletion removes private fields everywhere this journey can observe them.
    for (const deletion of record.deletions) {
      const removed = record.submissions.find(
        ({ applicationId }) => applicationId === deletion.applicationId,
      );

      const traces = JSON.stringify(facts);

      for (const value of [removed?.input.biography, removed?.input.motivation])
        assert.ok(value !== undefined && !traces.includes(value), "deleted free text persists");
    }

    // Read-only and rejected steps change nothing but delivery progress.
    if (
      prior !== undefined &&
      [
        "submission-replay",
        "rejected-submissions",
        "staff-reads",
        "staff-denials",
        "session-revocation",
        "delete-denied",
      ].includes(step)
    ) {
      const stable = ({
        memberships: _memberships,
        lifecycle: _lifecycle,
        outbox,
        ...rest
      }: Facts) => ({
        ...rest,
        outbox: outbox.map(
          ({ status: _status, attempts: _attempts, last_failure_tag: _tag, ...row }) => row,
        ),
      });

      assert.deepEqual(stable(facts), stable(prior.facts), `${step} changed committed facts`);
    }
  };

  const digest = (value: string | null) =>
    value === null ? null : sha256Hex(new TextEncoder().encode(value));

  const observe = (step: TeamApplicationStep, record: JourneyRecord) =>
    Effect.gen(function* () {
      const facts = yield* snapshotFacts(input.pool);
      const attempts = yield* input.attempts;

      yield* Effect.try({
        try: () => verify(step, record, facts, attempts),
        catch: failure(`checkpoint ${step}`),
      });
      prior = { step, facts };

      return {
        teams: facts.teams,
        memberships: facts.memberships,
        lifecycle: facts.lifecycle,
        applications: facts.applications.map(
          ({ application_id, team_id, submitted_at, ...fields }) => ({
            application_id,
            team_id,
            submitted_at,
            fieldsSha256: sha256Hex(canonicalJsonBytes(fields)),
          }),
        ),
        commands: facts.commands.map(({ row_json: _row, ...row }) => row),
        audit: facts.audit.map(({ row_json: _row, ...row }) => row),
        outbox: facts.outbox.map(({ payload, ...row }) => ({
          ...row,
          envelope: Option.isSome(Schema.decodeOption(EnvelopeJson)(payload))
            ? "retained"
            : "removed",
          payloadSha256: digest(payload),
        })),
        receipts: facts.receipts.map(({ body, ...row }) => ({ ...row, bodySha256: digest(body) })),
        providerAttempts: attempts.length,
      } satisfies Schema.Json;
    });

  return { observe };
};
