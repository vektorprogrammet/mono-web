/**
 * Fixture, seed, and independent PostgreSQL observer of the golden reimbursement journey.
 *
 * Every read runs in one REPEATABLE READ snapshot through a pool that the runner owns, and each
 * checkpoint asserts the committed business facts that its step allows.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { sha256Hex } from "@vektorprogrammet/domain/shared-kernel";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { Pool } from "pg";
import { failure, type HarnessFailure, readOnlySnapshot, selectRows } from "./golden-harness";

export const reimbursementSteps: ReadonlyArray<string> = [
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
} as const;

export type Role = "owner" | "other" | "approver" | "finance" | "wrongScope";

export interface Person {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly password: string;
}

export type Persons = { readonly [role in Role]: Person };

const person = (role: Role, password: string): Person => ({
  personId: `reimbursement-${role}`,
  firstName: "Synthetic",
  lastName: role,
  email: `reimbursement.${role.toLowerCase()}@example.invalid`,
  password,
});

export const people = (password: string): Persons => ({
  owner: person("owner", password),
  other: person("other", password),
  approver: person("approver", password),
  finance: person("finance", password),
  wrongScope: person("wrongScope", password),
});

/** The SHA-256 digest of a text's UTF-8 bytes. */
export const digestText = (text: string): string => sha256Hex(new TextEncoder().encode(text));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The JSON text of a value, byte for byte what `JSON.stringify` writes. */
export const jsonText = <A>(value: A): string => encodeJson(value);

const Row = Schema.Record(Schema.String, Schema.Json);

export type Row = typeof Row.Type;

export interface ReimbursementFacts {
  readonly receipts: ReadonlyArray<Row>;
  readonly audit: ReadonlyArray<Row>;
  readonly commands: ReadonlyArray<Row>;
  readonly settlements: ReadonlyArray<Row>;
  readonly outbox: ReadonlyArray<Row>;
}

export interface Binding {
  readonly receiptId?: string | undefined;
  readonly settlementId?: string | undefined;
}

const query = (pool: Pool, text: string, values: ReadonlyArray<string>) =>
  Effect.tryPromise({ try: () => pool.query(text, [...values]), catch: failure("seed") });

/** Prerequisites only. Every receipt, decision, settlement and delivered notification is runtime work. */
export const seedReimbursement = ({
  pool,
  persons,
}: {
  readonly pool: Pool;
  readonly persons: Persons;
}): Effect.Effect<void, HarnessFailure> =>
  Effect.gen(function* () {
    for (const [department, label] of [
      [fixture.departmentId, "R"],
      [fixture.foreignDepartmentId, "F"],
    ] as const) {
      yield* query(
        pool,
        "INSERT INTO organization_departments(department_id,name,short_name,email,city,active,revision) VALUES($1,$1,$2,$3,'Trondheim',true,0)",
        [department, label, `${label.toLowerCase()}@example.invalid`],
      );
      yield* query(
        pool,
        "INSERT INTO organization_teams(team_id,department_id,name,active,revision) VALUES($1,$2,'Synthetic team',true,0)",
        [`${department}-team`, department],
      );
    }

    for (const [role, member] of Object.entries(persons)) {
      yield* query(
        pool,
        "INSERT INTO person_contact_profiles(person_id,email,phone,revision) VALUES($1,$2,'90000000',0)",
        [member.personId, member.email],
      );

      const department = role === "wrongScope" ? fixture.foreignDepartmentId : fixture.departmentId;

      yield* query(
        pool,
        "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,is_team_leader,is_suspended,revision) VALUES($1,$2,$3,'2020-01-01',false,false,0)",
        [`${member.personId}-membership`, member.personId, `${department}-team`],
      );
    }

    yield* query(
      pool,
      "INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES('reimbursement-payment',$1,$2,'synthetic:private-destination','2020-01-01',0)",
      [persons.owner.personId, fixture.departmentId],
    );

    for (const role of ["approver", "wrongScope"] as const) {
      yield* query(
        pool,
        "INSERT INTO economy_receipt_approval_grants(approval_grant_id,person_id,scope,department_id,start_at,revision) VALUES($1,$2,'Department',$3,'2020-01-01',0)",
        [
          `${role}-approval`,
          persons[role].personId,
          role === "approver" ? fixture.departmentId : fixture.foreignDepartmentId,
        ],
      );
    }

    yield* query(
      pool,
      "INSERT INTO economy_receipt_settlement_grants(settlement_grant_id,person_id,scope,department_id,start_at,revision) VALUES('reimbursement-settlement',$1,'Department',$2,'2020-01-01',0)",
      [persons.finance.personId, fixture.departmentId],
    );
  });

