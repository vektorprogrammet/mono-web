import { SchoolDepartmentId, SchoolDirectorySchema } from "@vektorprogrammet/sdk/effect";
import { Tabs } from "@foldkit/ui";
import { Schema as S } from "effect";
import { m } from "foldkit/message";
import { SchoolDirectoryFailure, SchoolDirectoryRequestId } from "./model";

export const RetriedDirectory = m("RetriedDirectory");
export const UpdatedSearch = m("UpdatedSearch", { value: S.String });
export const SelectedDepartment = m("SelectedDepartment", {
  department: S.NullOr(SchoolDepartmentId),
});
export const GotDirectoryTabMessage = m("GotDirectoryTabMessage", {
  message: Tabs.Message,
});
export const SucceededDirectory = m("SucceededDirectory", {
  requestId: SchoolDirectoryRequestId,
  department: S.NullOr(SchoolDepartmentId),
  directory: SchoolDirectorySchema,
});
export const FailedDirectory = m("FailedDirectory", {
  requestId: SchoolDirectoryRequestId,
  department: S.NullOr(SchoolDepartmentId),
  failure: SchoolDirectoryFailure,
});

export const Message = S.Union([
  RetriedDirectory,
  UpdatedSearch,
  SelectedDepartment,
  GotDirectoryTabMessage,
  SucceededDirectory,
  FailedDirectory,
]);
export type Message = S.Schema.Type<typeof Message>;
