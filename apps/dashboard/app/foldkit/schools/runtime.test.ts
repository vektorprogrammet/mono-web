// @vitest-environment happy-dom
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { SchoolsDirectoryClient } from "./browser-client";
import { embedSchoolsDirectory } from "./main";

it("interrupts both School reads when the owning Foldkit element is disposed", async () => {
  const directoryStarted = Promise.withResolvers<void>();
  const directoryReleased = Promise.withResolvers<void>();
  const managementStarted = Promise.withResolvers<void>();
  const managementReleased = Promise.withResolvers<void>();

  const inFlight = (
    started: PromiseWithResolvers<void>,
    released: PromiseWithResolvers<void>,
  ) =>
    Effect.sync(() => started.resolve()).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => released.resolve())),
    );

  const client: SchoolsDirectoryClient = {
    directory: {
      listSchools: () => inFlight(directoryStarted, directoryReleased),
      readManagement: () => inFlight(managementStarted, managementReleased),
      executeCommand: () => Effect.die("no school mutation was submitted"),
    },
  };

  const container = document.createElement("div");
  container.id = "schools-runtime-disposal-test";
  document.body.append(container);
  const dispose = embedSchoolsDirectory(container, { client });

  try {
    await Promise.all([directoryStarted.promise, managementStarted.promise]);
    dispose();
    await Promise.all([directoryReleased.promise, managementReleased.promise]);
    await vi.waitFor(() => expect(document.querySelector(".schools-directory")).toBeNull());
  } finally {
    dispose();
    container.remove();
  }
});
