/**
 * EX-0021: Required public native socket/SQL APIs retain upstream unstable annotations.
 * @effect-diagnostics unstableApiUsage:off
 * EX-0032: Test-only public Duplex ABI and actual socket-close observations.
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { reserveLoopbackPorts, type DisposablePostgres } from "@monoweb/postgres";
import { Clock, Deferred, Effect, Option } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0032: PgClientConfig.stream requires a fresh synchronous Node Duplex, not an Effect Socket reader.
import { createConnection, type Socket } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0032: Public host timer-resource observation has no Effect equivalent.
import { getActiveResourcesInfo, versions } from "node:process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- EX-0032: A genuine public Duplex suppresses close events while forwarding actual PostgreSQL traffic.
import { Duplex } from "node:stream";

interface ObservedTransport {
  readonly socket: Socket;
  readonly closed: Deferred.Deferred<void>;
  closedAtNanos: bigint | null;
}

/** The receipts describe actual public sockets, never invented pool bookkeeping. */
export interface NativePgTransportProbe {
  readonly stream: () => Socket;
  readonly connected: Effect.Effect<void>;
  readonly closed: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<
    ReadonlyArray<{
      readonly destroyed: boolean;
      readonly closed: boolean;
      readonly closedAtNanos: bigint | null;
    }>
  >;
}

/**
 * EX-0032: The native PostgreSQL driver owns each fresh stream. This test scope owns only
 * its observation and last-resort teardown. A receipt completes on the real close event.
 * Teardown runs after the caller captures its outcome, not to manufacture a passing deadline.
 */
export const observeNativePgTransport = Effect.fnUntraced(function* (endpoint: {
  readonly host: string;
  readonly port: number;
}) {
  const clock = yield* Clock.Clock;
  const transports: ObservedTransport[] = [];
  const connected = yield* Deferred.make<void>();

  const closed = Effect.suspend(() =>
    Effect.forEach(transports, (transport) => Deferred.await(transport.closed), { discard: true }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const transport of transports) transport.socket.destroy();
    }).pipe(Effect.andThen(closed)),
  );

  return {
    stream: () => {
      const socket = createConnection(endpoint);
      socket.once("connect", () => Deferred.doneUnsafe(connected, Effect.void));
      const receipt = Deferred.makeUnsafe<void>();
      const observed: ObservedTransport = { socket, closed: receipt, closedAtNanos: null };
      socket.once("close", () => {
        observed.closedAtNanos = clock.monotonicTimeNanosUnsafe();
        Deferred.doneUnsafe(receipt, Effect.void);
      });
      transports.push(observed);

      return socket;
    },
    closed,
    connected: Deferred.await(connected),
    snapshot: Effect.sync(() =>
      transports.map(({ socket, closedAtNanos }) => ({
        destroyed: socket.destroyed,
        closed: socket.closed,
        closedAtNanos,
      })),
    ),
  } satisfies NativePgTransportProbe;
});

/**
 * EX-0032: Real PostgreSQL traffic passes unchanged through a maintained native socket server.
 * The deliberate fault withholds the relay's FIN after the upstream PostgreSQL socket ends.
 * The use scope owns every peer, upstream socket, and handler fiber. No wire bytes are decoded,
 * recorded, or logged. Only task-owned transports close during final cleanup.
 */
