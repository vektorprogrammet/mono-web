import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import {
  DepartmentId,
  MembershipId,
  PersonId,
  TeamId,
} from "@vektorprogrammet/domain/organization";
import {
  Economy,
  type EconomyShape,
  ReceiptApprovalGrantId,
  ReceiptFileService,
  ReceiptObservationSchema,
  ReceiptPaymentAuthorityId,
  UnauthenticatedActor,
  projectReceiptAuthority,
  type ReceiptActor,
  type ReceiptApprovalGrant,
  type ReceiptAuthority,
  type ReceiptPaymentAuthority,
  type ReceiptTransactionResult,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ReceiptApiConfig } from "./config.js";
import type { ReceiptFileStore } from "./filesystem.js";
import { makeReceiptApiHttp, type ReceiptApiHttp, type ReceiptApiHttpOptions } from "./http.js";
import { runTestPromise } from "../../test/runtime.js";

const personId = PersonId.make("person-receipt-http");
const departmentOne = DepartmentId.make("department-one");
const departmentTwo = DepartmentId.make("department-two");
const evaluatedAt = "2026-08-24T12:00:00.000Z";

const organizationProjection = (departments: ReadonlyArray<DepartmentId>) => ({
  personId,
  evaluatedAt,
  globalAdministrator: "Absent" as const,
  memberships: departments.map((departmentId, index) => ({
    membershipId: MembershipId.make(`membership-${index}`),
    teamId: TeamId.make(`team-${index}`),
    departmentId,
    active: true,
    teamLeader: false,
  })),
});

const payment = (id: string, departmentId: DepartmentId): ReceiptPaymentAuthority => ({
  paymentAuthorityId: ReceiptPaymentAuthorityId.make(id),
  personId,
  departmentId,
  paymentAccountCiphertext: `ciphertext:${departmentId}`,
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: null,
  revision: 0,
});

const grant = (scope: ReceiptApprovalGrant["scope"]): ReceiptApprovalGrant => ({
  approvalGrantId: ReceiptApprovalGrantId.make(`grant-${scope._tag}`),
  personId,
  scope,
  startAt: "2026-08-01T00:00:00.000Z",
  endAt: null,
  revision: 0,
});

const authority = (
  departments: ReadonlyArray<DepartmentId> = [departmentOne],
  payments: ReadonlyArray<ReceiptPaymentAuthority> = [payment("payment-one", departmentOne)],
  grants: ReadonlyArray<ReceiptApprovalGrant> = [],
): ReceiptAuthority =>
  projectReceiptAuthority(organizationProjection(departments), payments, grants);

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
  readonly authority?: ReceiptAuthority;
  readonly unauthenticated?: boolean;
  readonly ownedRows?: ReadonlyArray<unknown>;
  readonly approvalRows?: ReadonlyArray<unknown>;
}

