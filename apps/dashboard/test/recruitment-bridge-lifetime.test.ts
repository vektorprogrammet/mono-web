// @vitest-environment happy-dom
import { createServer, type ServerResponse } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { Window } from "happy-dom";
import { Deferred, Effect, Exit, Fiber, Predicate, Schema } from "effect";
import { Command, Runtime } from "foldkit";
import { createBrowserRecruitmentClient } from "../app/foldkit/recruitment/browser-client";
import { commandsFor as recruitmentCommands } from "../app/foldkit/recruitment/command";
import { createBrowserInterviewClient } from "../app/foldkit/interview/browser-client";
import { commandsFor as interviewCommands } from "../app/foldkit/interview/command";
import { RecruitmentAssignmentBoardSchema, StrongETag } from "@vektorprogrammet/http-api";
import { InvitationResponseResourceSchema } from "../app/foldkit/interview/bridge";

const Completed = Schema.TaggedStruct("Completed", {});

const nativeFetch = globalThis.fetch.bind(globalThis);

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

const board = Schema.decodeSync(RecruitmentAssignmentBoardSchema)({
  admissionPeriodId: "period-lifetime", departmentId: "department-lifetime",
  candidates: [], interviewers: [], interviewSchemas: [],
});

const invitation = Schema.decodeSync(InvitationResponseResourceSchema)({
  observation: { scheduledAt: "2031-09-20T13:30:00.000Z", room: "K-101", campus: "Campus",
    responseState: "Pending", responseMessage: null }, etag,
});

// This is a URL adapter, not a fetch stub: every request uses a real loopback socket.
// The server holds the response until the test releases it; no delay or polling signals success.
const delayedBridge = Effect.fnUntraced(function* (body: string) {
  const accepted = yield* Deferred.make<ServerResponse>();
  const disconnected = yield* Deferred.make<void>();
  const networkSettled = yield* Deferred.make<void>();
  const signals: Array<AbortSignal | null | undefined> = [];

  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer((_request, response) => {
      response.once("close", () => {
        if (!response.writableEnded) Deferred.doneUnsafe(disconnected, Effect.void);
      });
      Deferred.doneUnsafe(accepted, Effect.succeed(response));
    })),
    (owned) => Effect.callback<void>((resume) => {
      owned.closeAllConnections();
      owned.close(() => resume(Effect.void));
    }),
  );

  yield* Effect.callback<void>((resume) => {
    server.listen(0, "127.0.0.1", () => resume(Effect.void));
  });
  const address = server.address();
  assert.isNotNull(address);
  assert.notTypeOf(address, "string");

  if (address === null || Predicate.isString(address)) return yield* Effect.die("missing loopback address");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      Object.defineProperty(globalThis, "location", {
        configurable: true, value: new URL(origin + "/dashboard/interview-response/redacted/"),
      });
      globalThis.fetch = (input, init) => {
        signals.push(init?.signal);

        const url = Predicate.isString(input) ? input : input instanceof URL ? input.href : input.url;

        return nativeFetch(new URL(url, origin), init).then(
          (response) => {
            Deferred.doneUnsafe(networkSettled, Effect.void);

            return response;
          },
          (error) => { Deferred.doneUnsafe(networkSettled, Effect.void); throw error; },
        );
      };
    }),
    () => Effect.sync(() => {
      globalThis.fetch = originalFetch;

      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    }),
  );

  return {
    accepted, disconnected, networkSettled, signals,
    release: (response: ServerResponse) => Effect.sync(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    }),
  };
});

const cases: ReadonlyArray<{ name: string; body: string; build: () => Command.Command<{ readonly _tag: string }> }> = [
  { name: "recruitment", body: Schema.encodeSync(Schema.fromJsonString(RecruitmentAssignmentBoardSchema))(board),
    build: () => recruitmentCommands(createBrowserRecruitmentClient()).LoadAssignmentBoard({ status: "all", requestId: 17 }) },
  { name: "interview", body: Schema.encodeSync(Schema.fromJsonString(InvitationResponseResourceSchema))(invitation),
    build: () => interviewCommands(createBrowserInterviewClient("a".repeat(32))).ReadInvitationResponse({ requestId: 17 }) },
];