export const withFinWithheldPostgres = Effect.fnUntraced(function* <A, E, R>(
  postgres: DisposablePostgres,
  use: (endpoint: {
    readonly host: string;
    readonly port: number;
    readonly url: string;
  }) => Effect.Effect<A, E, R>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const ports = yield* Effect.promise(() => reserveLoopbackPorts(1));
      const port = yield* Effect.fromNullishOr(ports[0]);
      const host = "127.0.0.1";
      const server = yield* BunSocketServer.make({ host, port, allowHalfOpen: true });

      yield* server
        .run(() =>
          Effect.scoped(
            Effect.gen(function* () {
              // The maintained server supplies this public per-connection capability.
              const peer = yield* Effect.serviceOption(BunSocket.NetSocket);

              if (Option.isNone(peer))
                return yield* Effect.die(
                  "Native SocketServer omitted its public NetSocket capability",
                );

              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const downstream = peer.value;
                  const upstream = createConnection({ host: postgres.host, port: postgres.port });
                  const downstreamClosed = Deferred.makeUnsafe<void>();
                  const upstreamClosed = Deferred.makeUnsafe<void>();
                  downstream.once("close", () =>
                    Deferred.doneUnsafe(downstreamClosed, Effect.void),
                  );
                  upstream.once("close", () => Deferred.doneUnsafe(upstreamClosed, Effect.void));
                  downstream.on("error", () => upstream.destroy());
                  upstream.on("error", () => downstream.destroy());
                  downstream.pipe(upstream);
                  upstream.pipe(downstream, { end: false });

                  return { downstream, upstream, downstreamClosed, upstreamClosed };
                }),
                ({ downstream, upstream, downstreamClosed, upstreamClosed }) =>
                  Effect.sync(() => {
                    downstream.destroy();
                    upstream.destroy();
                  }).pipe(
                    Effect.andThen(Deferred.await(downstreamClosed)),
                    Effect.andThen(Deferred.await(upstreamClosed)),
                  ),
              );

              return yield* Effect.never;
            }),
          ),
        )
        .pipe(Effect.forkScoped);

      const url = new URL(postgres.url);
      url.hostname = host;
      url.port = String(port);

      return yield* use({ host, port, url: url.toString() });
    }),
  );
});

/** EX-0032: Public host resources only; validity requires RED on the known timer-leaking patch. */
export const readNativeTimeoutCount = Effect.sync(() =>
  getActiveResourcesInfo().reduce((count, resource) => count + Number(resource === "Timeout"), 0),
);

/** EX-0032: Identify the actual test host, not the command used to launch Vitest. */
export const readNativeHostRuntime = Effect.sync(() => ({
  runtime: versions.bun === undefined ? "node" : "bun",
  version: versions.bun ?? versions.node,
}));

/**
 * EX-0032: A real public Duplex forwarding unchanged PostgreSQL traffic. The public
 * emitClose:false option suppresses the wrapper receipt, not the actual TCP shutdown.
 * This tests a missing close acknowledgement without a fake Socket or prototype mutation.
 */
export class CloseSilentPgDuplex extends Duplex {
  constructor(readonly transport: Socket) {
    super({ emitClose: false, allowHalfOpen: true });
    transport.on("data", (chunk: Uint8Array) => {
      if (!this.push(chunk)) transport.pause();
    });
    transport.on("end", () => this.push(null));
    transport.on("error", (error: Error) => this.destroy(error));
  }

  override _read(): void {
    this.transport.resume();
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.transport.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.transport.end(callback);
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.transport.destroy();
    callback(error);
  }
}

/** EX-0032: A maintained native listener accepts TCP but deliberately supplies no PostgreSQL startup reply. */
export const withStartupWithheldPostgres = Effect.fnUntraced(function* <A, E, R>(
  postgres: DisposablePostgres,
  use: (endpoint: {
    readonly host: string;
    readonly port: number;
    readonly url: string;
  }) => Effect.Effect<A, E, R>,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const ports = yield* Effect.promise(() => reserveLoopbackPorts(1));
      const port = yield* Effect.fromNullishOr(ports[0]);
      const host = "127.0.0.1";
      const server = yield* BunSocketServer.make({ host, port });

      yield* server
        .run(() =>
          Effect.scoped(
            Effect.gen(function* () {
              // The accepted peer is never read, so its owner must destroy it and await its close.
              const peer = yield* Effect.serviceOption(BunSocket.NetSocket);

              if (Option.isNone(peer))
                return yield* Effect.die(
                  "Native SocketServer omitted its public NetSocket capability",
                );

              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const closed = Deferred.makeUnsafe<void>();

                  if (peer.value.closed) Deferred.doneUnsafe(closed, Effect.void);
                  else peer.value.once("close", () => Deferred.doneUnsafe(closed, Effect.void));

                  return closed;
                }),
                (closed) =>
                  Effect.sync(() => peer.value.destroy()).pipe(
                    Effect.andThen(Deferred.await(closed)),
                  ),
              );

              return yield* Effect.never;
            }),
          ),
        )
        .pipe(Effect.forkScoped);

      const url = new URL(postgres.url);
      url.hostname = host;
      url.port = String(port);

      return yield* use({ host, port, url: url.toString() });
    }),
  );
});
