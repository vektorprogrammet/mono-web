import { DepartmentId } from "@vektorprogrammet/http-api"
import { SchoolDirectorySchema } from "@vektorprogrammet/http-api"
import { Tabs } from "@foldkit/ui";
import { Schema as S } from "effect";
import { taggedStruct } from "foldkit/schema";
import { SchoolDirectoryFailure, SchoolDirectoryRequestId } from "./model";

export const RetriedDirectory = taggedStruct("RetriedDirectory", {});

export const UpdatedSearch = taggedStruct("UpdatedSearch", { value: S.String });

export const SelectedDepartment = taggedStruct("SelectedDepartment", {
  department: S.NullOr(DepartmentId),
});

export const GotDirectoryTabMessage = taggedStruct("GotDirectoryTabMessage", {
  message: Tabs.Message,
});

export const SucceededDirectory = taggedStruct("SucceededDirectory", {
  requestId: SchoolDirectoryRequestId,
  department: S.NullOr(DepartmentId),
  directory: SchoolDirectorySchema,
});

export const FailedDirectory = taggedStruct("FailedDirectory", {
  requestId: SchoolDirectoryRequestId,
  department: S.NullOr(DepartmentId),
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
