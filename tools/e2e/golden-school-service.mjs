import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const goldenSteps = [
  "initial",
  "affiliation",
  "approval",
  "forbidden",
  "placement",
  "demand",
  "proposal",
  "confirmation",
  "commitment",
  "insufficient",
  "completed",
  "stale",
  "independent-read",
  "substitute-commitment",
  "substitute-absence",
  "coverer-ineligible",
  "outcome-recorded",
  "outcome-stale",
  "on-call-read",
  "wrong-owner",
  "coverage-recorded",
  "coverage-replaced",
  "coverage-withdrawn",
  "coverage-rerecorded",
  "substitute-completed",
  "substitute-independent-read",
];

/** Test-driver faults. Each must make the journey fail; none changes product behavior. */
export const goldenFaults = ["omit-coverage", "absent-browser-evidence"];

const bySource = (left, right) =>
  left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0;

/** A rostered person holds a Scheduled reservation; a current coverage record holds a Coverage one. */
const reservation = (commitmentId, personId, coverageId = null) => ({
  source_id: coverageId ?? commitmentId + ":" + personId,
  source_kind: coverageId === null ? "Scheduled" : "Coverage",
  commitment_id: commitmentId,
  coverage_id: coverageId,
  person_id: personId,
});

const assertReservations = (step, facts, expected) =>
  assert.deepEqual(
    [...facts.reservations].sort(bySource),
    [...expected].sort(bySource),
    step + " must reserve exactly the scheduled and covering people",
  );

// Receipts that the executed writes of each checkpoint commit. Rejections and reads commit none.
const substituteWrites = {
  "substitute-commitment": ["placements.commandBoard"],
  "substitute-absence": ["placements.commandOwnCoverage"],
  "outcome-recorded": ["admissionOutcomes.recordOutcome", "admissionOutcomes.recordOutcome"],
  "coverage-recorded": ["placements.commandOwnCoverage"],
  "coverage-replaced": ["placements.commandCoverageBoard"],
  "coverage-withdrawn": ["placements.commandCoverageBoard"],
  "coverage-rerecorded": ["placements.commandOwnCoverage"],
  "substitute-completed": ["placements.commandCoverageBoard"],
};