describe("R8 real delayed browser bridge cancellation", () => {
  for (const scenario of cases) {
    it.live(`${scenario.name}: scoped interruption aborts the socket, finalizes and suppresses late messages`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body);
        const finalized = yield* Deferred.make<void>();
        const messages: string[] = [];
        const command = scenario.build();

        const fiber = yield* Effect.forkScoped(command.effect.pipe(
          Effect.tap((message) => Effect.sync(() => { messages.push(message._tag); })),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        ));

        const response = yield* Deferred.await(bridge.accepted);
        yield* Fiber.interrupt(fiber);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        yield* Deferred.await(finalized);
        // A stopped Effect alone is not proof: the foreign request must receive its signal.
        assert.strictEqual(bridge.signals.length, 1);
        assert.isTrue(bridge.signals[0]?.aborted === true);
        yield* Deferred.await(bridge.disconnected).pipe(Effect.timeout("2 seconds"));
        yield* bridge.release(response);
        yield* Deferred.await(bridge.networkSettled);
        assert.deepStrictEqual(messages, []);
      })),
    );

    it.live(`${scenario.name}: custom host disposal aborts the network and releases the in-flight Command`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body);
        const finalized = yield* Deferred.make<void>();
        const completed: string[] = [];

        const command = Command.mapMessage(
          Command.mapEffect(scenario.build(), (effect) => effect.pipe(
            Effect.tap((message) => Effect.sync(() => { completed.push(message._tag); })),
            Effect.ensuring(Deferred.succeed(finalized, undefined)),
          )),
          () => Completed.make({}),
        );
        // Node owns the loopback server; Happy DOM supplies the explicit simulated host boundary.

        const dom = yield* Effect.acquireRelease(
          Effect.sync(() => new Window()),
          (window) => Effect.promise(() => window.happyDOM.cancelAsync()),
        );

        // SAFETY: Happy DOM's node classes implement the DOM operations Foldkit uses here,
        // but its independent declarations are not lib.dom's nominal host types. The real
        // embed/dispose probe exercises this boundary. Remove the intersection when Happy DOM
        // exports lib.dom-compatible HTMLElement types; no Effect channel or decoded value is cast.
        const document = dom.document;
        const MutationObserver = dom.MutationObserver;
        const container = document.createElement("div");
        document.body.append(container);

        const handle = yield* Effect.acquireRelease(
          Effect.sync(() => Runtime.embed(Runtime.makeElement({
            Model: Schema.Int,
            // SAFETY: this owned Happy DOM element supplies the standard DOM operations used by Foldkit.
            container: container as typeof container & HTMLElement,
            init: () => ({ model: 0, commands: [command] }),
            update: (model: number) => ({ model: model + 1, commands: [] }),
            view: (model, h) => h.div([], [String(model)]),
            devTools: false, slow: false,
          }))),
          (host) => Effect.sync(() => { host.dispose(); container.remove(); }),
        );

        const response = yield* Deferred.await(bridge.accepted);
        yield* Effect.sync(() => { handle.dispose(); handle.dispose(); });
        yield* Deferred.await(finalized).pipe(Effect.timeout("2 seconds"));
        assert.isTrue(bridge.signals[0]?.aborted === true);
        yield* Deferred.await(bridge.disconnected).pipe(Effect.timeout("2 seconds"));
        yield* bridge.release(response);
        yield* Deferred.await(bridge.networkSettled);
        assert.deepStrictEqual(completed, []);
        yield* Effect.callback<void>((resume) => {
          if (container.textContent === "") {
            resume(Effect.void);

            return;
          }

          const observer = new MutationObserver(() => {
            if (container.textContent === "") resume(Effect.void);
          });

          observer.observe(container, { childList: true, subtree: true });

          return Effect.sync(() => observer.disconnect());
        }).pipe(Effect.timeout("2 seconds"));
      })),
    );


    it.live(`${scenario.name}: a late loopback response after interruption never produces a Message`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body);
        const messages: string[] = [];
        const finalized = yield* Deferred.make<void>();

        const fiber = yield* Effect.forkScoped(scenario.build().effect.pipe(
          Effect.tap((message) => Effect.sync(() => { messages.push(message._tag); })),
          Effect.ensuring(Deferred.succeed(finalized, undefined)),
        ));

        const response = yield* Deferred.await(bridge.accepted);
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(finalized);
        // Healthy control independent of signal forwarding: settle the actual foreign operation.
        yield* bridge.release(response);
        yield* Deferred.await(bridge.networkSettled).pipe(Effect.timeout("2 seconds"));
        assert.deepStrictEqual(messages, []);
      })),
    );

    it.live(`${scenario.name}: constructing and discarding the real Command starts no network work`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body);
        const discarded = scenario.build();
        assert.strictEqual(discarded.args?.requestId, 17);
        assert.deepStrictEqual(bridge.signals, []);
        assert.isFalse(yield* Deferred.isDone(bridge.accepted));
      })),
    );
  }
});