const harness = (options: HarnessOptions = {}) => {
  const commands: Array<unknown> = [];
  const approvalScopes: Array<unknown> = [];
  let authorityCalls = 0;
  let personCalls = 0;
  const executeReceipt: EconomyShape["executeReceipt"] = (command) => {
    commands.push(command);
    return Effect.succeed({
      observation: receiptObservation,
      replayed: false,
      outboxCount: 0,
    } satisfies ReceiptTransactionResult);
  };
  const economy: EconomyShape = {
    resolveReceiptAuthority: () => Effect.die("unexpected authority service call"),
    executeReceipt,
    listOwnedReceipts: () => Effect.succeed((options.ownedRows as never) ?? []),
    listReceiptsForApproval: (scope) => {
      approvalScopes.push(scope);
      return Effect.succeed((options.approvalRows as never) ?? []);
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
  const resolvedAuthority = options.authority ?? authority();
  const http = makeReceiptApiHttp({
    config,
    authority: {
      resolveAuthority: async () => {
        authorityCalls += 1;
        if (options.unauthenticated === true) {
          throw new UnauthenticatedActor({ message: "no session" });
        }
        return resolvedAuthority;
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
  return { http, commands, approvalScopes, counts: () => ({ authorityCalls, personCalls }) };
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

const approvalRow = (departmentId: DepartmentId) => ({
  receiptId: "receipt-one",
  visualId: "visual-one",
  ownerPersonId: "another-person",
  departmentId,
  amountOre: "1200",
  currency: "NOK",
  description: "bus ticket",
  receiptDate: "2026-08-01",
  status: "Pending",
  revision: 0,
});

describe("receipt HTTP authority resolution (spec 0055)", () => {
  it("uses only the session person for the owner list", async () => {
    const state = harness();
    const response = await request(state.http, "/api/receipts");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: { items: [], totalItems: 0 },
    });
    expect(state.counts()).toEqual({ authorityCalls: 0, personCalls: 1 });
  });

  it("normalizes a missing session to typed 401", async () => {
    const state = harness({ unauthenticated: true });
    const response = await request(state.http, "/api/receipts");
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 401,
      body: { error: { tag: "UnauthenticatedActor" } },
    });
  });

  it("maps one active payment authority and keeps ciphertext out of ReceiptActor", async () => {
    const state = harness();
    const response = await multipartRequest(state.http, "/api/receipts/submit");
    expect(response.status).toBe(201);
    const command = state.commands[0] as {
      readonly actor: ReceiptActor;
      readonly paymentAccountCiphertext: string;
    };
    expect(command.actor).toEqual({
      personId,
      departmentId: departmentOne,
      active: true,
      approvalScope: { _tag: "None" },
    });
    expect(command.paymentAccountCiphertext).toBe("ciphertext:department-one");
    expect("paymentAccountCiphertext" in command.actor).toBe(false);
  });

  it("requires a department selection for several active payments", async () => {
    const resolved = authority(
      [departmentOne, departmentTwo],
      [payment("payment-one", departmentOne), payment("payment-two", departmentTwo)],
    );
    const ambiguous = harness({ authority: resolved });
    const denied = await multipartRequest(ambiguous.http, "/api/receipts/submit");
    expect({ status: denied.status, body: await denied.json() }).toEqual({
      status: 403,
      body: { error: { tag: "AmbiguousPaymentSelection" } },
    });

    const selected = harness({ authority: resolved });
    const accepted = await multipartRequest(
      selected.http,
      "/api/receipts/submit?departmentId=department-two",
    );
    expect(accepted.status).toBe(201);
    const command = selected.commands[0] as {
      readonly actor: ReceiptActor;
      readonly paymentAccountCiphertext: string;
    };
    expect(command.actor.departmentId).toBe(departmentTwo);
    expect(command.paymentAccountCiphertext).toBe("ciphertext:department-two");
  });

  it("uses the receipt projection department for approval actors", async () => {
    const resolved = authority(
      [departmentTwo],
      [],
      [grant({ _tag: "Department", departmentId: departmentTwo })],
    );
    const state = harness({ authority: resolved, approvalRows: [approvalRow(departmentTwo)] });
    const response = await request(state.http, "/api/admin/receipts/receipt-one/reject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "command-one", expectedRevision: 0 }),
    });
    expect(response.status).toBe(200);
    const command = state.commands[0] as { readonly actor: ReceiptActor };
    expect(command.actor).toEqual({
      personId,
      departmentId: departmentTwo,
      active: true,
      approvalScope: { _tag: "Department", departmentId: departmentTwo },
    });
    expect(state.approvalScopes).toEqual([{ _tag: "Department", departmentId: departmentTwo }]);
  });

  it("returns 404 only to Global approval authority for an absent Receipt", async () => {
    const department = harness({
      authority: authority(
        [departmentOne],
        [],
        [grant({ _tag: "Department", departmentId: departmentOne })],
      ),
    });
    const departmentResponse = await request(
      department.http,
      "/api/admin/receipts/receipt-absent/refund",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: "command-department-absent", expectedRevision: 0 }),
      },
    );
    expect({ status: departmentResponse.status, body: await departmentResponse.json() }).toEqual({
      status: 403,
      body: { error: { tag: "ReceiptScopeDenied" } },
    });

    const global = harness({
      authority: authority([departmentOne], [], [grant({ _tag: "Global" })]),
    });
    const globalResponse = await request(global.http, "/api/admin/receipts/receipt-absent/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "command-global-absent", expectedRevision: 0 }),
    });
    expect({ status: globalResponse.status, body: await globalResponse.json() }).toEqual({
      status: 404,
      body: { error: { tag: "ReceiptNotFound" } },
    });
    expect(department.commands).toEqual([]);
    expect(global.commands).toEqual([]);
    expect(department.approvalScopes).toEqual([
      { _tag: "Department", departmentId: departmentOne },
    ]);
    expect(global.approvalScopes).toEqual([{ _tag: "Global" }]);
  });

  it("denies inactive Organization authority and absent approval scope", async () => {
    const inactive = harness({ authority: authority([], []) });
    const inactiveResponse = await request(inactive.http, "/api/admin/receipts");
    expect({ status: inactiveResponse.status, body: await inactiveResponse.json() }).toEqual({
      status: 403,
      body: { error: { tag: "InactiveActor" } },
    });

    const unscoped = harness({ authority: authority([departmentOne], []) });
    const scopeResponse = await request(unscoped.http, "/api/admin/receipts");
    expect({ status: scopeResponse.status, body: await scopeResponse.json() }).toEqual({
      status: 403,
      body: { error: { tag: "ReceiptScopeDenied" } },
    });
  });
});
