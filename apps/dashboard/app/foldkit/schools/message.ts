import { DepartmentId } from "@vektorprogrammet/http-api";
import {
  SchoolDirectorySchema,
  SchoolManagement,
  SchoolCommand,
  SchoolCommandResult,
  SchoolId,
} from "@vektorprogrammet/http-api";
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

export const OpenedManagement = taggedStruct("OpenedManagement", {});

export const RefreshedManagement = taggedStruct("RefreshedManagement", {});

export const SelectedManagedSchool = taggedStruct("SelectedManagedSchool", {
  schoolId: S.NullOr(SchoolId),
});

export const ChangedSchoolField = taggedStruct("ChangedSchoolField", {
  field: S.Literals(["name", "contactPerson", "email", "phone", "language", "active", "reason"]),
  value: S.String,
});

export const ToggledSchoolDepartment = taggedStruct("ToggledSchoolDepartment", {
  departmentId: DepartmentId,
});

export const ChangedCapacityField = taggedStruct("ChangedCapacityField", {
  field: S.Literals([
    "departmentId",
    "semesterId",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
  ]),
  value: S.String,
});

export const SubmittedSchool = taggedStruct("SubmittedSchool", {
  kind: S.Literals(["Facts", "Departments", "Capacity"]),
});

export const RetriedSchoolCommand = taggedStruct("RetriedSchoolCommand", {});

export const DiscardedSchoolFailure = taggedStruct("DiscardedSchoolFailure", {});

export const SucceededManagement = taggedStruct("SucceededManagement", {
  requestId: S.Int,
  data: SchoolManagement,
  commandId: S.String,
});

export const FailedManagement = taggedStruct("FailedManagement", {
  requestId: S.Int,
  denied: S.Boolean,
});

export const SucceededSchoolCommand = taggedStruct("SucceededSchoolCommand", {
  commandId: S.String,
  result: SchoolCommandResult,
});

export const FailedSchoolCommand = taggedStruct("FailedSchoolCommand", {
  command: SchoolCommand,
  conflict: S.Boolean,
  message: S.String,
});

export const Message = S.Union([
  OpenedManagement,
  RefreshedManagement,
  SelectedManagedSchool,
  ChangedSchoolField,
  ToggledSchoolDepartment,
  ChangedCapacityField,
  SubmittedSchool,
  RetriedSchoolCommand,
  DiscardedSchoolFailure,
  SucceededManagement,
  FailedManagement,
  SucceededSchoolCommand,
  FailedSchoolCommand,
  RetriedDirectory,
  UpdatedSearch,
  SelectedDepartment,
  GotDirectoryTabMessage,
  SucceededDirectory,
  FailedDirectory,
]);

export type Message = S.Schema.Type<typeof Message>;
