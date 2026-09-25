import { Effect } from "effect";
import { receiptOutboxRequest } from "@vektorprogrammet/domain/receipt";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeReceiptFileStore } from "./filesystem.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("preserves file-effect identity across restart and retries an interrupted reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-custody-"));
  directories.push(root);
  const config = { stagingRoot: join(root, "staging"), committedRoot: join(root, "private") };
  const commandId = "restart-command";
  const effectId = commandId + ":PromoteReceiptFile";
  const first = makeReceiptFileStore({ ...config, failNextPromotionEffectId: effectId });
  const bytes = new Uint8Array([0, 255, 1, 17]);
  const staged = await first.stageBytes(new File([bytes], "receipt.png"), commandId, "image/png", 1024);
  const request = receiptOutboxRequest(commandId, "receipt-one", "PromoteReceiptFile", staged.file);
  await expect(Effect.runPromise(first.service.apply(request))).rejects.toMatchObject({ _tag: "ReceiptFileInjectedFailure" });

  const restarted = makeReceiptFileStore(config);
  await Effect.runPromise(restarted.service.apply(request));
  await Effect.runPromise(restarted.service.apply(request));
  expect(await restarted.readCommitted(staged.file, 1024)).toEqual(Buffer.from(bytes));
  const conflict = { ...request, receiptId: "different-receipt" };
  await expect(Effect.runPromise(makeReceiptFileStore(config).service.apply(conflict))).rejects.toMatchObject({ _tag: "ReceiptFileEffectConflict" });
  const markers = await readdir(join(config.committedRoot, ".effects"));
  expect(markers).toHaveLength(1);
  expect((await stat(join(config.committedRoot, ".effects", markers[0]!))).mode & 0o777).toBe(0o600);
});

it("reserves one identity when conflicting callers overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "receipt-custody-race-"));
  directories.push(root);
  const config = { stagingRoot: join(root, "staging"), committedRoot: join(root, "private") };
  const store = makeReceiptFileStore(config);
  const staged = await store.stageBytes(new File([new Uint8Array([1])], "receipt.png"), "race", "image/png", 1024);
  const request = receiptOutboxRequest("race", "receipt-a", "PromoteReceiptFile", staged.file);
  const results = await Promise.allSettled([
    Effect.runPromise(store.service.apply(request)),
    Effect.runPromise(makeReceiptFileStore(config).service.apply({ ...request, receiptId: "receipt-b" })),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { _tag: "ReceiptFileEffectConflict" } });
});
