/**
 * The dashboard server's calls to the native backend. A loader or action calls one native RPC on a
 * person's behalf with `callNative`, which forwards that person's cookie and the dashboard origin
 * on that call only. A failure rejects with the RPC's `Problem`, which `nativeFailureFrom` decodes.
 */
import {
  NativeRpcClient,
  nativeRpcClientLayer,
  withForwardedHeaders,
} from "@vektorprogrammet/rpc/client";
import { type Effect, ManagedRuntime } from "effect";

const serverApiUrl = typeof process !== "undefined" ? process.env?.API_URL : undefined;

const configuredApiUrl = (): string => {
  if (serverApiUrl === undefined || serverApiUrl.trim() === "") {
    throw new Error("API URL is not configured");
  }

  return serverApiUrl;
};

// The composition root of the dashboard server's backend client, built on first use.
let runtime: ManagedRuntime.ManagedRuntime<NativeRpcClient, never> | undefined;

const nativeRuntime = () => {
  runtime ??= ManagedRuntime.make(nativeRpcClientLayer(configuredApiUrl()));

  return runtime;
};

type NativeClient = NativeRpcClient["Service"];

/**
 * Calls the backend as the person whose `cookie` a loader or action read, from the dashboard
 * origin of `request`.
 */
export function callNative<A, E>(
  cookie: string,
  request: Request,
  call: (client: NativeClient) => Effect.Effect<A, E>,
): Promise<A> {
  return nativeRuntime().runPromise(
    NativeRpcClient.use(call).pipe(
      withForwardedHeaders({ cookie, origin: new URL(request.url).origin }),
    ),
  );
}

/** Calls a public native RPC, with no person's credential. */
export function callNativeAnonymously<A, E>(
  call: (client: NativeClient) => Effect.Effect<A, E>,
): Promise<A> {
  return nativeRuntime().runPromise(NativeRpcClient.use(call));
}

/** The URL of a plain HTTP route of the backend: Better Auth and OAuth. */
export function serverApiEndpoint(path: string): string {
  return new URL(path, configuredApiUrl()).toString();
}
