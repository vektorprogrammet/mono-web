import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const recruitmentSteps = [
  "initial",
  "applications",
  "assigned",
  "scheduled",
  "responded",
  "recommended",
  "reloaded",
  "invitation-failed",
  "invitation-delivered",
  "other-claimed",
  "other-applicant-denied",
  "claim-opened",
  "claimed",
  "claim-replayed",
  "affiliation-requested",
  "wrong-scope-denied",
  "affiliation-approved",
  "placed",
  "fresh-volunteer",
];

export const recruitmentRunnerPaths = [
  "tools/e2e/placement-check.ts",
  "tools/e2e/golden-recruitment.mjs",
  "apps/dashboard/e2e/run-real-native-placement.mjs",
  "apps/dashboard/e2e/native-recruitment-first-placement.spec.ts",
  "tools/e2e/golden-school-service-evidence.mjs",
];

export const recruitmentPeople = {
  leader: {
    personId: "recruitment-leader",
    firstName: "Lina",
    lastName: "Lagleder",
    email: "leader@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
  wrongDepartment: {
    personId: "recruitment-wrong",
    firstName: "Wera",
    lastName: "Lagleder",
    email: "wrong@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
  applicant: {
    firstName: "Ada",
    lastName: "Rekrutt",
    email: "ada@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
  other: {
    firstName: "Olav",
    lastName: "Annen",
    email: "olav@example.invalid",
    password: "journey-secret-0123456789abcdef",
  },
};

export const recruitmentFixture = {
  departmentId: "recruitment-department",
  wrongDepartmentId: "recruitment-wrong-department",
  semesterId: "recruitment-semester",
  fieldId: "recruitment-field",
  schemaId: "recruitment-schema",
  schoolId: 925,
  persons: recruitmentPeople,
};

export const seedRecruitment = async (pool) => {
  await pool.query(`
    INSERT INTO admission_period_departments(department_id,name) VALUES ('recruitment-department','Trondheim'),('recruitment-wrong-department','Annen');
    INSERT INTO admission_period_semesters(semester_id,start_at,end_at) VALUES ('recruitment-semester',now()-interval '30 days',now()+interval '90 days');
    INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES
      ('recruitment-department','Vektorprogrammet Trondheim','Trondheim','trondheim@example.invalid','Trondheim',true,0),
      ('recruitment-wrong-department','Annen avdeling','Annen','wrong@example.invalid','Annen',true,0);
    INSERT INTO organization_teams(team_id,department_id,name,active,revision) VALUES
      ('recruitment-team','recruitment-department','Koordinator',true,0),('recruitment-wrong-team','recruitment-wrong-department','Koordinator',true,0);
    INSERT INTO organization_memberships(membership_id,person_id,team_id,deleted_team_name,start_at,end_at,position_id,is_team_leader,is_suspended,revision) VALUES
      ('recruitment-leader','recruitment-leader','recruitment-team',NULL,now()-interval '1 day',NULL,'teamleader',true,false,0),
      ('recruitment-wrong','recruitment-wrong','recruitment-wrong-team',NULL,now()-interval '1 day',NULL,'teamleader',true,false,0);
    INSERT INTO person_contact_profiles(person_id,email,phone) VALUES ('recruitment-leader','leader@example.invalid','90000925'),('recruitment-wrong','wrong@example.invalid','90000926');
    INSERT INTO schools_directory_schools(school_id,name,contact_person,email,phone,language,active,revision) OVERRIDING SYSTEM VALUE VALUES (925,'Rekrutt skole','Kontakt','school@example.invalid','90000925','Norwegian',true,0);
    INSERT INTO schools_directory_departments(school_id,department_id,revision) VALUES (925,'recruitment-department',0);
    INSERT INTO admission_period_fields_of_study(field_of_study_id,department_id,name) VALUES('recruitment-field','recruitment-department','Matematikk');
    INSERT INTO admission_periods(admission_period_id,department_id,semester_id,start_at,end_at,last_command_id) VALUES('recruitment-period','recruitment-department','recruitment-semester',now()-interval '1 day',now()+interval '30 days','prerequisite');
    INSERT INTO recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES('recruitment-schema','Rekruttintervju',1,true,0);
    INSERT INTO recruitment_interview_schema_questions(interview_schema_id,question_id,ordinal,prompt,help_text,kind,alternatives) VALUES('recruitment-schema','recruitment-motivation',0,'Hvorfor vil du bidra?',NULL,'text','[]');
  `);
};

// Private provider bodies stay in memory. Only their digest and delivery status enter evidence.
export const createRecruitmentMailbox = () => {
  const deliveries = [];
  let fails = true;

  return {
    deliveries,
    recover: () => {
      fails = false;
    },
    handle: async (request, response) => {
      if (request.url === "/mail" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(deliveries.flatMap((item) => (item.status === 204 ? [item.body] : []))),
        );

        return;
      }

      const chunks = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      const status =
        request.url === "/onboarding" && body.to === recruitmentPeople.applicant.email && fails
          ? 503
          : 204;

      assert.equal(request.headers.authorization, "Bearer " + "synthetic-recruitment-provider");
      deliveries.push({
        body,
        status,
        key: request.headers["idempotency-key"],
        digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      });
      response.statusCode = status;
      response.end();
    },
  };
};

const tables = [
  "admission_applications",
  "admission_application_command_receipts",
  "admission_application_outbox",
  "recruitment_interviews",
  "recruitment_assignment_command_receipts",
  "recruitment_assignment_audit",
  "recruitment_interview_schedules",
  "recruitment_schedule_command_receipts",
  "recruitment_schedule_audit",
  "recruitment_invitations",
  "recruitment_invitation_response_audit",
  "recruitment_interview_conducts",
  "recruitment_interview_lifecycle_command_receipts",
  "recruitment_interview_lifecycle_audit",
  "recruitment_interview_completion_outbox",
  "applicant_account_invitations",
  "applicant_account_links",
  "applicant_account_audit",
  "organization_volunteer_affiliations",
  "organization_volunteer_affiliation_audit",
  "assistant_placements",
  "assistant_placement_audit",
];

export const createRecruitmentObserver = (pool, mailbox) => {
  const observations = [];
  let previous;

  const observe = async (step) => {
    assert.equal(step, recruitmentSteps[observations.length], "checkpoint order");

    const result = await pool.query(`SELECT json_build_object(
      'counts', json_build_object(${tables.map((table) => `'${table}',(SELECT count(*)::int FROM public.${table})`).join(",")}),
      'applications',(SELECT coalesce(json_agg(row_to_json(a) ORDER BY a.email),'[]') FROM (SELECT p.email,a.application_id,a.applicant_id FROM admission_applications a JOIN admission_applicants p USING(applicant_id)) a),
      'interviews',(SELECT coalesce(json_agg(row_to_json(i)),'[]') FROM (SELECT interview_id,application_id,interviewer_person_id,revision FROM recruitment_interviews) i),
      'responses',(SELECT coalesce(json_agg(response_state),'[]') FROM recruitment_invitations),
      'conducts',(SELECT coalesce(json_agg(row_to_json(c)),'[]') FROM (SELECT interview_id,recommendation,explanatory_power,role_model,suitability,finalized_by_person_id FROM recruitment_interview_conducts) c),
      'links',(SELECT coalesce(json_agg(row_to_json(l) ORDER BY l.applicant_id),'[]') FROM applicant_account_links l),
      'accounts',(SELECT count(*)::int FROM auth.account a JOIN auth."user" u ON u.id=a."userId" WHERE u.email IN ('ada@example.invalid','olav@example.invalid')),
      'invitations',(SELECT coalesce(json_agg(row_to_json(i) ORDER BY i.application_id),'[]') FROM (SELECT invitation_id,application_id,state FROM applicant_account_invitations) i),
      'affiliations',(SELECT coalesce(json_agg(row_to_json(a)),'[]') FROM organization_volunteer_affiliations a),
      'placements',(SELECT coalesce(json_agg(row_to_json(p)),'[]') FROM assistant_placements p),
      'delivery',(SELECT coalesce(json_agg(row_to_json(d) ORDER BY d.invitation_id),'[]') FROM (SELECT invitation_id,state,attempts,secret IS NULL AS secret_cleared,envelope IS NULL AS envelope_cleared FROM applicant_account_delivery) d),
      'interviewDelivery',(SELECT coalesce(json_agg(status),'[]') FROM recruitment_invitation_outbox),
      'completionDelivery',(SELECT coalesce(json_agg(status),'[]') FROM recruitment_interview_completion_outbox)
    ) AS facts`);

    const facts = result.rows[0].facts;
    const at = (name) => recruitmentSteps.indexOf(step) >= recruitmentSteps.indexOf(name);
    const n = (table, expected) => assert.equal(facts.counts[table], expected, `${step}: ${table}`);
    n("admission_applications", at("applications") ? 2 : 0);
    n("admission_application_command_receipts", at("applications") ? 2 : 0);

    for (const table of [
      "recruitment_interviews",
      "recruitment_assignment_command_receipts",
      "recruitment_assignment_audit",
    ])
      n(table, at("assigned") ? 1 : 0);

    for (const table of [
      "recruitment_interview_schedules",
      "recruitment_schedule_command_receipts",
      "recruitment_schedule_audit",
      "recruitment_invitations",
    ])
      n(table, at("scheduled") ? 1 : 0);

    n("recruitment_invitation_response_audit", at("responded") ? 1 : 0);

    for (const table of [
      "recruitment_interview_conducts",
      "recruitment_interview_lifecycle_command_receipts",
      "recruitment_interview_lifecycle_audit",
      "recruitment_interview_completion_outbox",
    ])
      n(table, at("recommended") ? 1 : 0);
    n("applicant_account_invitations", at("other-claimed") ? 2 : at("invitation-failed") ? 1 : 0);
    n("applicant_account_links", at("claimed") ? 2 : at("other-claimed") ? 1 : 0);
    n(
      "applicant_account_audit",
      at("claimed") ? 4 : at("other-claimed") ? 3 : at("invitation-failed") ? 1 : 0,
    );
    assert.equal(facts.accounts, facts.counts.applicant_account_links);
    n("organization_volunteer_affiliations", at("affiliation-requested") ? 1 : 0);
    n(
      "organization_volunteer_affiliation_audit",
      at("affiliation-approved") ? 2 : at("affiliation-requested") ? 1 : 0,
    );
    n("assistant_placements", at("placed") ? 1 : 0);
    n("assistant_placement_audit", at("placed") ? 1 : 0);

    if (at("responded")) assert.deepEqual(facts.responses, ["Accepted"]);

    if (at("recommended"))
      assert.deepEqual(
        facts.conducts.map((c) => [
          c.recommendation,
          c.explanatory_power,
          c.role_model,
          c.suitability,
          c.finalized_by_person_id,
        ]),
        [["Ja", 7, 8, 9, recruitmentPeople.leader.personId]],
      );

    if (step === "invitation-failed") {
      assert.deepEqual(
        facts.delivery.map((d) => [d.state, d.attempts, d.secret_cleared]),
        [["Pending", 1, false]],
      );
      mailbox.recover();
    }

    if (step === "invitation-delivered") {
      assert.deepEqual(
        facts.delivery.map((d) => [d.state, d.attempts, d.secret_cleared, d.envelope_cleared]),
        [["Delivered", 2, true, true]],
      );

      const attempts = mailbox.deliveries.filter(
        (d) => d.body.to === recruitmentPeople.applicant.email,
      );

      assert.deepEqual(
        attempts.map((d) => d.status),
        [503, 204],
      );
      assert.equal(attempts[0].key, attempts[1].key);
      assert.equal(attempts[0].digest, attempts[1].digest);
    }

    if (
      [
        "reloaded",
        "other-applicant-denied",
        "claim-opened",
        "claim-replayed",
        "wrong-scope-denied",
        "fresh-volunteer",
      ].includes(step)
    ) {
      const stable = ({
        delivery: _delivery,
        interviewDelivery: _interviewDelivery,
        completionDelivery: _completionDelivery,
        ...rest
      }) => rest;

      assert.deepEqual(stable(facts), stable(previous), `${step}: business facts must not change`);
    }

    if (at("affiliation-requested")) {
      const main = facts.applications.find((a) => a.email === recruitmentPeople.applicant.email);
      const link = facts.links.find((l) => l.applicant_id === main.applicant_id);
      assert.equal(facts.affiliations[0].person_id, link.person_id);
      assert.equal(facts.affiliations[0].status, at("affiliation-approved") ? "Active" : "Pending");

      if (at("placed"))
        assert.deepEqual(
          facts.placements.map((p) => [
            p.person_id,
            p.school_id,
            p.day,
            p.workdays,
            p.block,
            p.active,
          ]),
          [[link.person_id, 925, "Monday", 4, "1", true]],
        );
    }

    previous = facts;
    observations.push({ step, ...facts });

    return facts;
  };

  return {
    observations,
    observe,
    finish: () => {
      assert.deepEqual(
        observations.map((o) => o.step),
        recruitmentSteps,
      );
      assert.deepEqual(previous.interviewDelivery, ["Delivered"]);
      assert.deepEqual(previous.completionDelivery, ["Delivered"]);

      return {
        deliveries: mailbox.deliveries.map(({ status, key, digest }) => ({ status, key, digest })),
      };
    },
  };
};
