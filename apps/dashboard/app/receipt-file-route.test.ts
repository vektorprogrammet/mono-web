import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeArgs, sessionCookie } from "../test/native-http";
import {
  type NativeRpcCall,
  nativeRpcProblem,
  nativeRpcSuccess,
  nativeSession,
  readNativeRpcCall,
} from "../test/native-rpc";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { loader } from "./routes/dashboard.utlegg.$receiptId.file";

const fileBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const privateFileHeaders = {
  "cache-control": "private, no-store",
  "content-disposition": 'inline; filename="receipt.png"',
  "content-length": String(fileBytes.byteLength),
  "content-type": "image/png",
  vary: "Origin",
  "x-content-type-options": "nosniff",
};

/** The RPC calls other than the session check. */
const calls: NativeRpcCall[] = [];

/** The receipt RPCs among them; an expired session also signs out. */
const receiptCalls = () => calls.filter((call) => call.tag.startsWith("receipts."));

type Answer = (call: NativeRpcCall) => Response;

/** A file success, encoded as the RPC server encodes `ReceiptFileContent`: bytes as base64. */
const fileAnswer =
  (contentType: string, bytes: Uint8Array): Answer =>
  (call) =>
    nativeRpcSuccess(call, { contentType, bytes: Buffer.from(bytes).toString("base64") });

let answerFile: Answer = fileAnswer("image/png", fileBytes);

let answerSession: Answer = (call) => nativeRpcSuccess(call, nativeSession);

const load = (receiptId = "receipt-approval-file") =>
  loader(
    routeArgs(
      new Request(`http://dashboard.test/dashboard/utlegg/${receiptId}/file`, {
        headers: { cookie: sessionCookie },
      }),
      { receiptId },
    ),
  );

const expectPrivateFailure = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBeNull();
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(await response.text()).toBe("");
};

beforeEach(() => {
  calls.length = 0;
  answerSession = (call) => nativeRpcSuccess(call, nativeSession);
  answerFile = fileAnswer("image/png", fileBytes);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const call = await readNativeRpcCall(input, init);

      if (call.tag === "system.readSession") return answerSession(call);
      calls.push(call);

      return answerFile(call);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("receipt approval file resource route", () => {
  it("forwards the session and answers the exact private bytes at the same-origin route", async () => {
    const response = await load();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes);
    expect(Object.fromEntries(response.headers)).toEqual(privateFileHeaders);
    expect(calls.map((call) => [call.tag, call.payload, call.headers.get("cookie")])).toEqual([
      ["receipts.readReceiptFileForApproval", { receiptId: "receipt-approval-file" }, sessionCookie],
    ]);
  });

  it("denies an expired session before reading private bytes", async () => {
    answerSession = (call) => nativeRpcProblem(call, "credential.invalid");
    await expectPrivateFailure(await load(), 401);
    expect(receiptCalls()).toEqual([]);
  });

  it("conceals invalid receipt paths without a file read", async () => {
    await expectPrivateFailure(await load(""), 404);
    expect(receiptCalls()).toEqual([]);
  });

  it.each([
    ["credential.invalid", 401],
    ["authority.denied", 403],
    ["resource.not-found", 404],
    ["receipts.unavailable", 503],
  ] as const)("maps %s without exposing its problem body", async (code, status) => {
    answerFile = (call) => nativeRpcProblem(call, code);
    await expectPrivateFailure(await load(), status);
  });

  it("conceals an answer outside the contract", async () => {
    answerFile = fileAnswer("text/html", fileBytes);
    await expectPrivateFailure(await load(), 503);
  });

  it.each([
    ["image/jpeg", "jpg"],
    ["application/pdf", "pdf"],
  ] as const)("keeps the %s media type in its headers", async (contentType, extension) => {
    answerFile = fileAnswer(contentType, fileBytes);
    const response = await load();
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="receipt.${extension}"`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fileBytes);
  });

  it("withholds an empty file", async () => {
    answerFile = fileAnswer("image/png", new Uint8Array());
    await expectPrivateFailure(await load(), 503);
  });
});