// A substitute is an admission outcome. The system records the absence and who covered it;
// the people involved agree on cover outside the system.
const assertSubstituteFacts = (step, facts, previous, baseline, fixture) => {
  const {
    volunteerId,
    leaderId,
    candidateId,
    applicationId,
    secondSubstituteId,
    secondApplicationId,
    departmentId,
    semesterId,
    schoolId,
    substituteServiceDate,
  } = fixture;

  const reached = (name) => goldenSteps.indexOf(step) >= goldenSteps.indexOf(name);

  for (const name of [
    "affiliations",
    "affiliationHistory",
    "placements",
    "placementHistory",
    "demands",
    "proposals",
    "notifications",
  ])
    assert.deepEqual(facts[name], baseline[name], `${step} must not change ${name}`);

  // The candidate needs no affiliation or placement: the admission outcome alone puts them on call.
  assert.ok(!facts.affiliations.some((row) => row.person_id === candidateId));
  const [scheduled] = baseline.commitments;
  assert.equal(facts.commitments.length, 2);
  assert.deepEqual(facts.commitments[0], scheduled);
  const commitment = facts.commitments[1];
  assert.deepEqual(
    [
      commitment.proposal_id,
      commitment.department_id,
      commitment.semester_id,
      Number(commitment.school_id),
      commitment.day,
      commitment.block,
      commitment.service_date,
      commitment.start_time,
      commitment.end_time,
      commitment.required_volunteers,
      commitment.created_by_person_id,
    ],
    [
      scheduled.proposal_id,
      departmentId,
      semesterId,
      schoolId,
      "Monday",
      "2",
      substituteServiceDate,
      "09:00:00",
      "11:00:00",
      1,
      leaderId,
    ],
  );
  assert.deepEqual(commitment.assignment_snapshot, scheduled.assignment_snapshot);
  assert.deepEqual(facts.serviceHistory.slice(0, -1), baseline.serviceHistory);
  const scheduling = facts.serviceHistory.at(-1);
  assert.deepEqual(
    [
      scheduling.action,
      scheduling.actor_person_id,
      scheduling.snapshot.commitmentId,
      scheduling.snapshot.serviceDate,
    ],
    ["ScheduleService", leaderId, commitment.commitment_id, substituteServiceDate],
  );

  assert.equal(facts.absences.length, reached("substitute-absence") ? 1 : 0);
  const [absence] = facts.absences;

  if (absence)
    assert.deepEqual(
      [
        absence.commitment_id,
        absence.proposal_id,
        absence.person_id,
        absence.reporter_person_id,
        absence.service_date,
        Number(absence.school_id),
        absence.day,
        absence.block,
      ],
      [
        commitment.commitment_id,
        commitment.proposal_id,
        volunteerId,
        volunteerId,
        substituteServiceDate,
        schoolId,
        "Monday",
        "2",
      ],
    );

  // Admission management records the outcome; the highest revision of each application rules.
  assert.deepEqual(
    facts.admissionOutcomes.map(({ application_id, revision, outcome, decided_by_person_id }) => [
      application_id,
      revision,
      outcome,
      decided_by_person_id,
    ]),
    reached("outcome-recorded")
      ? [
          [applicationId, 1, "Substitute", leaderId],
          [secondApplicationId, 1, "Substitute", leaderId],
        ]
      : [],
  );

  // Coverage records in recording order: the volunteer names the candidate, the coordinator
  // replaces that record with the second substitute and withdraws it, the volunteer records again.
  assert.equal(
    facts.coverage.length,
    reached("coverage-rerecorded")
      ? 3
      : reached("coverage-replaced")
        ? 2
        : reached("coverage-recorded")
          ? 1
          : 0,
  );
  const [recorded, replaced, rerecorded] = facts.coverage;

  const assertRecord = (row, coveringPersonId, recordedBy, withdrawnBy) => {
    assert.match(row.coverage_id, /^school-service-coverage-[a-f0-9]{64}$/);
    assert.deepEqual(
      [
        row.absence_id,
        row.covering_person_id,
        row.coverer_kind,
        row.recorded_by_person_id,
        row.withdrawn_by_person_id,
        row.withdrawn_at === null,
      ],
      [absence.absence_id, coveringPersonId, "Substitute", recordedBy, withdrawnBy, withdrawnBy === null],
    );
  };

  if (recorded)
    assertRecord(recorded, candidateId, volunteerId, reached("coverage-replaced") ? leaderId : null);

  if (replaced) {
    assertRecord(
      replaced,
      secondSubstituteId,
      leaderId,
      reached("coverage-withdrawn") ? leaderId : null,
    );
    assert.equal(
      recorded.withdrawn_at.getTime(),
      replaced.recorded_at.getTime(),
      "a replacement withdraws the earlier record in the same transaction",
    );
  }

  if (rerecorded) assertRecord(rerecorded, candidateId, volunteerId, null);
  const current = facts.coverage.filter((row) => row.withdrawn_at === null);
  assertReservations(step, facts, [
    reservation(scheduled.commitment_id, volunteerId),
    reservation(commitment.commitment_id, volunteerId),
    ...current.map((row) =>
      reservation(commitment.commitment_id, row.covering_person_id, row.coverage_id),
    ),
  ]);

  // Attendance is derived: the roster minus the absent volunteer plus the covering person.
  const completed = reached("substitute-completed");
  assert.equal(facts.decisions.length, completed ? 2 : 1);
  assert.equal(facts.occurrences.length, completed ? 2 : 1);
  assert.deepEqual(facts.decisions[0], baseline.decisions[0]);
  assert.deepEqual(facts.occurrences[0], baseline.occurrences[0]);
  assert.equal(facts.closures.length, completed ? 1 : 0);
  const decision = facts.decisions[1];

  if (completed) {
    const occurrence = facts.occurrences[1];
    const [closure] = facts.closures;
    assert.deepEqual(
      [
        decision.commitment_id,
        decision.outcome,
        decision.decided_by_person_id,
        decision.reason,
        decision.attended_person_ids,
      ],
      [commitment.commitment_id, "Completed", leaderId, null, [candidateId]],
    );
    assert.deepEqual(
      [
        occurrence.occurrence_id,
        occurrence.commitment_id,
        occurrence.proposal_id,
        occurrence.occurred_on,
        occurrence.attended_person_ids,
        occurrence.recorded_by_person_id,
      ],
      [
        decision.occurrence_id,
        commitment.commitment_id,
        commitment.proposal_id,
        substituteServiceDate,
        [candidateId],
        leaderId,
      ],
    );
    assert.deepEqual(
      [
        closure.closure_id,
        closure.absence_id,
        closure.occurrence_id,
        closure.outcome,
        closure.scheduled_person_id,
        closure.coverage_id,
        closure.covering_person_id,
        closure.closed_by_person_id,
      ],
      [
        absence.absence_id.replace("school-service-absence-", "school-service-closure-"),
        absence.absence_id,
        occurrence.occurrence_id,
        "Covered",
        volunteerId,
        rerecorded.coverage_id,
        candidateId,
        leaderId,
      ],
    );
  }

  const coverageAudit = [
    [
      "substitute-absence",
      "ReportAbsence",
      volunteerId,
      () => ({
        absenceId: absence.absence_id,
        action: "ReportAbsence",
        commitmentId: commitment.commitment_id,
        personId: volunteerId,
      }),
    ],
    [
      "coverage-recorded",
      "RecordCoverage",
      volunteerId,
      () => ({
        coverageId: recorded.coverage_id,
        absenceId: absence.absence_id,
        coveringPersonId: candidateId,
        covererKind: "Substitute",
        replacedCoverageId: null,
      }),
    ],
    [
      "coverage-replaced",
      "RecordCoverage",
      leaderId,
      () => ({
        coverageId: replaced.coverage_id,
        absenceId: absence.absence_id,
        coveringPersonId: secondSubstituteId,
        covererKind: "Substitute",
        replacedCoverageId: recorded.coverage_id,
      }),
    ],
    [
      "coverage-withdrawn",
      "WithdrawCoverage",
      leaderId,
      () => ({ coverageId: replaced.coverage_id, absenceId: absence.absence_id }),
    ],
    [
      "coverage-rerecorded",
      "RecordCoverage",
      volunteerId,
      () => ({
        coverageId: rerecorded.coverage_id,
        absenceId: absence.absence_id,
        coveringPersonId: candidateId,
        covererKind: "Substitute",
        replacedCoverageId: null,
      }),
    ],
    [
      "substitute-completed",
      "CompleteService",
      leaderId,
      () => ({
        action: "CompleteService",
        commitmentId: commitment.commitment_id,
        evidenceSource: decision.evidence_source,
        attendedPersonIds: [candidateId],
        occurrenceId: decision.occurrence_id,
        outcome: "Completed",
      }),
    ],
  ];

  assert.deepEqual(
    facts.coverageHistory.slice(0, baseline.coverageHistory.length),
    baseline.coverageHistory,
  );
  assert.deepEqual(
    facts.coverageHistory
      .slice(baseline.coverageHistory.length)
      .map(({ action, actor_person_id, snapshot }) => [action, actor_person_id, snapshot]),
    coverageAudit.flatMap(([checkpoint, action, actor, snapshot]) =>
      reached(checkpoint) ? [[action, actor, snapshot()]] : [],
    ),
  );

  for (const entry of facts.coverageHistory) {
    assert.equal(entry.department_id, departmentId);
    assert.equal(entry.semester_id, semesterId);
  }

  const writes = substituteWrites[step] ?? [];

  if (writes.length === 0) assert.deepEqual(facts, previous, step + " must not change persisted facts");

  const added = facts.receipts.filter(
    (row) => !previous.receipts.some((old) => old.identity_sha256 === row.identity_sha256),
  );

  assert.deepEqual(
    added.map((row) => row.operation_id).sort(),
    [...writes].sort(),
    step + " must commit one successful receipt per executed write",
  );

  for (const receipt of added) {
    assert.equal(receipt.state, "Complete");
    const body = JSON.parse(receipt.body);
    assert.deepEqual([body.departmentId, body.semesterId], [departmentId, semesterId]);
    assert.match(body.etag, /^".+"$/);

    if (receipt.operation_id === "admissionOutcomes.recordOutcome")
      assert.deepEqual([body.outcome, body.revision], ["Substitute", 1]);
    else if (receipt.operation_id === "placements.commandBoard")
      assert.ok(body.commitments.some((row) => row.commitmentId === commitment.commitment_id));
    else
      assert.deepEqual(
        body.coverage.map(({ coverageId, coveringPersonId }) => [coverageId, coveringPersonId]),
        current.map((row) => [row.coverage_id, row.covering_person_id]),
      );
  }

  if (step === "outcome-recorded")
    assert.deepEqual(
      added.map((row) => JSON.parse(row.body).applicationId).sort(),
      [applicationId, secondApplicationId].sort(),
    );
};

