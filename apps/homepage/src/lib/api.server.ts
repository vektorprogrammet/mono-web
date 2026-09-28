/**
 * The homepage server's calls to the native backend. The homepage calls public RPCs with no
 * person's credential; the contact form adds its deployment secret per call through `headers`. A
 * failure rejects with the RPC's `Problem`, and a redirect rejects without being followed.
 */
import {
  NativeRpcClient,
  nativeRpcClientLayer,
  withForwardedHeaders,
} from "@vektorprogrammet/rpc/client";
import { type Effect, ManagedRuntime } from "effect";

const configuredApiUrl = (explicitOrigin?: string): string => {
  const apiUrl =
    explicitOrigin ?? (typeof process === "undefined" ? undefined : process.env.API_URL);

  if (apiUrl === undefined || apiUrl.trim() === "") throw new Error("API URL is not configured");

  return apiUrl;
};

// The composition root of the homepage server's backend client, one per backend origin.
const runtimes = new Map<string, ManagedRuntime.ManagedRuntime<NativeRpcClient, never>>();

const nativeRuntime = (origin: string) => {
  const existing = runtimes.get(origin);

  if (existing !== undefined) return existing;

  const runtime = ManagedRuntime.make(nativeRpcClientLayer(origin));

  runtimes.set(origin, runtime);

  return runtime;
};

type NativeClient = NativeRpcClient["Service"];

/**
 * Calls one native RPC from the homepage server. `explicitOrigin` overrides `API_URL`, as a
 * Worker binding does; `headers` are added to this call only.
 */
export function callHomepageNative<A, E>(
  call: (client: NativeClient) => Effect.Effect<A, E>,
  options: {
    readonly explicitOrigin?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<A> {
  return nativeRuntime(configuredApiUrl(options.explicitOrigin)).runPromise(
    NativeRpcClient.use(call).pipe(withForwardedHeaders(options.headers ?? {})),
  );
}
