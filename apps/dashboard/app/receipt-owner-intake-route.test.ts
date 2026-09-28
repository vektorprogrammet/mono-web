import assert from "node:assert/strict";
import { ReceiptResource } from "@vektorprogrammet/rpc";
import { Schema } from "effect";
import { createStaticHandler, RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionCookie } from "../test/native-http";
import {
  type NativeRpcCall,
  nativeRpcSuccess,
  nativeSession,
  readNativeRpcCall,
} from "../test/native-rpc";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { RECEIPT_FILE_MAX_BYTES } from "./lib/receipt-upload.server";
import { action } from "./routes/dashboard.mine-utlegg._index";

const commandId = "receipt-owner-intake-command-0001";

const receiptId = "receipt-owner-intake-receipt";

const etag = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

const draft = { description: "Oversized receipt", amountNok: "125,50", receiptDate: "2026-09-01" };

/** RPC calls that reached the native API, other than the session check. */
const upstream: NativeRpcCall[] = [];

/** The submitted receipt, as the RPC server encodes a `ReceiptResource`. */
const submitted = Schema.encodeSync(Schema.toCodecJson(ReceiptResource))(
  Schema.decodeSync(ReceiptResource)({
    receiptId,
    visualId: "visual-owner-intake",
    ownerPersonId: "person-1",
    departmentId: "department-1",
    description: draft.description,
    amountOre: 12_550,
    currency: "NOK",
    receiptDate: draft.receiptDate,
    status: "Pending",
    submittedAt: "2026-09-01T12:00:00.000Z",
    approvedAt: null,
    revision: 0,
    etag,
  }),
);

beforeEach(() => {
  upstream.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const call = await readNativeRpcCall(input, init);

      if (call.tag === "system.readSession") return nativeRpcSuccess(call, nativeSession);
      upstream.push(call);

      return call.tag === "receipts.submitReceipt"
        ? nativeRpcSuccess(call, submitted)
        : new Response(null, { status: 503 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The owner form as the browser sends it: its fields first, then the file part. */
const ownerForm = (intent: string, fileBytes: Uint8Array<ArrayBuffer>) => {
  const form = new FormData();
  form.set("_intent", intent);
  form.set("commandId", commandId);
  form.set("receiptId", receiptId);
  form.set("etag", etag);
  form.set("description", draft.description);
  form.set("amountNok", draft.amountNok);
  form.set("receiptDate", draft.receiptDate);
  form.set("file", new File([fileBytes], "receipt.png", { type: "image/png" }));

  return new Request("http://dashboard.test/dashboard/mine-utlegg", {
    method: "POST",
    headers: { cookie: sessionCookie },
    body: form,
  });
};

/** Runs the route as the server does for a form post, and returns the answer it renders. */
const post = async (request: Request) => {
  const context = await createStaticHandler([
    { id: "mine-utlegg", path: "/dashboard/mine-utlegg", action },
  ]).query(request, { requestContext: new RouterContextProvider(), skipRevalidation: true });

  assert.ok(!(context instanceof Response));

  return { status: context.statusCode, answer: context.actionData?.["mine-utlegg"] };
};

/** The error names the file input, so the form shows it beside the file the owner picked. */
const fileError = { field: "file" };

const oversized = () => new Uint8Array(RECEIPT_FILE_MAX_BYTES + 1);

describe("receipt owner form intake bound", () => {
  it("answers a file over the limit in the submission form with 413 and submits nothing", async () => {
    const { status, answer } = await post(ownerForm("submit", oversized()));

    expect(status).toBe(413);
    expect(answer).toMatchObject({
      success: false,
      intent: "submit",
      commandId,
      error: fileError,
      draft,
    });
    expect(upstream).toEqual([]);
  });

  it.each(["revise", "withdraw"])(
    "answers a %s form with a file over the limit in its receipt row with 413 and commits nothing",
    async (intent) => {
      const { status, answer } = await post(ownerForm(intent, oversized()));

      expect(status).toBe(413);
      expect(answer).toMatchObject({
        success: false,
        intent,
        mutationFailure: { intent, receiptId, etag, commandId, error: fileError },
      });
      expect(upstream).toEqual([]);
    },
  );

  it("submits a file within the limit as bytes in the RPC payload", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const { status, answer } = await post(ownerForm("submit", bytes));

    expect(status).toBe(200);
    expect(answer).toMatchObject({ success: true, submission: { receiptId, etag } });
    expect(upstream.map((call) => [call.tag, call.headers.get("cookie")])).toEqual([
      ["receipts.submitReceipt", sessionCookie],
    ]);
    expect(upstream[0]?.payload).toEqual({
      idempotencyKey: commandId,
      request: {
        description: draft.description,
        amountOre: 12_550,
        receiptDate: draft.receiptDate,
        file: { contentType: "image/png", bytes: Buffer.from(bytes).toString("base64") },
      },
    });
  });
});
