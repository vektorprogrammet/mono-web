/**
 * The native RPC client, derived from the contract. There is no generated SDK: `NativeRpcClient`
 * is `RpcClient.make(NativeRpcs)` over HTTP.
 *
 * @since 0.3.0
 */
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, Headers } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { NativeRpcs, nativeRpcPath } from "./api.js";

const makeClient = RpcClient.make(NativeRpcs);

/** A client of every native RPC. */
export class NativeRpcClient extends Context.Service<
  NativeRpcClient,
  Effect.Success<typeof makeClient>
>()("@vektorprogrammet/rpc/NativeRpcClient") {}

/**
 * The client of the backend at `origin`.
 *
 * @remarks
 * A browser sends its session cookie itself (`credentials: "include"`). A server that calls on a
 * person's behalf, such as a dashboard loader, forwards that person's `Cookie` or `Authorization`
 * header per call with `RpcClient.withHeaders`, never through this layer, so one client never
 * carries one person's credential into another person's call.
 */
export const nativeRpcClientLayer = (origin: string): Layer.Layer<NativeRpcClient> =>
  Layer.effect(NativeRpcClient)(makeClient).pipe(
    Layer.provide(
      RpcClient.layerProtocolHttp({ url: new URL(nativeRpcPath, origin).href }).pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ credentials: "include" })),
          ),
        ),
      ),
    ),
  );

/** Runs `effect` with `headers` added to every RPC it sends. */
export const withForwardedHeaders =
  (headers: Headers.Input) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, headers);
