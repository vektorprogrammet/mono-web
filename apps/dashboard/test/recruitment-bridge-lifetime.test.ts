// @vitest-environment happy-dom
import { createServer, type ServerResponse } from "node:http";
import { assert, describe, it } from "@effect/vitest";
import { Window } from "happy-dom";
import { Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from "effect";
import { Command, Runtime } from "foldkit";
import { createBrowserRecruitmentClient } from "../app/foldkit/recruitment/browser-client";
import { commandsFor as recruitmentCommands } from "../app/foldkit/recruitment/command";
import { SucceededLoadBoard } from "../app/foldkit/recruitment/message";
import { createBrowserInterviewClient } from "../app/foldkit/interview/browser-client";
import { commandsFor as interviewCommands } from "../app/foldkit/interview/command";
import { SucceededReadInvitationResponse } from "../app/foldkit/interview/message";
import { RecruitmentAssignmentBoardSchema, StrongETag } from "@vektorprogrammet/http-api";
import { InvitationResponseResourceSchema } from "../app/foldkit/interview/bridge";

const Completed = Schema.TaggedStruct("Completed", {});

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
const delayedBridge = Effect.fnUntraced(function* (body: string, pathname: string) {
  const accepted = yield* Deferred.make<ServerResponse>();
  const disconnected = yield* Deferred.make<void>();
  const networkSettled = yield* Deferred.make<void>();
  const signals: Array<NonNullable<Parameters<Window["fetch"]>[1]>["signal"]> = [];

  const server = yield* Effect.acquireRelease(
    Effect.sync(() => createServer((request, response) => {
      // Never mistake an unrelated CORS preflight for the Command-owned POST.
      if (request.method !== "POST" || request.url !== pathname) {
        Deferred.doneUnsafe(accepted, Effect.die(`Unexpected bridge request: ${request.method} ${request.url}`));
        response.writeHead(400);
        response.end();

        return;
      }

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
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

  const browserWindow = yield* Effect.acquireRelease(
    Effect.sync(() => new Window({ url: origin + "/dashboard/interview-response/redacted/" })),
    (owned) => Effect.promise(() => owned.happyDOM.close()),
  );

  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const browserFetch = browserWindow.fetch.bind(browserWindow);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      // Replacing only globalThis.location left fetch's Window at localhost.
      // Happy DOM then held an OPTIONS preflight with its own, unrelated signal
      // (Fetch.compliesWithCrossOriginPolicy), invalidating the old R8 witness.
      // This fixture owns both the same-origin page URL and its real fetch.
      Object.defineProperty(globalThis, "location", {
        configurable: true, value: browserWindow.location,
      });
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: (input: Parameters<typeof browserFetch>[0], init?: Parameters<typeof browserFetch>[1]) => {
          signals.push(init?.signal);

          const url = Predicate.isString(input) ? input : "url" in input ? input.url : input.href;

          return browserFetch(new URL(url, origin).href, init).then(
            (response) => {
              Deferred.doneUnsafe(networkSettled, Effect.void);

              return response;
            },
            (error) => { Deferred.doneUnsafe(networkSettled, Effect.void); throw error; },
          );
        },
      });
    }),
    () => Effect.sync(() => {
      if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
      else Reflect.deleteProperty(globalThis, "fetch");

      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
      else Reflect.deleteProperty(globalThis, "location");
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

const cases: ReadonlyArray<{
  name: string;
  pathname: string;
  body: string;
  expectedMessage: { readonly _tag: string };
  build: () => Command.Command<{ readonly _tag: string }>;
}> = [
  { name: "recruitment", body: Schema.encodeSync(Schema.fromJsonString(RecruitmentAssignmentBoardSchema))(board),
    pathname: "/recruitment", expectedMessage: SucceededLoadBoard({ requestId: 17, board }),
    build: () => recruitmentCommands(createBrowserRecruitmentClient()).LoadAssignmentBoard({ status: "all", requestId: 17 }) },
  { name: "interview", body: Schema.encodeSync(Schema.fromJsonString(InvitationResponseResourceSchema))(invitation),
    pathname: "/dashboard/interview", expectedMessage: SucceededReadInvitationResponse({ requestId: 17, ...invitation }),
    build: () => interviewCommands(createBrowserInterviewClient("a".repeat(32))).ReadInvitationResponse({ requestId: 17 }) },
];

describe("R8 real delayed browser bridge cancellation", () => {
  for (const scenario of cases) {
    it.live(`${scenario.name}: the real POST completes with its decoded success Message`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body, scenario.pathname);
        const fiber = yield* Effect.forkScoped(scenario.build().effect);
        const response = yield* Deferred.await(bridge.accepted).pipe(Effect.timeout("2 seconds"));
        assert.strictEqual(bridge.signals.length, 1);
        assert.isFalse(bridge.signals[0]?.aborted === true);
        yield* bridge.release(response);
        const message = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
        yield* Deferred.await(bridge.networkSettled);
        assert.deepStrictEqual(message, scenario.expectedMessage);
        assert.isFalse(yield* Deferred.isDone(bridge.disconnected));
      })),
    );

    it.live(`${scenario.name}: scoped interruption aborts the socket, finalizes and suppresses late messages`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body, scenario.pathname);
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
        const bridge = yield* delayedBridge(scenario.body, scenario.pathname);
        const started = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const restored = yield* Deferred.make<void>();
        const completed: string[] = [];

        const waitReceipt = Effect.fnUntraced(function* (receipt: Deferred.Deferred<void>, milestone: string) {
          const observed = yield* Deferred.await(receipt).pipe(Effect.interruptible, Effect.timeoutOption("1 second"));
          assert.isTrue(Option.isSome(observed), milestone);
        });

        const command = Command.mapMessage(
          Command.mapEffect(scenario.build(), (effect) => effect.pipe(
            Effect.tap((message) => Effect.sync(() => { completed.push(message._tag); })),
            Effect.ensuring(Deferred.succeed(finalized, undefined)),
            (work) => Deferred.succeed(started, undefined).pipe(Effect.andThen(work)),
          )),
          () => Completed.make({}),
        );

        // Node owns the socket. Happy DOM owns this explicit simulated host;
        // Foldkit's document-based renderer must use the same realm as its nodes.
        const dom = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const window = new Window();
            const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
            Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });

            return { window, originalDocument };
          }),
          Effect.fnUntraced(function* ({ window, originalDocument }) {
            yield* Effect.sync(() => {
              if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
              else Reflect.deleteProperty(globalThis, "document");
            });
            yield* Effect.promise(() => window.happyDOM.cancelAsync());
          }),
        );

        const document = dom.window.document;
        const MutationObserver = dom.window.MutationObserver;

        const hostElement = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const element = document.createElement("section");
            document.body.append(element);

            return element;
          }),
          (element) => Effect.sync(() => element.remove()),
        );

        const container = document.createElement("div");
        // Runtime rejects an anonymous container before it starts init Commands.
        container.id = "r8-" + scenario.name;
        hostElement.append(container);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const observer = new MutationObserver(() => {
              if (hostElement.firstChild === container && container.textContent === "") {
                Deferred.doneUnsafe(restored, Effect.void);
              }
            });

            observer.observe(hostElement, { childList: true, subtree: true });

            return observer;
          }),
          (observer) => Effect.sync(() => observer.disconnect()),
        );

        const handle = yield* Effect.acquireRelease(
          Effect.sync(() => Runtime.embed(Runtime.makeElement({
            Model: Schema.Int,
            // SAFETY: the owned Happy DOM node implements Foldkit's DOM ABI;
            // its independent declarations are not lib.dom's nominal types.
            container: container as typeof container & HTMLElement,
            init: () => ({ model: 0, commands: [command] }),
            update: (model: number) => ({ model: model + 1, commands: [] }),
            view: (model, h) => h.div([], [String(model)]),
            devTools: false, slow: false,
            crash: { report: ({ error }) => { Deferred.doneUnsafe(started, Effect.die(error)); } },
          }))),
          Effect.fnUntraced(function* (host) {
            host.dispose();

            // dispose signals interruption; it does not await runtime teardown.
            // Never remove its container while the renderer still owns it.
            if (hostElement.firstChild !== container || container.textContent !== "") {
              yield* waitReceipt(restored, "Runtime disposal did not restore its host container");
            }
          }),
        );

        yield* waitReceipt(started, "Runtime did not start the real Command");
        const response = yield* Deferred.await(bridge.accepted).pipe(Effect.timeout("1 second"));
        yield* Effect.sync(() => { handle.dispose(); handle.dispose(); });
        yield* waitReceipt(finalized, "Host disposal did not finalize the in-flight Command");
        assert.strictEqual(bridge.signals.length, 1);
        assert.isTrue(bridge.signals[0]?.aborted === true);
        yield* waitReceipt(bridge.disconnected, "Host disposal did not abort the real HTTP socket");
        yield* bridge.release(response);
        yield* waitReceipt(bridge.networkSettled, "Foreign HTTP operation did not settle");
        assert.deepStrictEqual(completed, []);
        yield* waitReceipt(restored, "Runtime did not finish restoring the host DOM");
        assert.strictEqual(hostElement.firstChild, container);
        assert.strictEqual(container.textContent, "");
      })),
    );


    it.live(`${scenario.name}: a late loopback response after interruption never produces a Message`, () =>
      Effect.scoped(Effect.gen(function* () {
        const bridge = yield* delayedBridge(scenario.body, scenario.pathname);
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
        const bridge = yield* delayedBridge(scenario.body, scenario.pathname);
        const discarded = scenario.build();
        assert.strictEqual(discarded.args?.requestId, 17);
        assert.deepStrictEqual(bridge.signals, []);
        assert.isFalse(yield* Deferred.isDone(bridge.accepted));
      })),
    );
  }
});
