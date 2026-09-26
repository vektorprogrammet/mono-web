import { randomUUID } from "node:crypto";
import { flow, Predicate, Effect, Schema } from "effect";
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Hex,
} from "@vektorprogrammet/domain/shared-kernel";
import { compareRfc3339Instants } from "@vektorprogrammet/domain/time";
import {
  RECEIPT_PAGE_SIZE,
  decodeReceiptCursor,
  type ReceiptPage,
  mapExistingReceiptSettlementActor,
  selectReceiptSettlementGrant,
  type ReceiptSettlementTransactionResult,
} from "@vektorprogrammet/domain/receipt";
import { receiptCursorPage, receiptCursorTimestamp, type CursorPositioned } from "./cursor.js";
import {
  DuplicateExternalSettlementReference,
  DuplicateReceiptCommandConflict,
  InvalidReceiptTransition,
  ReceiptDecodeError,
  ReceiptNotFound,
  ReceiptPersistenceError,
  ReceiptSettlementEvidenceSelectSchema,
  ReceiptSettlementId,
  ReceiptSettlementObservationSchema,
  ReceiptSettlementCommandRequestSchema,
  SettlementAfterRecordedAt,
  StaleReceiptRevision,
  ReceiptAlreadySettled,
  receiptOutboxRequest,
  Receipt,
  ReceiptCommandPrincipalSchema,
  type ReceiptCommandPrincipal,
  type ReceiptId,
  type ReceiptSettlementActor,
  type ReceiptSettlementCommandRequest,
  type ReceiptSettlementEvidence,
  type ReceiptSettlementListFailure,
  type ReceiptSettlementReadFailure,
  type ReceiptSettlementQueueItem,
  type ReceiptSettlementFailure,
} from "@vektorprogrammet/domain/receipt";
import {
  DepartmentId,
  PersonId,
  type OrganizationAuthorityInstant,
} from "@vektorprogrammet/domain/organization";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityForRead,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import {
  resolveReceiptAuthorityForRead,
  resolveReceiptAuthorityWithSql,
} from "./authority-postgres.js";

interface SettlementAuthorization {
  readonly principal: ReceiptCommandPrincipal;
  readonly actor: ReceiptSettlementActor;
  readonly current: Receipt;
}

interface CommandReceiptRow {
  readonly command_sha256: string;
  readonly observation_json: unknown;
}

interface FinanceSettlementRow {
  readonly departmentId: DepartmentId;
  readonly settlement: unknown;
}

const persistenceError = (operation: string, cause: unknown) =>
  new ReceiptPersistenceError({ operation, message: String(cause), cause });

const receiptFromRow = (
  row: typeof Receipt.Encoded,
): Effect.Effect<Receipt, ReceiptPersistenceError> =>
  Schema.decodeUnknownEffect(Receipt)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => persistenceError("decode Receipt settlement receipt", cause)),
  );

const findReceiptForSettlement = (
  sql: DatabaseOperations,
  receiptId: string,
): Effect.Effect<Receipt | undefined, ReceiptPersistenceError> =>
  sql<typeof Receipt.Encoded>`
    SELECT
      receipt_id AS "receiptId",
      visual_id AS "visualId",
      owner_person_id AS "ownerPersonId",
      department_id AS "departmentId",
      amount_ore::text AS "amountOre",
      currency,
      description,
      to_char(receipt_date, 'YYYY-MM-DD') AS "receiptDate",
      to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
      status,
      CASE WHEN approved_at IS NULL THEN NULL ELSE to_char(
        approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) END AS "approvedAt",
      payment_account_ciphertext AS "paymentAccountCiphertext",
      json_build_object(
        'fileRef', file_ref,
        'objectKey', file_object_key,
        'contentType', file_content_type,
        'byteLength', file_byte_length::text,
        'sha256', file_sha256
      ) AS file,
      revision
    FROM economy_receipts
    WHERE receipt_id = ${receiptId}
    FOR UPDATE
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : receiptFromRow(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read Receipt for settlement", cause)),
    ),
  );

const decodeSettlementEvidence = flow(
  Schema.decodeUnknownEffect(ReceiptSettlementEvidenceSelectSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => persistenceError("decode Receipt settlement evidence", cause)),
);

const findSettlementByReceipt = (
  sql: DatabaseOperations,
  receiptId: string,
): Effect.Effect<ReceiptSettlementEvidence | undefined, ReceiptPersistenceError> =>
  sql`
    SELECT
      settlement_id AS "settlementId",
      receipt_id AS "receiptId",
      amount_ore::text AS "amountOre",
      currency,
      payment_destination_fingerprint AS "paymentDestinationFingerprint",
      external_authority AS "externalAuthority",
      external_reference AS "externalReference",
      to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
      recorded_by_person_id AS "recordedByPersonId",
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
      receipt_revision AS "receiptRevision"
    FROM public.economy_receipt_settlements
    WHERE receipt_id = ${receiptId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeSettlementEvidence(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read Receipt settlement", cause)),
    ),
  );

