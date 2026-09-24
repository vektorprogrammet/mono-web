import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const goldenSteps = [
  "initial", "affiliation", "approval", "forbidden", "placement", "demand", "proposal",
  "confirmation", "commitment", "insufficient", "completed", "stale", "independent-read",
];

export const createGoldenObserver = (pool, fixture, deliveries) => {
  const observations = [];
  let previous;
  const { volunteerId, leaderId, departmentId, semesterId, schoolId, serviceDate } = fixture;
  const observe = async (step) => {
    assert.equal(step, goldenSteps[observations.length], "every required checkpoint must run in order");
    const connection = await pool.connect();
    let facts;
    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = async (sql) => (await connection.query(sql)).rows;
      facts = {
        affiliations: await rows("SELECT * FROM organization_volunteer_affiliations ORDER BY person_id"),
        affiliationHistory: await rows("SELECT * FROM organization_volunteer_affiliation_audit ORDER BY revision"),
        placements: await rows("SELECT * FROM assistant_placements ORDER BY placement_id"),
        placementHistory: await rows("SELECT * FROM assistant_placement_audit ORDER BY revision"),
        demands: await rows("SELECT * FROM school_service_demand"),
        proposals: await rows("SELECT * FROM school_service_proposals"),
        commitments: await rows("SELECT *,service_date::text AS service_date,start_time::text AS start_time,end_time::text AS end_time FROM school_service_commitments"),
        decisions: await rows("SELECT * FROM school_service_decisions"),
        occurrences: await rows("SELECT *,occurred_on::text AS occurred_on FROM school_service_occurrences"),
        serviceHistory: await rows("SELECT * FROM school_service_audit ORDER BY audit_id"),
        outcomeHistory: await rows("SELECT * FROM school_service_coverage_audit ORDER BY audit_id"),
        notifications: await rows("SELECT effect_id,proposal_id,person_id,payload_json FROM school_service_notification_outbox ORDER BY effect_id"),
        dispatches: await rows("SELECT effect_id FROM school_service_dispatch_notification_outbox"),
        receipts: await rows("SELECT identity_sha256,operation_id,state,status,convert_from(body_bytes,'UTF8') AS body FROM native_http_idempotency_receipts WHERE status BETWEEN 200 AND 299 ORDER BY identity_sha256"),
        volunteerAuthority: await rows(`SELECT person_id FROM organization_memberships WHERE person_id='${volunteerId}' UNION ALL SELECT person_id FROM organization_global_administrator_grants WHERE person_id='${volunteerId}'`),
      };
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    assert.deepEqual(facts.volunteerAuthority, [], "affiliation must not confer coordinator authority");
    assert.deepEqual(facts.dispatches, [], "ordinary service must not create substitute notifications");
    const index = goldenSteps.indexOf(step);
    if (step === "initial") {
      for (const [name, value] of Object.entries(facts)) assert.deepEqual(value, [], `fixture must not seed ${name}`);
    } else {
      assert.equal(facts.affiliations.length, 1);
      assert.deepEqual(facts.affiliations[0], {
        person_id: volunteerId, department_id: departmentId,
        status: index >= 2 ? "Active" : "Pending", revision: index >= 2 ? 2 : 1,
      });
      assert.deepEqual(facts.affiliationHistory.map(({ action, actor_person_id }) => [action, actor_person_id]),
        index >= 2 ? [["Request", volunteerId], ["Establish", leaderId]] : [["Request", volunteerId]]);
      assert.equal(facts.placements.length, index >= 4 ? 1 : 0);
      if (index >= 4) {
        const placement = facts.placements[0];
        assert.deepEqual([placement.person_id, placement.department_id, placement.semester_id, Number(placement.school_id), placement.day, placement.block, placement.workdays, placement.active],
          [volunteerId, departmentId, semesterId, schoolId, "Monday", "2", 4, true]);
        assert.deepEqual(facts.placementHistory.map(({ action, actor_person_id, placement_id }) => [action, actor_person_id, placement_id]), [["Create", leaderId, placement.placement_id]]);
      }
      assert.equal(facts.demands.length, index >= 5 ? 1 : 0);
      if (index >= 5) {
        const demand = facts.demands[0];
        assert.deepEqual([demand.department_id, demand.semester_id, Number(demand.school_id), demand.day, demand.block, demand.required_volunteers], [departmentId, semesterId, schoolId, "Monday", "2", 1]);
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
        assert.deepEqual(proposal.demand_snapshot.map(({ schoolId, day, block, requiredVolunteers }) => [schoolId, day, block, requiredVolunteers]), [[schoolId, "Monday", "2", 1]]);
        assert.deepEqual(proposal.assignment_snapshot.map(({ personId, placementId, schoolId, day, block }) => [personId, placementId, schoolId, day, block]), [[volunteerId, facts.placements[0].placement_id, schoolId, "Monday", "2"]]);
        if (index >= 7) {
          assert.equal(proposal.confirmed_by_person_id, leaderId);
          assert.ok(proposal.confirmed_at);
          assert.equal(facts.notifications[0].proposal_id, proposal.proposal_id);
          assert.equal(facts.notifications[0].person_id, volunteerId);
        }
      }
      assert.equal(facts.commitments.length, index >= 8 ? 1 : 0);
      if (index >= 8) {
        const commitment = facts.commitments[0];
        assert.deepEqual([commitment.proposal_id, commitment.department_id, commitment.semester_id, Number(commitment.school_id), commitment.day, commitment.block, commitment.service_date, commitment.start_time, commitment.end_time, commitment.required_volunteers, commitment.created_by_person_id],
          [facts.proposals[0].proposal_id, departmentId, semesterId, schoolId, "Monday", "2", serviceDate, "09:00:00", "11:00:00", 1, leaderId]);
        assert.deepEqual(commitment.assignment_snapshot, facts.proposals[0].assignment_snapshot);
      }
      assert.equal(facts.decisions.length, index >= 10 ? 1 : 0);
      assert.equal(facts.occurrences.length, index >= 10 ? 1 : 0);
      if (index >= 10) {
        const decision = facts.decisions[0];
        assert.deepEqual([decision.commitment_id, decision.outcome, decision.decided_by_person_id, decision.evidence_source, decision.reason, decision.attended_person_ids],
          [facts.commitments[0].commitment_id, "Completed", leaderId, `Skole Beta kontakt, telefon ${serviceDate}`, null, [volunteerId]]);
        const occurrence = facts.occurrences[0];
        assert.deepEqual([occurrence.occurrence_id, occurrence.commitment_id, occurrence.proposal_id, occurrence.occurred_on, occurrence.attended_person_ids, occurrence.recorded_by_person_id],
          [decision.occurrence_id, decision.commitment_id, facts.proposals[0].proposal_id, serviceDate, [volunteerId], leaderId]);
      }
      assert.deepEqual(facts.serviceHistory.map(({ action, actor_person_id }) => [action, actor_person_id]),
        ["SetDemand", "GenerateProposal", "ConfirmProposal", "ScheduleService"].slice(0, Math.max(0, Math.min(4, index - 4))).map(action => [action, leaderId]));
      assert.deepEqual(facts.outcomeHistory.map(({ action, actor_person_id }) => [action, actor_person_id]), index >= 10 ? [["CompleteService", leaderId]] : []);
      if (["forbidden", "insufficient", "stale", "independent-read"].includes(step)) {
        assert.deepEqual(facts, previous, `${step} must preserve business facts, successful command receipts and notification work`);
      } else {
        const added = facts.receipts.filter(row => !previous.receipts.some(old => old.identity_sha256 === row.identity_sha256));
        assert.equal(added.length, 1, `${step} must commit one successful command receipt with its decision`);
        assert.equal(added[0].state, "Complete");
        const body = JSON.parse(added[0].body);
        assert.ok(body && typeof body === "object");
        if (step === "completed") {
          assert.ok(added[0].body.includes(facts.commitments[0].commitment_id));
          assert.ok(added[0].body.includes('"Completed"'));
        }
      }
    }
    const digest = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    observations.push({ step, boundary: "independent-postgresql", digest, affiliation: facts.affiliations[0]?.status ?? null,
      placementId: facts.placements[0]?.placement_id ?? null, proposalId: facts.proposals[0]?.proposal_id ?? null,
      commitmentId: facts.commitments[0]?.commitment_id ?? null, outcome: facts.decisions[0]?.outcome ?? null,
      history: [...facts.affiliationHistory, ...facts.placementHistory, ...facts.serviceHistory, ...facts.outcomeHistory].map(row => ({ action: row.action, actor: row.actor_person_id })),
      successfulReceipts: facts.receipts.map(({ identity_sha256, operation_id, status }) => ({ identity: identity_sha256, operation: operation_id, status })),
      effects: facts.notifications.map(({ effect_id, person_id }) => ({ effectId: effect_id, personId: person_id })),
    });
    previous = facts;
    return observations.at(-1);
  };
  const finish = async () => {
    assert.deepEqual(observations.map(({ step }) => step), goldenSteps);
    const deadline = Date.now() + 15000;
    let notification;
    do {
      notification = (await pool.query("SELECT effect_id,proposal_id,person_id,status,attempts,payload_json FROM school_service_notification_outbox")).rows[0];
      if (notification?.status === "Delivered") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(notification?.status, "Delivered");
    const captures = deliveries.filter(item => item.idempotencyKey === notification.effect_id);
    assert.ok(captures.length >= 1, "loopback receiver must observe delivery of committed logical effect");
    for (const capture of captures) {
      assert.equal(capture.authorization, "Bearer synthetic-school-service-token");
      assert.deepEqual(capture.body, notification.payload_json);
    }
    return { observations, loopbackProvider: { effectId: notification.effect_id, personId: volunteerId, proposalId: notification.proposal_id, status: notification.status, attempts: notification.attempts, requests: captures.length, realProviderAcceptance: false } };
  };
  return { observe, observations, finish };
};
