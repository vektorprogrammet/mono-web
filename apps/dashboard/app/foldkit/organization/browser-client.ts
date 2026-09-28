import type {
  DepartmentJson,
  FieldOfStudyJson,
  NativeRpcClient,
  TeamJson,
} from "@vektorprogrammet/rpc";
import type { Effect } from "effect";
import { callBrowserNative, type NativeAnswerInvalid } from "../../lib/browser-native";

type NativeClient = NativeRpcClient["Service"];

/** The failure of one native RPC call: its declared problems, transport errors, and an invalid answer. */
type RpcFailure<Tag extends keyof NativeClient> =
  | Effect.Error<ReturnType<NativeClient[Tag]>>
  | NativeAnswerInvalid;

export interface OrganizationCatalogOperations {
  readonly listDepartments: Effect.Effect<
    readonly DepartmentJson[],
    RpcFailure<"organization.listDepartments">
  >;
  readonly listTeams: Effect.Effect<readonly TeamJson[], RpcFailure<"organization.listTeams">>;
  readonly listFieldOfStudies: Effect.Effect<
    readonly FieldOfStudyJson[],
    RpcFailure<"organization.listFieldOfStudies">
  >;
}

export interface OrganizationCatalogClient {
  readonly organization: OrganizationCatalogOperations;
}

export const createBrowserOrganizationCatalogClient = (): OrganizationCatalogClient => ({
  organization: {
    listDepartments: callBrowserNative((client) => client["organization.listDepartments"]()),
    listTeams: callBrowserNative((client) => client["organization.listTeams"]()),
    listFieldOfStudies: callBrowserNative((client) => client["organization.listFieldOfStudies"]()),
  },
});
