import {
  DepartmentId,
  SchoolId,
  SchoolManagement,
  SchoolCommand,
} from "@vektorprogrammet/http-api";
import { SchoolDirectoryDepartmentSchema, SchoolDirectorySchema } from "@vektorprogrammet/http-api";
import { Tabs } from "@foldkit/ui";
import { Schema as S } from "effect";
import { AsyncData } from "foldkit";

export const SchoolDirectoryRequestId = S.Int.check(S.isGreaterThanOrEqualTo(1));

export const SchoolDirectoryTab = S.Literals(["Active", "Inactive"]);

export type SchoolDirectoryTab = S.Schema.Type<typeof SchoolDirectoryTab>;

export const SchoolDirectoryFailure = S.TaggedUnion({
  Denied: { message: S.String },
  Failed: { message: S.String },
});

export type SchoolDirectoryFailure = S.Schema.Type<typeof SchoolDirectoryFailure>;

export const SchoolDirectoryData = AsyncData.Schema(SchoolDirectorySchema, SchoolDirectoryFailure);

export const SchoolDirectoryTabs = Tabs.create<SchoolDirectoryTab>();

export const SchoolMutation = S.TaggedUnion({
  Idle: {},
  Pending: { command: SchoolCommand },
  Failed: { command: SchoolCommand, message: S.String },
  Conflict: { message: S.String },
  Saved: { message: S.String },
  Invalid: { message: S.String },
});

export const SchoolForm = S.Struct({
  name: S.String,
  contactPerson: S.String,
  email: S.String,
  phone: S.String,
  language: S.Literals(["Norwegian", "International"]),
  active: S.Boolean,
  departmentIds: S.Array(DepartmentId),
  reason: S.String,
});

export const CapacityForm = S.Struct({
  departmentId: S.String,
  semesterId: S.String,
  monday: S.String,
  tuesday: S.String,
  wednesday: S.String,
  thursday: S.String,
  friday: S.String,
});

export const emptySchoolForm = (): typeof SchoolForm.Type => ({
  name: "",
  contactPerson: "",
  email: "",
  phone: "",
  language: "Norwegian",
  active: true,
  departmentIds: [],
  reason: "",
});

export const emptyCapacityForm = (): typeof CapacityForm.Type => ({
  departmentId: "",
  semesterId: "",
  monday: "0",
  tuesday: "0",
  wednesday: "0",
  thursday: "0",
  friday: "0",
});

export const Model = S.Struct({
  management: S.NullOr(SchoolManagement),
  managementStatus: S.Literals(["Loading", "Ready", "Denied", "Failed"]),
  managementOpen: S.Boolean,
  managementRequestId: S.Int,
  commandId: S.String,
  selectedSchool: S.NullOr(SchoolId),
  schoolForm: SchoolForm,
  capacityForm: CapacityForm,
  mutation: SchoolMutation,
  directory: SchoolDirectoryData.schema,
  requestId: SchoolDirectoryRequestId,
  retryCount: S.Int.check(S.isGreaterThanOrEqualTo(0)),
  selectedTab: SchoolDirectoryTab,
  tabs: Tabs.Model,
  searchText: S.String,
  department: S.NullOr(DepartmentId),
  knownDepartments: S.Array(SchoolDirectoryDepartmentSchema),
});

export type Model = S.Schema.Type<typeof Model>;

export const init = (department: S.Schema.Type<typeof DepartmentId> | null = null): Model => ({
  management: null,
  managementStatus: "Loading",
  managementOpen: false,
  managementRequestId: 1,
  commandId: "",
  selectedSchool: null,
  schoolForm: emptySchoolForm(),
  capacityForm: emptyCapacityForm(),
  mutation: SchoolMutation.cases.Idle.make({}),
  directory: SchoolDirectoryData.Loading(),
  requestId: 1,
  retryCount: 0,
  selectedTab: "Active",
  tabs: Tabs.init({ id: "schools-directory-tabs", activationMode: "Automatic" }),
  searchText: "",
  department,
  knownDepartments: [],
});