const findSettlementById = (
  sql: DatabaseOperations,
  settlementId: string,
): Effect.Effect<ReceiptSettlementEvidence | undefined, ReceiptPersistenceError> =>
  sql`
    SELECT
      settlement_id AS "settlementId",
      receipt_id AS "receiptId",
      amount_ore::text AS "amountOre",
      currency,
      payment_destination_fingerprint AS "paymentDestinationFingerprint",
      external_authority AS "externalAuthority",
      external_reference AS "externalReference",
      to_char(settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
      recorded_by_person_id AS "recordedByPersonId",
      to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
      receipt_revision AS "receiptRevision"
    FROM public.economy_receipt_settlements
    WHERE settlement_id = ${settlementId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeSettlementEvidence(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read Receipt settlement replay", cause)),
    ),
  );

const findCommandReceipt = (
  sql: DatabaseOperations,
  commandId: string,
): Effect.Effect<CommandReceiptRow | undefined, ReceiptPersistenceError> =>
  sql<CommandReceiptRow>`
    SELECT command_sha256, observation_json
    FROM economy_receipt_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(
    Effect.map((rows) => rows[0]),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read Receipt settlement command receipt", cause)),
    ),
  );

const decodePrincipal = (input: ReceiptCommandPrincipal) =>
  Schema.decodeUnknownEffect(ReceiptCommandPrincipalSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })));

const decodeCommand = flow(
  Schema.decodeUnknownEffect(ReceiptSettlementCommandRequestSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => new ReceiptDecodeError({ message: String(cause) })),
);

const resolveSettlementAuthorizationWithSql = (
  sql: DatabaseOperations,
  receiptId: ReceiptId,
  principal: ReceiptCommandPrincipal,
): Effect.Effect<SettlementAuthorization, ReceiptSettlementFailure> =>
  Effect.gen(function* () {
    const current = yield* findReceiptForSettlement(sql, receiptId);

    if (current === undefined) return yield* Effect.fail(new ReceiptNotFound({ receiptId }));
    yield* lockPersonAuthorization(sql, principal.personId).pipe(
      Effect.mapError((cause) => persistenceError(cause.operation, cause.message)),
    );

    const organization = yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      principal.personId,
      principal.authorizationInstant,
      "ForShare",
    ).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "OrganizationDecodeError")
          ? new ReceiptDecodeError({ message: `${cause.operation}: ${cause.message}` })
          : persistenceError(cause.operation, cause.message),
      ),
    );

    const authority = yield* resolveReceiptAuthorityWithSql(
      sql,
      principal.personId,
      principal.authorizationInstant,
      organization,
      "ForShare",
    ).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, "ReceiptPersistenceError")
          ? cause
          : Predicate.isTagged(cause, "ReceiptDecodeError")
            ? cause
            : new ReceiptDecodeError({
                message: `Receipt authority projection mismatch for ${cause.personId}`,
              }),
      ),
    );

    const actor = yield* mapExistingReceiptSettlementActor(
      authority,
      current.receiptId,
      current.departmentId,
    );

    return { principal, actor, current };
  });

export const readReceiptSettlementRevision = (
  receiptId: ReceiptId,
  principalInput: ReceiptCommandPrincipal,
): Effect.Effect<Receipt["revision"], ReceiptSettlementFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const principal = yield* decodePrincipal(principalInput);
    const authorization = yield* resolveSettlementAuthorizationWithSql(sql, receiptId, principal);

    return authorization.current.revision;
  });

