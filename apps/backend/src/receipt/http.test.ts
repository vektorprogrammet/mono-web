import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import {
  AmbiguousParameterFill,
  Economy,
  InactiveActor,
  ReceiptFileService,
  FailedComposedRequirement,
  ReceiptObservationSchema,
  ReceiptNotFound,
  ReceiptScopeDenied,
  UnauthenticatedActor,
  type EconomyShape,
  type ReceiptCommandPrincipal,
  type ReceiptStatus,
  type ReceiptSubmissionAllocation,
  type ReceiptTransactionResult,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ReceiptApiConfig } from "./config.js";
import type { ReceiptFileStore } from "./filesystem.js";
import type { ReceiptApiHttpOptions } from "./http.js";
import { makeReceiptTestHttp as makeReceiptApiHttp } from "../test/native-http.js";
import { runTestPromise } from "../../test/runtime.js";

type ReceiptApiHttp = { readonly fetch: (request: Request) => Promise<Response> };
const personId = PersonId.make("person-receipt-http");
const departmentOne = DepartmentId.make("department-one");
const departmentTwo = DepartmentId.make("department-two");
const evaluatedAt = "2026-08-24T12:00:00.000Z";

const config: ReceiptApiConfig = {
  stagingRoot: "/tmp/receipt-http-test-staging",
  committedRoot: "/tmp/receipt-http-test-committed",
  maxFileBytes: 1024,
  tokens: new Map(),
  now: () => evaluatedAt,
  nextReceiptId: () => "receipt-one",
  nextVisualId: () => "visual-one",
};

const receiptObservation = Schema.decodeUnknownSync(ReceiptObservationSchema)({
  commandId: "command-one",
  receiptId: "receipt-one",
  visualId: "visual-one",
  status: "Pending",
  revision: 0,
  replayed: false,
});

const fileService = {
  stage: () => Effect.void,
  apply: () => Effect.void,
};

const fileStore: ReceiptFileStore = {
  service: fileService,
  layer: Layer.succeed(ReceiptFileService, fileService),
  stageBytes: async () => ({
    file: {
      fileRef: "staging/file-one",
      objectKey: "committed/file-one",
      contentType: "image/png",
      byteLength: 4,
      sha256: "aa".repeat(32),
    },
    created: true,
  }),
  cleanupStage: async () => undefined,
};

interface HarnessOptions {
  readonly unauthenticated?: boolean;
  readonly ownedRows?: ReadonlyArray<unknown>;
  readonly approvalRows?: ReadonlyArray<unknown>;
  readonly approvalFailure?:
    | InactiveActor
    | ReceiptScopeDenied
    | AmbiguousParameterFill
    | FailedComposedRequirement;
  readonly commandFailure?:
    | ReceiptScopeDenied
    | ReceiptNotFound
    | AmbiguousParameterFill
    | FailedComposedRequirement;
}

const harness = (options: HarnessOptions = {}) => {
  const commands: Array<unknown> = [];
  const principals: Array<ReceiptCommandPrincipal> = [];
  const allocations: Array<ReceiptSubmissionAllocation | undefined> = [];
  const approvalQueries: Array<{
    readonly personId: typeof personId;
    readonly authorizationInstant: string;
    readonly status: ReceiptStatus | undefined;
  }> = [];
  let authorizationPrincipalCalls = 0;
  let personCalls = 0;
  const executeReceipt: EconomyShape["executeReceipt"] = (command, principal, allocation) => {
    commands.push(command);
    principals.push(principal);
    allocations.push(allocation);
    return options.commandFailure === undefined
      ? Effect.succeed({
          observation: receiptObservation,
          replayed: false,
          outboxCount: 0,
        } satisfies ReceiptTransactionResult)
      : Effect.fail(options.commandFailure);
  };
  const economy: EconomyShape = {
    executeReceipt,
    listOwnedReceipts: () => Effect.succeed((options.ownedRows as never) ?? []),
    listReceiptsForApproval: (queryPersonId, authorizationInstant, status) => {
      approvalQueries.push({ personId: queryPersonId, authorizationInstant, status });
      return options.approvalFailure === undefined
        ? Effect.succeed((options.approvalRows as never) ?? [])
        : Effect.fail(options.approvalFailure);
    },
    readReceiptLifecycleEvidence: () => Effect.die("unexpected evidence read"),
    receiptStatusTotals: Effect.succeed([]),
    listStaleOutboxClaims: () => Effect.succeed([]),
    recoverStaleOutboxClaim: () => Effect.succeed(0),
    deliverNextOutboxEffect: () => Effect.succeed({ _tag: "Idle" }),
  };
  const database = { health: Effect.void } as unknown as DatabaseShape;
  const run = (<A, E>(effect: Effect.Effect<A, E, Database | Economy>): Promise<A> =>
    runTestPromise(
      effect.pipe(
        Effect.provideService(Database, database),
        Effect.provideService(Economy, economy),
      ) as Effect.Effect<A, E>,
    )) as ReceiptApiHttpOptions["run"];
  const http = makeReceiptApiHttp({
    config,
    identity: {
      resolveAuthorizationPrincipal: async () => {
        authorizationPrincipalCalls += 1;
        if (options.unauthenticated === true) {
          throw new UnauthenticatedActor({ message: "no session" });
        }
        return { personId, authorizationInstant: evaluatedAt };
      },
      resolvePersonId: async () => {
        personCalls += 1;
        if (options.unauthenticated === true) {
          throw new UnauthenticatedActor({ message: "no session" });
        }
        return personId;
      },
    },
    run,
    fileStore,
  });
  return {
    http,
    commands,
    principals,
    allocations,
    approvalQueries,
    counts: () => ({ authorizationPrincipalCalls, personCalls }),
  };
};