export interface Observation {
  readonly step: string;
  readonly facts: ReimbursementFacts;
}

export interface ReimbursementObserver {
  readonly read: Effect.Effect<ReimbursementFacts, HarnessFailure>;
  readonly checkpoint: (
    step: string,
    binding?: Binding,
  ) => Effect.Effect<ReimbursementFacts, HarnessFailure, FileSystem.FileSystem | Path.Path>;
  readonly observations: ReadonlyArray<Observation>;
  readonly finish: Effect.Effect<ReadonlyArray<Observation>>;
}

const immutable = (facts: ReimbursementFacts) => ({
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

/** The outbox rows of an observation, with their payload and envelope digested. */
export const digestOutbox = (outbox: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  outbox.map(({ payload_json, delivery_envelope, ...row }) => ({
    ...row,
    payloadSha256: digestText(jsonText(payload_json)),
    envelopeSha256:
      delivery_envelope === null || delivery_envelope === undefined
        ? null
        : digestText(jsonText(delivery_envelope)),
  }));

export const createReimbursementObserver = ({
  pool,
  committedRoot,
  persons,
}: {
  readonly pool: Pool;
  readonly committedRoot: string;
  readonly persons: Persons;
}): ReimbursementObserver => {
  const observations: Array<Observation> = [];
  let receiptId: string | undefined;
  let prior: ReimbursementFacts | undefined;

  const read = readOnlySnapshot(pool, (client) =>
    Effect.all({
      receipts: selectRows(
        client,
        "receipts",
        `SELECT receipt_id, visual_id, owner_person_id, department_id, amount_ore::text, currency, description, receipt_date::text, status, revision, file_ref, file_object_key, file_content_type, file_byte_length::int, file_sha256 FROM economy_receipts ORDER BY receipt_id`,
        [],
        Row,
      ),
      audit: selectRows(
        client,
        "audit",
        "SELECT command_id,receipt_id,actor_person_id,action,receipt_revision FROM economy_receipt_audit ORDER BY receipt_revision,command_id",
        [],
        Row,
      ),
      commands: selectRows(
        client,
        "commands",
        "SELECT command_id,receipt_id,command_sha256 FROM economy_receipt_command_receipts ORDER BY command_id",
        [],
        Row,
      ),
      settlements: selectRows(
        client,
        "settlements",
        "SELECT settlement_id,receipt_id,amount_ore::text,currency,external_authority,external_reference,to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS settled_at,recorded_by_person_id,receipt_revision,payment_destination_fingerprint FROM economy_receipt_settlements ORDER BY settlement_id",
        [],
        Row,
      ),
      outbox: selectRows(
        client,
        "outbox",
        "SELECT effect_id,effect_type,receipt_id,command_id,ordinal,payload_json,status,attempts,last_failure_tag,delivery_envelope FROM economy_receipt_outbox ORDER BY command_id,ordinal",
        [],
        Row,
      ),
    }),
  );

  const checkpoint = Effect.fnUntraced(function* (step: string, binding: Binding = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    assert.equal(step, reimbursementSteps[observations.length], "checkpoint order");

    const facts = yield* read;
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

      assert.ok(row !== undefined && prior !== undefined);
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
          payment_destination_fingerprint: digestText("synthetic:private-destination"),
        });
      }

      if (!["submitted", "approval-failed-delivery", "settled"].includes(step))
        assert.deepEqual(
          immutable(facts),
          immutable(prior),
          `${step} cannot change committed business facts`,
        );

      const objectKey = yield* Schema.decodeUnknownEffect(Schema.String)(row.file_object_key).pipe(
        Effect.mapError(failure(step)),
      );

      const file = path.join(committedRoot, objectKey);

      assert.ok(
        !path.isAbsolute(path.relative(committedRoot, file)) &&
          !path.relative(committedRoot, file).startsWith(".."),
      );

      const bytes = Buffer.from(yield* fs.readFile(file).pipe(Effect.mapError(failure(step))));

      assert.deepEqual(bytes, receiptBytes);
      assert.equal(row.file_sha256, sha256Hex(bytes));
      assert.equal(row.file_byte_length, bytes.length);
      assert.equal((yield* fs.stat(file).pipe(Effect.mapError(failure(step)))).type, "File");
    }

    observations.push({ step, facts: { ...facts, outbox: digestOutbox(facts.outbox) } });
    prior = facts;

    return facts;
  });

  return {
    read,
    checkpoint,
    observations,
    finish: Effect.sync(() => {
      assert.deepEqual(
        observations.map(({ step }) => step),
        reimbursementSteps,
      );

      return observations;
    }),
  };
};
