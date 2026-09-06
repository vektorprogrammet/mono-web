import { Schema } from "effect";
import { DepartmentId, PersonId, SemesterId } from "../organization/schema.js";
import { SchoolId } from "../schools/schema.js";
export const PlacementScope = Schema.Struct({ departmentId: DepartmentId, semesterId: SemesterId });
export const AffiliationScope = Schema.Struct({ departmentId: DepartmentId });
export const AffiliationStatus = Schema.Literals(["Absent", "Pending", "Active", "Inactive"]);
export const Affiliation = Schema.Struct({
  personId: PersonId,
  departmentId: DepartmentId,
  status: AffiliationStatus,
  revision: Schema.Int,
});
export const PlacementValues = Schema.Struct({
  schoolId: SchoolId,
  day: Schema.Literals(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]),
  workdays: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  block: Schema.Literals(["1", "2", "Both"]),
});
export const PlacementId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^placement-[a-f0-9]{64}$/)),
);
export const Placement = Schema.Struct({
  ...PlacementScope.fields,
  ...PlacementValues.fields,
  placementId: PlacementId,
  personId: PersonId,
  active: Schema.Boolean,
  revision: Schema.Int,
  firstName: Schema.String,
  lastName: Schema.String,
  schoolName: Schema.String,
});
export const PlacementBoard = Schema.Struct({
  ...PlacementScope.fields,
  affiliations: Schema.Array(
    Schema.Struct({ ...Affiliation.fields, firstName: Schema.String, lastName: Schema.String }),
  ),
  placements: Schema.Array(Placement),
  schools: Schema.Array(Schema.Struct({ schoolId: SchoolId, name: Schema.String })),
});
export const PlacementScopes = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({ departmentId: DepartmentId, name: Schema.String, canManage: Schema.Boolean }),
  ),
  semesters: Schema.Array(
    Schema.Struct({ semesterId: SemesterId, startAt: Schema.String, endAt: Schema.String }),
  ),
});
export const OwnAffiliationCommand = Schema.Struct({
  action: Schema.Literals(["Request", "Withdraw"]),
});
export const PlacementCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("Affiliation"),
    personId: PersonId,
    transition: Schema.Literals(["Establish", "Reject", "Revoke"]),
  }),
  Schema.Struct({
    action: Schema.Literal("Create"),
    personId: PersonId,
    ...PlacementValues.fields,
  }),
  Schema.Struct({
    action: Schema.Literal("Edit"),
    placementId: PlacementId,
    ...PlacementValues.fields,
  }),
  Schema.Struct({ action: Schema.Literal("Remove"), placementId: PlacementId }),
]);
export type PlacementScope = typeof PlacementScope.Type;
export type Affiliation = typeof Affiliation.Type;
export type PlacementCommand = typeof PlacementCommand.Type;
export type OwnAffiliationCommand = typeof OwnAffiliationCommand.Type;
