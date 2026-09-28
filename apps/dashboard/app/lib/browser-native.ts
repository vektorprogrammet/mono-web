/**
 * The browser's calls to the native backend. The dashboard origin serves the backend's RPC
 * endpoint, and the browser sends the person's session cookie itself (`credentials: "include"`),
 * so a Foldkit command calls one native RPC with `callBrowserNative` and handles its declared
 * problems.
 */
import { NativeRpcClient, nativeRpcClientLayer } from "@vektorprogrammet/rpc/client";
import { Data, Effect, ManagedRuntime } from "effect";
import { resolveBrowserApiUrl } from "./browser-api";

/**
 * The backend's answer did not fit the contract, or the backend answered a defect: the RPC client
 * dies on both, and a Foldkit command answers this failure instead of crashing its program.
 */
export class NativeAnswerInvalid extends Data.TaggedError("NativeAnswerInvalid")<{
  readonly defect: unknown;
}> {}

type NativeClient = NativeRpcClient["Service"];

// The composition root of the browser's backend client, built on the first call.
let runtime: ManagedRuntime.ManagedRuntime<NativeRpcClient, never> | undefined;

const browserRuntime = () => {
  runtime ??= ManagedRuntime.make(
    nativeRpcClientLayer(
      resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin),
    ),
  );

  return runtime;
};

/** Calls one native RPC from the browser, as the person whose session cookie it holds. */
export const callBrowserNative = <A, E>(
  call: (client: NativeClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E | NativeAnswerInvalid> =>
  Effect.suspend(() => browserRuntime().contextEffect).pipe(
    Effect.flatMap((context) => NativeRpcClient.use(call).pipe(Effect.provideContext(context))),
    Effect.catchDefect((defect) => Effect.fail(new NativeAnswerInvalid({ defect }))),
  );
