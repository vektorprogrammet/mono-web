import { data } from "react-router";
import {
  bridgeFailureFrom,
  decodeOperationRequest,
  responseHeaders,
  runOperation,
  statusForInvitationFailure,
} from "../lib/interview-bridge.server";
import type { Route } from "./+types/__foldkit.interview";

export async function action({ request }: Route.ActionArgs) {
  try {
    const operation = await decodeOperationRequest(request);
    const result = await runOperation(request, operation);

    return operation.operation === "readInvitationResponse"
      ? data(result, { headers: responseHeaders })
      : new Response(null, { status: 204, headers: responseHeaders });
  } catch (error) {
    const failure = bridgeFailureFrom(error);

    return data(failure, {
      status: statusForInvitationFailure(failure),
      headers: responseHeaders,
    });
  }
}
