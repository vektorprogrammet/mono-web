/**
 * The defect boundary of the native RPC contract.
 *
 * @since 0.3.0
 */
import { RpcMiddleware } from "effect/unstable/rpc";
import { problemUnion, rpcProblems } from "./problem.js";

/**
 * Every native RPC runs inside this middleware. The backend reports a defect through
 * `ErrorReporter` and answers internal.error, so no defect, stack, or cause reaches a client. Typed
 * failures and interrupts pass through unchanged.
 */
export class ProblemBoundary extends RpcMiddleware.Service<ProblemBoundary>()(
  "@vektorprogrammet/rpc/ProblemBoundary",
  { error: rpcProblems(problemUnion("InternalProblem", ["internal.error"])) },
) {}
