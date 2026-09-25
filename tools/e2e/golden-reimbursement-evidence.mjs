import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { sha256 } from "./golden-school-service-evidence.mjs";

export const reimbursementSteps = [
  "initial",
  "submitted",
  "submission-replay",
  "private-denials",
  "restart-custody",
  "approval-failed-delivery",
  "approval-replay-stale",
  "settlement-authority-denial",
  "unattended-recovery",
  "settled",
  "settlement-replay-stale",
  "fresh-owner",
];

export const receiptBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export const fixture = {
  departmentId: "reimbursement-department",
  foreignDepartmentId: "reimbursement-foreign",
  description: "Synthetic bus ticket reimbursement",
  amountOre: 12550,
  receiptDate: "2026-09-20",
  externalAuthority: "Synthetic external ledger",
  externalReference: "reimbursement-external-001",
  settledAt: "2026-09-21T10:00:00.000Z",
};

export const people = (password) =>
  Object.fromEntries(
    ["owner", "other", "approver", "finance", "wrongScope"].map((role) => [
      role,
      {
        personId: `reimbursement-${role}`,
        firstName: "Synthetic",
        lastName: role,
        email: `reimbursement.${role.toLowerCase()}@example.invalid`,
        password,
      },
    ]),
  );

// Prerequisites only. Every receipt, decision, settlement and delivered notification is runtime work.
export const seedReimbursement = async (pool, persons) => {
  for (const [department, label] of [
    [fixture.departmentId, "R"],
    [fixture.foreignDepartmentId, "F"],
  ]) {
    await pool.query(
      "INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES($1,$1,$2,$3,'Trondheim',true,0)",
      [department, label, `${label.toLowerCase()}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO organization_teams(team_id,department_id,name,active,revision) VALUES($1,$2,'Synthetic team',true,0)",
      [`${department}-team`, department],
    );
  }

  for (const [role, person] of Object.entries(persons)) {
    await pool.query(
      "INSERT INTO person_contact_profiles(person_id,email,phone,revision) VALUES($1,$2,'90000000',0)",
      [person.personId, person.email],
    );
    const department = role === "wrongScope" ? fixture.foreignDepartmentId : fixture.departmentId;
    await pool.query(
      "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader,is_suspended,revision) VALUES($1,$2,$3,'2020-01-01',false,false,0)",
      [`${person.personId}-membership`, person.personId, `${department}-team`],
    );
  }

  await pool.query(
    "INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES('reimbursement-payment',$1,$2,'synthetic:private-destination','2020-01-01',0)",
    [persons.owner.personId, fixture.departmentId],
  );

  for (const role of ["approver", "wrongScope"]) {
    await pool.query(
      "INSERT INTO economy_receipt_approval_grants(approval_grant_id,person_id,scope,department_id,start_at,revision) VALUES($1,$2,'Department',$3,'2020-01-01',0)",
      [
        `${role}-approval`,
        persons[role].personId,
        role === "approver" ? fixture.departmentId : fixture.foreignDepartmentId,
      ],
    );
  }

  await pool.query(
    "INSERT INTO economy_receipt_settlement_grants(settlement_grant_id,person_id,scope,department_id,start_at,revision) VALUES('reimbursement-settlement',$1,'Department',$2,'2020-01-01',0)",
    [persons.finance.personId, fixture.departmentId],
  );
};

export const createReimbursementObserver = (pool, committedRoot, persons) => {
  const observations = [];
  let receiptId;
  let prior;

  const read = async () => {
    const connection = await pool.connect();

    try {
      await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

      const receipts = (
        await connection.query(
          `SELECT receipt_id, visual_id, owner_person_id, department_id, amount_ore::text, currency, description, receipt_date::text, status, revision, file_ref, file_object_key, file_content_type, file_byte_length::int, file_sha256 FROM economy_receipts ORDER BY receipt_id`,
        )
      ).rows;

      const audit = (
        await connection.query(
          "SELECT command_id,receipt_id,actor_person_id,action,receipt_revision FROM economy_receipt_audit ORDER BY receipt_revision,command_id",
        )
      ).rows;

      const commands = (
        await connection.query(
          "SELECT command_id,receipt_id,command_sha256 FROM economy_receipt_command_receipts ORDER BY command_id",
        )
      ).rows;

      const settlements = (
        await connection.query(
          "SELECT settlement_id,receipt_id,amount_ore::text,currency,external_authority,external_reference,to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS settled_at,recorded_by_person_id,receipt_revision,payment_destination_fingerprint FROM economy_receipt_settlements ORDER BY settlement_id",
        )
      ).rows;

      const outbox = (
        await connection.query(
          "SELECT effect_id,effect_type,receipt_id,command_id,ordinal,payload_json,status,attempts,last_failure_tag,delivery_envelope FROM economy_receipt_outbox ORDER BY command_id,ordinal",
        )
      ).rows;

      await connection.query("COMMIT");

      return { receipts, audit, commands, settlements, outbox };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  };

  const immutable = (facts) => ({
    ...facts,
    outbox: facts.outbox.map(
      ({
        status: _status,
        attempts: _attempts,
        last_failure_tag: _lastFailure,
        delivery_envelope: _envelope,
        ...row
      }) => row,
    ),
  });

  const checkpoint = async (step, binding = {}) => {
    assert.equal(step, reimbursementSteps[observations.length], "checkpoint order");
    const facts = await read();
    const index = reimbursementSteps.indexOf(step);

    if (index === 0) {
      assert.deepEqual(facts, {
        receipts: [],
        audit: [],
        commands: [],
        settlements: [],
        outbox: [],
      });
    } else {
      assert.equal(facts.receipts.length, 1);
      const row = facts.receipts[0];
      receiptId ??= binding.receiptId;
      assert.equal(row.receipt_id, receiptId);
      assert.equal(row.owner_person_id, persons.owner.personId);
      assert.equal(row.department_id, fixture.departmentId);
      assert.equal(row.description, fixture.description);
      assert.equal(row.amount_ore, String(fixture.amountOre));
      assert.equal(row.currency, "NOK");
      assert.equal(row.receipt_date, fixture.receiptDate);
      const approved = index >= reimbursementSteps.indexOf("approval-failed-delivery");
      const settled = index >= reimbursementSteps.indexOf("settled");
      assert.equal(row.status, approved ? "Approved" : "Pending");
      assert.equal(row.revision, settled ? 2 : approved ? 1 : 0);
      assert.equal(facts.commands.length, settled ? 3 : approved ? 2 : 1);
      assert.deepEqual(
        facts.audit.map(({ actor_person_id, action }) => [actor_person_id, action]),
        [
          [persons.owner.personId, "ReceiptSubmitted"],
          ...(approved ? [[persons.approver.personId, "ReceiptApproved"]] : []),
          ...(settled ? [[persons.finance.personId, "ReceiptSettled"]] : []),
        ],
      );
      assert.equal(facts.settlements.length, settled ? 1 : 0);

      if (settled) {
        assert.deepEqual(facts.settlements[0], {
          settlement_id: binding.settlementId ?? prior.settlements[0]?.settlement_id,
          receipt_id: receiptId,
          amount_ore: String(fixture.amountOre),
          currency: "NOK",
          external_authority: fixture.externalAuthority,
          external_reference: fixture.externalReference,
          settled_at: fixture.settledAt,
          recorded_by_person_id: persons.finance.personId,
          receipt_revision: 2,
          payment_destination_fingerprint: sha256("synthetic:private-destination"),
        });
      }

      if (!["submitted", "approval-failed-delivery", "settled"].includes(step))
        assert.deepEqual(
          immutable(facts),
          immutable(prior),
          `${step} cannot change committed business facts`,
        );
      const path = join(committedRoot, row.file_object_key);
      assert.ok(
        !isAbsolute(relative(committedRoot, path)) &&
          !relative(committedRoot, path).startsWith(".."),
      );
      const bytes = await readFile(path);
      assert.deepEqual(bytes, receiptBytes);
      assert.equal(row.file_sha256, sha256(bytes));
      assert.equal(row.file_byte_length, bytes.length);
      assert.equal((await stat(path)).isFile(), true);
    }

    observations.push({
      step,
      facts: {
        ...facts,
        outbox: facts.outbox.map(({ payload_json, delivery_envelope, ...row }) => ({
          ...row,
          payloadSha256: sha256(JSON.stringify(payload_json)),
          envelopeSha256:
            delivery_envelope === null ? null : sha256(JSON.stringify(delivery_envelope)),
        })),
      },
    });
    prior = facts;

    return facts;
  };

  return {
    read,
    checkpoint,
    observations,
    finish: () => {
      assert.deepEqual(
        observations.map(({ step }) => step),
        reimbursementSteps,
      );

      return observations;
    },
  };
};
