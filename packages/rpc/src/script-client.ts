/**
 * A promise client for journey drivers, acceptance probes, and other scripts that call the native
 * backend as one person at a time.
 *
 * @since 0.3.0
 */
import { Cause, type Effect, Exit, ManagedRuntime } from "effect";
import { NativeRpcClient, nativeRpcClientLayer, withForwardedHeaders } from "./client.js";
import { isProblem, problemBody } from "./problem.js";

/** The answer of one RPC call, with the HTTP status its outcome had under the HTTP contract. */
export type ScriptCallResult<A> =
  | { readonly ok: true; readonly status: 200; readonly value: A }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly problem: ReturnType<typeof problemBody>;
    }
  | { readonly ok: false; readonly status: 500; readonly code: "defect"; readonly defect: string };

/**
 * The script client of the backend at `origin`.
 *
 * @remarks
 * `call` sends one RPC with the headers given, such as a person's `cookie` and the dashboard
 * `origin`, and never rejects for an RPC failure: a declared problem answers its code and the
 * registry status of that code, and a defect or transport failure answers `defect`. `dispose`
 * releases the client.
 */
export const makeScriptClient = (origin: string) => {
  const runtime = ManagedRuntime.make(nativeRpcClientLayer(origin));

  const call = <A, E>(
    headers: Readonly<Record<string, string>>,
    rpc: (client: NativeRpcClient["Service"]) => Effect.Effect<A, E>,
  ): Promise<ScriptCallResult<A>> =>
    runtime
      .runPromiseExit(NativeRpcClient.use(rpc).pipe(withForwardedHeaders(headers)))
      .then((exit): ScriptCallResult<A> => {
        if (Exit.isSuccess(exit)) return { ok: true, status: 200, value: exit.value };

        const failure = Cause.squash(exit.cause);

        return isProblem(failure)
          ? { ok: false, status: failure.status, code: failure.code, problem: problemBody(failure) }
          : { ok: false, status: 500, code: "defect", defect: String(failure) };
      });

  return { call, dispose: () => runtime.dispose() };
};
