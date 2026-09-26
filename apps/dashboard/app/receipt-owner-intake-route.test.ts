import assert from "node:assert/strict";
import { RECEIPT_FILE_MAX_BYTES } from "@vektorprogrammet/http-api";
import { createStaticHandler, RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeSessionResponse, sessionCookie } from "../test/native-http";

vi.hoisted(() => vi.stubEnv("API_URL", "http://api.test"));

import { action } from "./routes/dashboard.mine-utlegg._index";

const commandId = "receipt-owner-intake-command-0001";

const receiptId = "receipt-owner-intake-receipt";

const etag = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

const draft = { description: "Oversized receipt", amountNok: "125,50", receiptDate: "2026-09-01" };

/** Requests that reached the native API, other than the session check. */
const upstream: Request[] = [];

beforeEach(() => {
  upstream.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);

      if (new URL(request.url).pathname === "/api/session") return nativeSessionResponse();
      upstream.push(request);

      return new Response(null, { status: 503 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The owner form as the browser sends it: its fields first, then the file part. */
const ownerForm = (intent: string, fileBytes: number) => {
  const form = new FormData();
  form.set("_intent", intent);
  form.set("commandId", commandId);
  form.set("receiptId", receiptId);
  form.set("etag", etag);
  form.set("description", draft.description);
  form.set("amountNok", draft.amountNok);
  form.set("receiptDate", draft.receiptDate);
  form.set("file", new File([new Uint8Array(fileBytes)], "receipt.png", { type: "image/png" }));

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

describe("receipt owner form intake bound", () => {
  it("answers a file over the limit in the submission form with 413 and submits nothing", async () => {
    const { status, answer } = await post(ownerForm("submit", RECEIPT_FILE_MAX_BYTES + 1));

    expect(status).toBe(413);
    expect(answer).toMatchObject({ success: false, intent: "submit", commandId, error: fileError, draft });
    expect(upstream).toEqual([]);
  });

  it.each(["revise", "withdraw"])(
    "answers a %s form with a file over the limit in its receipt row with 413 and commits nothing",
    async (intent) => {
      const { status, answer } = await post(ownerForm(intent, RECEIPT_FILE_MAX_BYTES + 1));

      expect(status).toBe(413);
      expect(answer).toMatchObject({
        success: false,
        intent,
        mutationFailure: { intent, receiptId, etag, commandId, error: fileError },
      });
      expect(upstream).toEqual([]);
    },
  );
});
