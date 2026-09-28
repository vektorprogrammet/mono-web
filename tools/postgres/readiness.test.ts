import { createServer, type Server } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { waitForPostgres } from "./index";

type Answer = "starting-up" | "accepting" | "hang-up";

const sslRequest = 80_877_103;

const gssEncryptionRequest = 80_877_104;

const message = (type: string, body: Buffer) => {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);

  return Buffer.concat([header, body]);
};

// What a starting server sends to every session: FATAL 57P03 (cannot_connect_now).
const startingUp = message(
  "E",
  Buffer.from("SFATAL\0VFATAL\0C57P03\0Mthe database system is starting up\0\0", "latin1"),
);

// AuthenticationOk, then ReadyForQuery in the idle state.
const accepting = Buffer.concat([
  message("R", Buffer.from([0, 0, 0, 0])),
  message("Z", Buffer.from("I", "latin1")),
]);

/** Listens on a loopback port that the kernel chooses, and closes when the test's scope closes. */
const listening = (server: Server) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (served) =>
      Effect.callback<void>((resume) => {
        served.close(() => resume(Effect.void));
      }),
  );

/**
 * A loopback endpoint that speaks the PostgreSQL startup protocol. It refuses encryption and
 * answers the startup message of connection `n` with `answer(n)`, which it records.
 */
const endpoint = (answer: (attempt: number) => Answer) =>
  Effect.gen(function* () {
    const answers: Array<Answer> = [];

    const server = yield* listening(
      createServer((socket) => {
        let pending = Buffer.alloc(0);

        socket.on("error", () => undefined);
        socket.on("data", (chunk) => {
          pending = Buffer.concat([pending, chunk]);

          while (pending.length >= 8 && pending.length >= pending.readInt32BE(0)) {
            const code = pending.readInt32BE(4);
            pending = pending.subarray(pending.readInt32BE(0));

            if (code === sslRequest || code === gssEncryptionRequest) {
              socket.write("N");
              continue;
            }

            const verdict = answer(answers.length);
            answers.push(verdict);

            if (verdict === "hang-up") socket.destroy();
            else socket.end(verdict === "accepting" ? accepting : startingUp);

            return;
          }
        });
      }),
    );

    const address = server.address();

    if (address === null || Predicate.isString(address))
      return yield* Effect.die(new Error("no loopback port"));

    return { address: { host: "127.0.0.1", port: address.port, user: "postgres" }, answers };
  });

describe("waitForPostgres", () => {
  it.live("does not report a server that accepts TCP but still starts up as ready", () =>
    Effect.gen(function* () {
      const { address, answers } = yield* endpoint(() => "starting-up");

      yield* Effect.promise(() =>
        expect(waitForPostgres(address, 1_500)).rejects.toThrow(
          /did not accept connections within 1500 ms/u,
        ),
      );
      expect(answers.length).toBeGreaterThan(1);
    }),
  );

  it.live("does not report a server that closes the connection without an answer as ready", () =>
    Effect.gen(function* () {
      const { address, answers } = yield* endpoint(() => "hang-up");

      yield* Effect.promise(() =>
        expect(waitForPostgres(address, 1_000)).rejects.toThrow(/did not accept connections/u),
      );
      expect(answers.length).toBeGreaterThan(1);
    }),
  );

  it.live("reports ready at the first session that the server accepts", () =>
    Effect.gen(function* () {
      const { address, answers } = yield* endpoint((attempt) =>
        attempt < 3 ? "starting-up" : "accepting",
      );

      yield* Effect.promise(() => waitForPostgres(address, 30_000));

      expect(answers).toEqual(["starting-up", "starting-up", "starting-up", "accepting"]);
    }),
  );

  it.live("stops waiting with the reason of an abandoned start", () => {
    const abandon = new AbortController();
    const reason = new Error("PostgreSQL exited with code 1");

    return Effect.gen(function* () {
      const { address } = yield* endpoint(() => {
        abandon.abort(reason);

        return "starting-up";
      });

      yield* Effect.promise(() =>
        expect(waitForPostgres(address, 30_000, abandon.signal)).rejects.toBe(reason),
      );
    });
  });
});
