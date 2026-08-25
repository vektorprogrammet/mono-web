import {
  DepartmentId,
  SchoolDirectoryDepartmentSchema,
  SchoolDirectorySchema,
} from "@vektorprogrammet/sdk/effect";
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

export const Model = S.Struct({
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

export const makeInitialModel = (
  department: S.Schema.Type<typeof DepartmentId> | null = null,
): Model => ({
  directory: SchoolDirectoryData.Loading(),
  requestId: 1,
  retryCount: 0,
  selectedTab: "Active",
  tabs: Tabs.init({ id: "schools-directory-tabs", activationMode: "Automatic" }),
  searchText: "",
  department,
  knownDepartments: [],
});