const executeAuthorizedReceiptSettlementWithSql = (
  sql: DatabaseOperations,
  command: ReceiptSettlementCommandRequest,
  authorization: SettlementAuthorization,
): Effect.Effect<ReceiptSettlementTransactionResult, ReceiptSettlementFailure> =>
  Effect.gen(function* () {
    const commandEnvelope = {
      schema: "ReceiptSettlementCommandRequest/v1" as const,
      principalPersonId: authorization.principal.personId,
      request: command,
    };

    const commandJson = canonicalJson(commandEnvelope);
    const commandDigest = sha256Hex(canonicalJsonBytes(commandEnvelope));
    yield* lockAdvisory(sql, AdvisoryLockKey.receiptCommand(command.commandId)).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock Receipt settlement command", cause)),
      ),
    );
    const stored = yield* findCommandReceipt(sql, command.commandId);

    if (stored !== undefined) {
      if (stored.command_sha256 !== commandDigest) {
        return yield* Effect.fail(
          new DuplicateReceiptCommandConflict({ commandId: command.commandId }),
        );
      }

      const observation = yield* Schema.decodeUnknownEffect(ReceiptSettlementObservationSchema)(
        stored.observation_json,
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError((cause) =>
          persistenceError("decode stored Receipt settlement observation", cause),
        ),
      );

      const settlement = yield* findSettlementById(sql, observation.settlementId);

      if (settlement === undefined) {
        return yield* Effect.fail(
          persistenceError("read Receipt settlement replay", "recorded settlement was not found"),
        );
      }

      return {
        observation: { ...observation, replayed: true },
        receipt: authorization.current,
        settlement,
        replayed: true,
        outboxCount: 0,
      };
    }

    const current = authorization.current;
    const existingSettlement = yield* findSettlementByReceipt(sql, current.receiptId);

    if (existingSettlement !== undefined) {
      return yield* Effect.fail(new ReceiptAlreadySettled({ receiptId: current.receiptId }));
    }

    if (current.revision !== command.expectedRevision) {
      return yield* Effect.fail(
        new StaleReceiptRevision({
          receiptId: current.receiptId,
          expected: command.expectedRevision,
          actual: current.revision,
        }),
      );
    }

    if (current.status !== "Approved") {
      return yield* Effect.fail(
        new InvalidReceiptTransition({
          receiptId: current.receiptId,
          status: current.status,
          command: command._tag,
        }),
      );
    }

    const recordedAt = authorization.principal.authorizationInstant;

    if (compareRfc3339Instants(command.settledAt, recordedAt) > 0) {
      return yield* Effect.fail(
        new SettlementAfterRecordedAt({ settledAt: command.settledAt, recordedAt }),
      );
    }

    yield* lockAdvisory(
      sql,
      AdvisoryLockKey.receiptSettlementReference(
        command.externalAuthority,
        command.externalReference,
      ),
    ).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("lock Receipt settlement external reference", cause)),
      ),
    );

    const duplicateExternal = yield* sql<{ readonly settlementId: string }>`
      SELECT settlement_id AS "settlementId"
      FROM public.economy_receipt_settlements
      WHERE external_authority = ${command.externalAuthority}
        AND external_reference = ${command.externalReference}
      LIMIT 1
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("read Receipt settlement external reference", cause)),
      ),
    );

    if (duplicateExternal[0] !== undefined) {
      return yield* Effect.fail(
        new DuplicateExternalSettlementReference({
          externalAuthority: command.externalAuthority,
          externalReference: command.externalReference,
        }),
      );
    }

    const updated = yield* sql<{ readonly revision: number }>`
      UPDATE economy_receipts
      SET revision = revision + 1
      WHERE receipt_id = ${current.receiptId}
        AND revision = ${current.revision}
      RETURNING revision
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("advance Receipt settlement revision", cause)),
      ),
    );

    const revision = updated[0]?.revision;

    if (revision === undefined) {
      return yield* Effect.fail(
        new StaleReceiptRevision({
          receiptId: current.receiptId,
          expected: current.revision,
          actual: current.revision,
        }),
      );
    }

    const settlement: ReceiptSettlementEvidence = {
      settlementId: ReceiptSettlementId.make(randomUUID()),
      receiptId: current.receiptId,
      amountOre: current.amountOre,
      currency: current.currency,
      paymentDestinationFingerprint: sha256Hex(
        new TextEncoder().encode(current.paymentAccountCiphertext),
      ),
      externalAuthority: command.externalAuthority,
      externalReference: command.externalReference,
      settledAt: command.settledAt,
      recordedByPersonId: authorization.actor.personId,
      recordedAt,
      receiptRevision: revision,
    };

    yield* sql`
      INSERT INTO public.economy_receipt_settlements (
        settlement_id,
        receipt_id,
        amount_ore,
        currency,
        payment_destination_fingerprint,
        external_authority,
        external_reference,
        settled_at,
        recorded_by_person_id,
        recorded_at,
        receipt_revision
      ) VALUES (
        ${settlement.settlementId},
        ${settlement.receiptId},
        ${settlement.amountOre},
        ${settlement.currency},
        ${settlement.paymentDestinationFingerprint},
        ${settlement.externalAuthority},
        ${settlement.externalReference},
        ${settlement.settledAt},
        ${settlement.recordedByPersonId},
        ${settlement.recordedAt},
        ${settlement.receiptRevision}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert Receipt settlement", cause)),
      ),
    );

    const observation = {
      commandId: command.commandId,
      receiptId: settlement.receiptId,
      settlementId: settlement.settlementId,
      revision,
      replayed: false,
    };

    yield* sql`
      INSERT INTO economy_receipt_command_receipts (
        command_id, command_sha256, command_json, observation_json,
        receipt_id, committed_at
      ) VALUES (
        ${command.commandId}, ${commandDigest}, ${sql.json(JSON.parse(commandJson))},
        ${sql.json(observation)}, ${settlement.receiptId}, ${recordedAt}
      )
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert Receipt settlement command receipt", cause)),
      ),
    );

    const notification = receiptOutboxRequest(
      command.commandId,
      settlement.receiptId,
      "NotifyReceiptSettled",
    );

    yield* sql`
      INSERT INTO economy_receipt_outbox (
        effect_id, effect_type, receipt_id, command_id, ordinal, payload_json
      ) VALUES (
        ${notification.effectId}, ${notification._tag}, ${notification.receiptId},
        ${notification.commandId}, 0, ${sql.json(notification)}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert Receipt settlement notification", cause)),
      ),
    );
    yield* sql`
      INSERT INTO economy_receipt_audit (
        command_id, receipt_id, actor_person_id, action, receipt_revision, occurred_at
      ) VALUES (
        ${command.commandId}, ${settlement.receiptId}, ${authorization.actor.personId},
        'ReceiptSettled', ${revision}, ${recordedAt}
      )
    `.pipe(
      Effect.asVoid,
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("insert Receipt settlement audit", cause)),
      ),
    );

    return {
      observation,
      receipt: { ...current, revision },
      settlement,
      replayed: false,
      outboxCount: 1,
    };
  });

export const recordReceiptSettlement = (
  input: typeof ReceiptSettlementCommandRequestSchema.Encoded,
  principalInput: ReceiptCommandPrincipal,
): Effect.Effect<ReceiptSettlementTransactionResult, ReceiptSettlementFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const command = yield* decodeCommand(input);
          const principal = yield* decodePrincipal(principalInput);

          const authorization = yield* resolveSettlementAuthorizationWithSql(
            sql,
            command.receiptId,
            principal,
          );

          return yield* executeAuthorizedReceiptSettlementWithSql(sql, command, authorization);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("Receipt settlement transaction", cause)),
        ),
      );
  });

export const listReceiptsForSettlement = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  after?: string,
): Effect.Effect<ReceiptPage<ReceiptSettlementQueueItem>, ReceiptSettlementListFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );

          const organization = yield* resolveOrganizationPersonAuthorityForRead(
            personId,
            authorizationInstant,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "OrganizationPersistenceError")
                ? persistenceError(
                    "resolve Receipt settlement queue Organization authority",
                    cause.message,
                  )
                : new ReceiptDecodeError({ message: `${cause.operation}: ${cause.message}` }),
            ),
          );

          const authority = yield* resolveReceiptAuthorityForRead(
            personId,
            authorizationInstant,
            organization,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "ReceiptPersistenceError")
                ? cause
                : Predicate.isTagged(cause, "ReceiptDecodeError")
                  ? cause
                  : new ReceiptDecodeError({
                      message: `Receipt authority projection mismatch for ${cause.personId}`,
                    }),
            ),
          );

          let position = after === undefined ? undefined : yield* decodeReceiptCursor(after);
          const visible: Array<CursorPositioned<ReceiptSettlementQueueItem>> = [];

          while (visible.length <= RECEIPT_PAGE_SIZE) {
            const rows = yield* sql<CursorPositioned<ReceiptSettlementQueueItem>>`
            SELECT
              ${receiptCursorTimestamp(sql, sql`receipt.approved_at`)},
              receipt.receipt_id AS "receiptId",
              receipt.visual_id AS "visualId",
              receipt.owner_person_id AS "ownerPersonId",
              receipt.department_id AS "departmentId",
              receipt.description,
              receipt.amount_ore::text AS "amountOre",
              receipt.currency,
              receipt.status,
              receipt.receipt_date::text AS "receiptDate",
              to_char(receipt.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "approvedAt",
              receipt.revision
            FROM economy_receipts AS receipt
            LEFT JOIN public.economy_receipt_settlements AS settlement
              ON settlement.receipt_id = receipt.receipt_id
            WHERE receipt.status = 'Approved'
              AND settlement.receipt_id IS NULL
              AND (${position?.timestamp ?? null}::timestamptz IS NULL OR
                (receipt.approved_at, receipt.receipt_id) > (${position?.timestamp ?? null}::timestamptz, ${position?.receiptId ?? null}))
            ORDER BY receipt.approved_at ASC, receipt.receipt_id ASC
            LIMIT ${RECEIPT_PAGE_SIZE + 1}
          `.pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(persistenceError("list Receipt settlement queue", cause)),
              ),
            );

            for (const row of rows) {
              if (selectReceiptSettlementGrant(authority, row.departmentId)?.active === true)
                visible.push(row);

              if (visible.length > RECEIPT_PAGE_SIZE) break;
            }

            if (rows.length <= RECEIPT_PAGE_SIZE) break;
            const last = rows[rows.length - 1]!;
            position = { timestamp: last.cursorTimestamp, receiptId: last.receiptId };
          }

          return receiptCursorPage(visible);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("list Receipt settlement queue snapshot", cause)),
        ),
      );
  });

export const readReceiptSettlementForFinance = (
  receiptId: string,
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
): Effect.Effect<ReceiptSettlementEvidence, ReceiptSettlementReadFailure, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.pipe(
            Effect.asVoid,
          );

          const rows = yield* sql<FinanceSettlementRow>`
            SELECT
              receipt.department_id AS "departmentId",
              json_build_object(
                'settlementId', settlement.settlement_id,
                'receiptId', settlement.receipt_id,
                'amountOre', settlement.amount_ore::text,
                'currency', settlement.currency,
                'paymentDestinationFingerprint', settlement.payment_destination_fingerprint,
                'externalAuthority', settlement.external_authority,
                'externalReference', settlement.external_reference,
                'settledAt', to_char(settlement.settled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'recordedByPersonId', settlement.recorded_by_person_id,
                'recordedAt', to_char(settlement.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'receiptRevision', settlement.receipt_revision
              ) AS settlement
            FROM economy_receipts AS receipt
            JOIN public.economy_receipt_settlements AS settlement
              ON settlement.receipt_id = receipt.receipt_id
            WHERE receipt.receipt_id = ${receiptId}
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("read Receipt finance settlement", cause)),
            ),
          );

          const row = rows[0];

          if (row === undefined) return yield* Effect.fail(new ReceiptNotFound({ receiptId }));
          const settlement = yield* decodeSettlementEvidence(row.settlement);

          const organization = yield* resolveOrganizationPersonAuthorityForRead(
            personId,
            authorizationInstant,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "OrganizationPersistenceError")
                ? persistenceError(
                    "resolve Receipt finance settlement Organization authority",
                    cause.message,
                  )
                : new ReceiptDecodeError({ message: `${cause.operation}: ${cause.message}` }),
            ),
          );

          const authority = yield* resolveReceiptAuthorityForRead(
            personId,
            authorizationInstant,
            organization,
          ).pipe(
            Effect.mapError((cause) =>
              Predicate.isTagged(cause, "ReceiptPersistenceError")
                ? cause
                : Predicate.isTagged(cause, "ReceiptDecodeError")
                  ? cause
                  : new ReceiptDecodeError({
                      message: `Receipt authority projection mismatch for ${cause.personId}`,
                    }),
            ),
          );

          yield* mapExistingReceiptSettlementActor(authority, receiptId, row.departmentId);

          return settlement;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("read Receipt finance settlement snapshot", cause)),
        ),
      );
  });