export const createGoldenObserver = (pool, fixture, deliveries) => {
  const observations = [];
  let previous;
  let baseline;
  const { volunteerId, leaderId, departmentId, semesterId, schoolId, serviceDate } = fixture;

  const observe = async (step) => {
    assert.equal(
      step,
      goldenSteps[observations.length],
      "every required checkpoint must run in order",
    );
    let facts;
    const connection = await pool.connect();

    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = async (sql) => (await connection.query(sql)).rows;
      facts = {
        affiliations: await rows(
          "SELECT * FROM organization_volunteer_affiliations ORDER BY person_id",
        ),
        affiliationHistory: await rows(
          "SELECT * FROM organization_volunteer_affiliation_audit ORDER BY revision",
        ),
        placements: await rows("SELECT * FROM assistant_placements ORDER BY placement_id"),
        placementHistory: await rows("SELECT * FROM assistant_placement_audit ORDER BY revision"),
        demands: await rows("SELECT * FROM school_service_demand ORDER BY school_id,day,block"),
        proposals: await rows("SELECT * FROM school_service_proposals ORDER BY created_at"),
        commitments: await rows(
          "SELECT *,service_date::text AS service_date,start_time::text AS start_time,end_time::text AS end_time FROM school_service_commitments ORDER BY created_at,commitment_id",
        ),
        decisions: await rows(
          "SELECT * FROM school_service_decisions ORDER BY decided_at,commitment_id",
        ),
        occurrences: await rows(
          "SELECT *,occurred_on::text AS occurred_on FROM school_service_occurrences ORDER BY recorded_at,occurrence_id",
        ),
        serviceHistory: await rows("SELECT * FROM school_service_audit ORDER BY audit_id"),
        coverageHistory: await rows(
          "SELECT * FROM school_service_coverage_audit ORDER BY audit_id",
        ),
        notifications: await rows(
          "SELECT effect_id,proposal_id,person_id,payload_json FROM school_service_notification_outbox ORDER BY effect_id",
        ),
        absences: await rows(
          "SELECT *,service_date::text AS service_date FROM school_service_absences ORDER BY absence_id",
        ),
        coverage: await rows(
          "SELECT * FROM school_service_coverage_records ORDER BY recorded_at,coverage_id",
        ),
        reservations: await rows(
          "SELECT source_id,source_kind,commitment_id,coverage_id,person_id FROM school_service_person_reservations ORDER BY source_id",
        ),
        closures: await rows("SELECT * FROM school_service_closures ORDER BY closure_id"),
        admissionOutcomes: await rows(
          "SELECT * FROM admission_application_outcomes ORDER BY application_id,revision",
        ),
        receipts: await rows(
          "SELECT identity_sha256,operation_id,state,status,convert_from(body_bytes,'UTF8') AS body FROM native_http_idempotency_receipts WHERE status BETWEEN 200 AND 299 ORDER BY identity_sha256",
        ),
        volunteerAuthority: await rows(
          `SELECT person_id FROM organization_memberships WHERE person_id='${volunteerId}' UNION ALL SELECT person_id FROM organization_global_administrator_grants WHERE person_id='${volunteerId}'`,
        ),
      };
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }

    assert.deepEqual(
      facts.volunteerAuthority,
      [],
      "affiliation must not confer coordinator authority",
    );
    const index = goldenSteps.indexOf(step);

    if (step === "initial") {
      for (const [name, value] of Object.entries(facts))
        assert.deepEqual(value, [], `fixture must not seed ${name}`);
    } else if (index >= goldenSteps.indexOf("substitute-commitment")) {
      assertSubstituteFacts(step, facts, previous, baseline, fixture);
    } else {
      for (const name of ["absences", "coverage", "closures", "admissionOutcomes"])
        assert.deepEqual(facts[name], [], `${step} must not record ${name}`);
      assert.equal(facts.affiliations.length, 1);
      assert.deepEqual(facts.affiliations[0], {
        person_id: volunteerId,
        department_id: departmentId,
        status: index >= 2 ? "Active" : "Pending",
        revision: index >= 2 ? 2 : 1,
      });

      for (const entry of facts.affiliationHistory) {
        assert.equal(entry.person_id, volunteerId);
        assert.equal(entry.department_id, departmentId);
        assert.ok(entry.occurred_at);
      }

      assert.deepEqual(
        facts.affiliationHistory.map(({ action, actor_person_id }) => [action, actor_person_id]),
        index >= 2
          ? [
              ["Request", volunteerId],
              ["Establish", leaderId],
            ]
          : [["Request", volunteerId]],
      );
      assert.equal(facts.placements.length, index >= 4 ? 1 : 0);

      if (index >= 4) {
        const placement = facts.placements[0];
        assert.deepEqual(
          [
            placement.person_id,
            placement.department_id,
            placement.semester_id,
            Number(placement.school_id),
            placement.day,
            placement.block,
            placement.workdays,
            placement.active,
          ],
          [volunteerId, departmentId, semesterId, schoolId, "Monday", "2", 4, true],
        );
        assert.deepEqual(
          facts.placementHistory.map(({ action, actor_person_id, placement_id }) => [
            action,
            actor_person_id,
            placement_id,
          ]),
          [["Create", leaderId, placement.placement_id]],
        );
        assert.deepEqual(
          {
            ...facts.placementHistory[0].snapshot,
            school_id: String(facts.placementHistory[0].snapshot.school_id),
          },
          placement,
        );
      }

      assert.equal(facts.demands.length, index >= 5 ? 1 : 0);

      if (index >= 5) {
        const demand = facts.demands[0];
        assert.deepEqual(
          [
            demand.department_id,
            demand.semester_id,
            Number(demand.school_id),
            demand.day,
            demand.block,
            demand.required_volunteers,
          ],
          [departmentId, semesterId, schoolId, "Monday", "2", 1],
        );
      }

      assert.equal(facts.proposals.length, index >= 6 ? 1 : 0);
      assert.equal(facts.notifications.length, index >= 7 ? 1 : 0);

      if (index >= 6) {
        const proposal = facts.proposals[0];
        assert.equal(proposal.status, index >= 7 ? "Confirmed" : "Draft");
        assert.equal(proposal.created_by_person_id, leaderId);
        assert.deepEqual(proposal.exception_snapshot, []);
        assert.equal(proposal.demand_snapshot.length, 1);
        assert.equal(proposal.assignment_snapshot.length, 1);
        assert.deepEqual(
          proposal.demand_snapshot.map(({ schoolId, day, block, requiredVolunteers }) => [
            schoolId,
            day,
            block,
            requiredVolunteers,
          ]),
          [[schoolId, "Monday", "2", 1]],
        );
        assert.deepEqual(
          proposal.assignment_snapshot.map(({ personId, placementId, schoolId, day, block }) => [
            personId,
            placementId,
            schoolId,
            day,
            block,
          ]),
          [[volunteerId, facts.placements[0].placement_id, schoolId, "Monday", "2"]],
        );

        if (index >= 7) {
          assert.equal(proposal.confirmed_by_person_id, leaderId);
          assert.ok(proposal.confirmed_at);
          assert.equal(facts.notifications[0].proposal_id, proposal.proposal_id);
          assert.equal(facts.notifications[0].person_id, volunteerId);
          const { _tag, ...payload } = facts.notifications[0].payload_json;
          assert.equal(_tag, "NotifySchoolServiceRosterConfirmed");
          assert.deepEqual(payload, {
            effectId: facts.notifications[0].effect_id,
            proposalId: proposal.proposal_id,
            personId: volunteerId,
            departmentId,
            semesterId,
            assignments: proposal.assignment_snapshot,
            confirmedAt: proposal.confirmed_at.toISOString(),
          });
        }
      }

      assert.equal(facts.commitments.length, index >= 8 ? 1 : 0);
      assertReservations(
        step,
        facts,
        index >= 8 ? [reservation(facts.commitments[0].commitment_id, volunteerId)] : [],
      );

      if (index >= 8) {
        const commitment = facts.commitments[0];
        assert.deepEqual(
          [
            commitment.proposal_id,
            commitment.department_id,
            commitment.semester_id,
            Number(commitment.school_id),
            commitment.day,
            commitment.block,
            commitment.service_date,
            commitment.start_time,
            commitment.end_time,
            commitment.required_volunteers,
            commitment.created_by_person_id,
          ],
          [
            facts.proposals[0].proposal_id,
            departmentId,
            semesterId,
            schoolId,
            "Monday",
            "2",
            serviceDate,
            "09:00:00",
            "11:00:00",
            1,
            leaderId,
          ],
        );
        assert.deepEqual(commitment.assignment_snapshot, facts.proposals[0].assignment_snapshot);
      }

      assert.equal(facts.decisions.length, index >= 10 ? 1 : 0);
      assert.equal(facts.occurrences.length, index >= 10 ? 1 : 0);

      if (index >= 10) {
        const decision = facts.decisions[0];
        assert.deepEqual(
          [
            decision.commitment_id,
            decision.outcome,
            decision.decided_by_person_id,
            decision.evidence_source,
            decision.reason,
            decision.attended_person_ids,
          ],
          [
            facts.commitments[0].commitment_id,
            "Completed",
            leaderId,
            `Skole Beta kontakt, telefon ${serviceDate}`,
            null,
            [volunteerId],
          ],
        );
        const occurrence = facts.occurrences[0];
        assert.deepEqual(
          [
            occurrence.occurrence_id,
            occurrence.commitment_id,
            occurrence.proposal_id,
            occurrence.occurred_on,
            occurrence.attended_person_ids,
            occurrence.recorded_by_person_id,
          ],
          [
            decision.occurrence_id,
            decision.commitment_id,
            facts.proposals[0].proposal_id,
            serviceDate,
            [volunteerId],
            leaderId,
          ],
        );
      }

      assert.deepEqual(
        facts.serviceHistory.map(({ action, actor_person_id }) => [action, actor_person_id]),
        ["SetDemand", "GenerateProposal", "ConfirmProposal", "ScheduleService"]
          .slice(0, Math.max(0, Math.min(4, index - 4)))
          .map((action) => [action, leaderId]),
      );
      assert.deepEqual(
        facts.coverageHistory.map(({ action, actor_person_id }) => [action, actor_person_id]),
        index >= 10 ? [["CompleteService", leaderId]] : [],
      );

      for (const entry of [...facts.serviceHistory, ...facts.coverageHistory]) {
        assert.equal(entry.department_id, departmentId);
        assert.equal(entry.semester_id, semesterId);
        assert.ok(entry.occurred_at);
      }

      const snapshots = facts.serviceHistory.map((entry) => entry.snapshot);

      if (index >= 5)
        assert.deepEqual(snapshots[0], {
          action: "SetDemand",
          schoolId,
          day: "Monday",
          block: "2",
          requiredVolunteers: 1,
          revision: facts.demands[0].revision,
        });

      if (index >= 6)
        assert.deepEqual(snapshots[1], {
          proposalId: facts.proposals[0].proposal_id,
          exceptionIds: [],
        });

      if (index >= 7)
        assert.deepEqual(snapshots[2], {
          action: "ConfirmProposal",
          proposalId: facts.proposals[0].proposal_id,
          reviewedExceptionIds: [],
        });

      if (index >= 8)
        assert.deepEqual(snapshots[3], {
          action: "ScheduleService",
          proposalId: facts.proposals[0].proposal_id,
          schoolId,
          day: "Monday",
          block: "2",
          serviceDate,
          startTime: "09:00",
          endTime: "11:00",
          commitmentId: facts.commitments[0].commitment_id,
          requiredVolunteers: 1,
          assignments: facts.proposals[0].assignment_snapshot,
        });

      // The command carries no attendance; the audit keeps the attendance derived from the roster.
      if (index >= 10)
        assert.deepEqual(facts.coverageHistory[0].snapshot, {
          action: "CompleteService",
          commitmentId: facts.commitments[0].commitment_id,
          attendedPersonIds: [volunteerId],
          evidenceSource: facts.decisions[0].evidence_source,
          occurrenceId: facts.decisions[0].occurrence_id,
          outcome: "Completed",
        });

      if (["forbidden", "insufficient", "stale", "independent-read"].includes(step)) {
        assert.deepEqual(
          facts,
          previous,
          `${step} must preserve business facts, successful command receipts and notification work`,
        );
      } else {
        const added = facts.receipts.filter(
          (row) => !previous.receipts.some((old) => old.identity_sha256 === row.identity_sha256),
        );

        assert.equal(
          added.length,
          1,
          `${step} must commit one successful command receipt with its decision`,
        );
        assert.equal(added[0].state, "Complete");
        const body = JSON.parse(added[0].body);
        assert.equal(
          added[0].operation_id,
          {
            affiliation: "placements.commandOwnAffiliation",
            completed: "placements.commandCoverageBoard",
          }[step] ?? "placements.commandBoard",
        );
        assert.equal(body.departmentId, departmentId);
        assert.match(body.etag, /^".+"$/);

        if (step === "affiliation") {
          assert.deepEqual(
            [body.personId, body.status, body.revision],
            [volunteerId, "Pending", 1],
          );
        } else {
          assert.equal(body.semesterId, semesterId);

          if (step !== "completed") {
            assert.deepEqual(
              body.affiliations.map(({ personId, status, revision }) => [
                personId,
                status,
                revision,
              ]),
              [[volunteerId, "Active", 2]],
            );
            assert.deepEqual(
              body.placements.map(
                ({ placementId, personId, schoolId, day, block, workdays, active }) => [
                  placementId,
                  personId,
                  schoolId,
                  day,
                  block,
                  workdays,
                  active,
                ],
              ),
              facts.placements.map((p) => [
                p.placement_id,
                p.person_id,
                Number(p.school_id),
                p.day,
                p.block,
                p.workdays,
                p.active,
              ]),
            );
            assert.deepEqual(
              body.demands.map(({ schoolId, day, block, requiredVolunteers }) => [
                schoolId,
                day,
                block,
                requiredVolunteers,
              ]),
              facts.demands.map((d) => [
                Number(d.school_id),
                d.day,
                d.block,
                d.required_volunteers,
              ]),
            );

            if (facts.proposals.length) {
              assert.equal(body.proposal.proposalId, facts.proposals[0].proposal_id);
              assert.equal(body.proposal.status, facts.proposals[0].status);
              assert.deepEqual(body.proposal.assignments, facts.proposals[0].assignment_snapshot);
              assert.deepEqual(body.proposal.demands, facts.proposals[0].demand_snapshot);
            } else assert.equal(body.proposal, null);
          } else assert.deepEqual(body.coverage, []);

          assert.equal(body.commitments.length, facts.commitments.length);

          if (facts.commitments.length) {
            const returned = body.commitments[0];
            assert.deepEqual(
              [
                returned.commitmentId,
                returned.proposalId,
                returned.schoolId,
                returned.serviceDate,
                returned.startTime,
                returned.endTime,
                returned.requiredVolunteers,
              ],
              [
                facts.commitments[0].commitment_id,
                facts.proposals[0].proposal_id,
                schoolId,
                serviceDate,
                "09:00",
                "11:00",
                1,
              ],
            );
            assert.deepEqual(returned.assignments, facts.proposals[0].assignment_snapshot);

            if (step === "completed")
              assert.deepEqual(
                [
                  returned.decision.outcome,
                  returned.decision.attendedPersonIds,
                  returned.decision.evidenceSource,
                  returned.decision.decidedBy,
                  returned.decision.occurrenceId,
                ],
                [
                  "Completed",
                  [volunteerId],
                  facts.decisions[0].evidence_source,
                  leaderId,
                  facts.decisions[0].occurrence_id,
                ],
              );
            else assert.equal(returned.decision, null);
          }
        }
      }
    }

    if (step === "independent-read") baseline = facts;
    const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    observations.push({
      step,
      boundary: "independent-postgresql",
      digest,
      affiliation: facts.affiliations[0]?.status ?? null,
      placementId: facts.placements[0]?.placement_id ?? null,
      proposalId: facts.proposals[0]?.proposal_id ?? null,
      commitmentId: facts.commitments[0]?.commitment_id ?? null,
      outcome: facts.decisions[0]?.outcome ?? null,
      history: [
        ...facts.affiliationHistory,
        ...facts.placementHistory,
        ...facts.serviceHistory,
        ...facts.coverageHistory,
      ].map((row) => ({ action: row.action, actor: row.actor_person_id })),
      successfulReceipts: facts.receipts.map(({ identity_sha256, operation_id, status }) => ({
        identity: identity_sha256,
        operation: operation_id,
        status,
      })),
      coverage: {
        admissionOutcomes: facts.admissionOutcomes,
        absences: facts.absences,
        records: facts.coverage,
        reservations: facts.reservations,
        decisions: facts.decisions,
        occurrences: facts.occurrences,
        closures: facts.closures,
      },
      effects: facts.notifications.map(({ effect_id, person_id }) => ({
        effectId: effect_id,
        personId: person_id,
      })),
    });
    previous = facts;

    return observations.at(-1);
  };

  const finish = async () => {
    assert.deepEqual(
      observations.map(({ step }) => step),
      goldenSteps,
    );
    const deadline = Date.now() + 15000;
    let notification;

    do {
      notification = (
        await pool.query(
          "SELECT effect_id,proposal_id,person_id,status,attempts,payload_json FROM school_service_notification_outbox",
        )
      ).rows[0];

      if (notification?.status === "Delivered") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);

    assert.equal(notification?.status, "Delivered");
    const captures = deliveries;
    assert.ok(
      captures.every(
        (item) =>
          item.idempotencyKey === notification.effect_id &&
          item.body.effectId === notification.effect_id,
      ),
      "no unintended logical provider effect is permitted",
    );
    assert.ok(
      captures.length >= 1,
      "loopback receiver must observe delivery of committed logical effect",
    );

    for (const capture of captures) {
      assert.equal(capture.authorization, "Bearer synthetic-school-service-token");
      assert.deepEqual(capture.body, notification.payload_json);
    }

    return {
      observations,
      loopbackProvider: {
        effectId: notification.effect_id,
        personId: volunteerId,
        proposalId: notification.proposal_id,
        status: notification.status,
        attempts: notification.attempts,
        requests: captures.length,
        realProviderAcceptance: false,
      },
    };
  };

  return { observe, observations, finish };
};