const request = (http: ReceiptApiHttp, pathname: string, init?: RequestInit): Promise<Response> =>
  http.fetch(new Request(`http://backend.test${pathname}`, init));

const multipartRequest = (http: ReceiptApiHttp, pathname: string): Promise<Response> => {
  const boundary = "receipt-http-test-boundary";
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="commandId"\r\n\r\ncommand-one\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nbus ticket\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="amountOre"\r\n\r\n1200\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="receiptDate"\r\n\r\n2026-08-01\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\ntest\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  return request(http, pathname, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
};

describe("receipt HTTP identity and authority resolution (spec 0055/0056)", () => {
  it("uses only the session person for the owner list", async () => {
    const state = harness();
    const response = await request(state.http, "/api/receipts");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { items: [], totalItems: 0 },
    });
    expect(state.counts()).toEqual({
      authorizationPrincipalCalls: 0,
      personCalls: 1,
    });
  });

  it("normalizes a missing session to typed 401", async () => {
    const state = harness({ unauthenticated: true });
    const response = await request(state.http, "/api/receipts");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
  });

  it("hands an actorless submit request and server principal to Economy", async () => {
    const state = harness();
    const response = await multipartRequest(state.http, "/api/receipts/submit");
    expect(response.status).toBe(201);
    expect(state.commands[0]).toMatchObject({
      _tag: "SubmitReceipt",
      commandId: "command-one",
      description: "bus ticket",
      amountOre: 1200,
    });
    expect(state.commands[0]).not.toHaveProperty("actor");
    expect(state.commands[0]).not.toHaveProperty("paymentAccountCiphertext");
    expect(state.commands[0]).not.toHaveProperty("departmentId");
    expect(state.principals).toEqual([{ personId, authorizationInstant: evaluatedAt }]);
    expect(state.allocations).toEqual([{ receiptId: "receipt-one", visualId: "visual-one" }]);
    expect(state.counts()).toEqual({
      authorizationPrincipalCalls: 1,
      personCalls: 0,
    });
  });

  it("preserves only an explicitly selected submit department", async () => {
    const omitted = harness();
    expect((await multipartRequest(omitted.http, "/api/receipts/submit")).status).toBe(201);
    expect(omitted.commands[0]).not.toHaveProperty("departmentId");

    const selected = harness();
    const accepted = await multipartRequest(
      selected.http,
      "/api/receipts/submit?departmentId=department-two",
    );
    expect(accepted.status).toBe(201);
    expect(selected.commands[0]).toMatchObject({ departmentId: departmentTwo });
    expect(selected.commands[0]).not.toHaveProperty("actor");
    expect(selected.commands[0]).not.toHaveProperty("paymentAccountCiphertext");
  });

  it("does not use approval projections for protected approval commands", async () => {
    const state = harness();
    const response = await request(state.http, "/api/admin/receipts/receipt-one/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "command-one", expectedRevision: 0 }),
    });
    expect(response.status).toBe(200);
    expect(state.commands[0]).toEqual({
      _tag: "RejectReceipt",
      commandId: "command-one",
      receiptId: "receipt-one",
      expectedRevision: 0,
    });
    expect(state.approvalQueries).toEqual([]);
    expect(state.counts()).toEqual({
      authorizationPrincipalCalls: 1,
      personCalls: 0,
    });
  });

  it("maps an existing foreign-scope approval denial to stable 403", async () => {
    const state = harness({
      commandFailure: new ReceiptScopeDenied({
        receiptId: "receipt-foreign",
        departmentId: departmentTwo,
      }),
    });
    const response = await request(state.http, "/api/admin/receipts/receipt-foreign/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "command-foreign", expectedRevision: 0 }),
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 403,
      body: { error: { tag: "ReceiptScopeDenied" } },
    });
    expect(state.commands).toHaveLength(1);
    expect(state.approvalQueries).toEqual([]);
  });

  it("maps a transaction-local globally visible missing target to stable 404", async () => {
    const state = harness({
      commandFailure: new ReceiptNotFound({ receiptId: "receipt-absent-global" }),
    });
    const response = await request(state.http, "/api/admin/receipts/receipt-absent-global/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "command-absent-global", expectedRevision: 0 }),
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 404,
      body: { error: { tag: "ReceiptNotFound" } },
    });
    expect(state.commands).toHaveLength(1);
    expect(state.approvalQueries).toEqual([]);
  });

  it("passes only canonical identity, one instant, and the filter to the approval query", async () => {
    const state = harness({
      approvalRows: [
        {
          receiptId: "receipt-list",
          visualId: "LIST-1",
          ownerPersonId: "owner-list",
          departmentId: departmentOne,
          amountOre: "1250",
          currency: "NOK",
          description: "list row",
          receiptDate: "2026-08-24",
          status: "Pending",
          revision: 2,
        },
      ],
    });
    const response = await request(state.http, "/api/admin/receipts?status=Pending");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        items: [
          {
            receiptId: "receipt-list",
            visualId: "LIST-1",
            ownerPersonId: "owner-list",
            departmentId: departmentOne,
            amountOre: 1250,
            currency: "NOK",
            description: "list row",
            receiptDate: "2026-08-24",
            status: "Pending",
            revision: 2,
          },
        ],
        totalItems: 1,
      },
    });
    expect(state.approvalQueries).toEqual([
      { personId, authorizationInstant: evaluatedAt, status: "Pending" },
    ]);
    expect(state.counts()).toEqual({
      authorizationPrincipalCalls: 1,
      personCalls: 0,
    });
  });

  it("preserves composed denial tags and messages for command and list boundaries", async () => {
    const denials = [
      {
        failure: new AmbiguousParameterFill({ personId, capabilityId: "submitReceipt" }),
        tag: "AmbiguousParameterFill",
        message: "Authorization parameter fill is ambiguous",
      },
      {
        failure: new FailedComposedRequirement({ personId, capabilityId: "approveReceipt" }),
        tag: "FailedComposedRequirement",
        message: "Composed authorization requirement failed",
      },
    ] as const;

    for (const denial of denials) {
      const command = harness({ commandFailure: denial.failure });
      const commandResponse = await request(
        command.http,
        "/api/admin/receipts/receipt-one/reject",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: "command-one", expectedRevision: 0 }),
        },
      );
      expect({ status: commandResponse.status, body: await commandResponse.json() }).toEqual({
        status: 403,
        body: { error: { tag: denial.tag, message: denial.message } },
      });

      const list = harness({ approvalFailure: denial.failure });
      const listResponse = await request(list.http, "/api/admin/receipts");
      expect({ status: listResponse.status, body: await listResponse.json() }).toEqual({
        status: 403,
        body: { error: { tag: denial.tag, message: denial.message } },
      });
    }
  });

  it("preserves stable approval-list session and domain denial responses", async () => {
    const unauthenticated = harness({ unauthenticated: true });
    const unauthenticatedResponse = await request(unauthenticated.http, "/api/admin/receipts");
    expect({
      status: unauthenticatedResponse.status,
      body: await unauthenticatedResponse.json(),
    }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
    expect(unauthenticated.approvalQueries).toEqual([]);

    const inactive = harness({
      approvalFailure: new InactiveActor({ personId }),
    });
    const inactiveResponse = await request(inactive.http, "/api/admin/receipts");
    expect({ status: inactiveResponse.status, body: await inactiveResponse.json() }).toEqual({
      status: 403,
      body: { error: { tag: "InactiveActor" } },
    });

    const unscoped = harness({
      approvalFailure: new ReceiptScopeDenied({
        receiptId: "approval-projection",
        departmentId: "",
      }),
    });
    const scopeResponse = await request(unscoped.http, "/api/admin/receipts");
    expect({ status: scopeResponse.status, body: await scopeResponse.json() }).toEqual({
      status: 403,
      body: { error: { tag: "ReceiptScopeDenied" } },
    });
  });
});
