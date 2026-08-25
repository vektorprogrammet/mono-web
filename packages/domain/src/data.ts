import { Effect, Result, Schema } from "effect";
import { DomainFileSystem, joinPath, readTextFile } from "./runtime-services.js";
import {
  decodeDepartment,
  decodeGlobalContainer,
  decodeGlobalMembership,
  decodeRows,
  decodeTeam,
  decodeTeamMembership,
  type DecodeFailure,
  type DecodeResult,
  type DepartmentRow,
  type GlobalContainerRow,
  type GlobalMembershipRow,
  SchemaInputError,
  type TeamMembershipRow,
  type TeamRow,
} from "./schema.js";

const JsonUnknownSchema = Schema.fromJsonString(Schema.Unknown);
const PersonAuthorityRowsSchema = Schema.Array(
  Schema.Struct({
    userId: Schema.Int,
    departmentIds: Schema.Array(Schema.Int),
  }),
);

export const REQUIRED_FILES = [
  "department.json",
  "team.json",
  "team_membership.json",
  "executive_board.json",
  "executive_board_membership.json",
] as const;

export type RequiredFile = (typeof REQUIRED_FILES)[number];

export type DatasetErrorCode =
  | "INVALID_ARGUMENT"
  | "MISSING_INPUT"
  | "READ_FAILED"
  | "INVALID_JSON"
  | "INVALID_ARRAY"
  | "INVALID_PERSON_AUTHORITY"
  | "DUPLICATE_PERSON_AUTHORITY";

export class DatasetInputError extends Error {
  readonly code: DatasetErrorCode;
  readonly file: string;

  constructor(code: DatasetErrorCode, file: string, message = `${code}:${file}`) {
    super(message);
    this.name = "DatasetInputError";
    this.code = code;
    this.file = file;
  }
}

export interface RawDatasetInput {
  readonly departments: unknown;
  readonly teams: unknown;
  readonly teamMemberships: unknown;
  readonly executiveBoards: unknown;
  readonly globalMemberships: unknown;
}

export interface PersonAuthorityProjection {
  readonly departmentIdsByUser: ReadonlyMap<number, ReadonlySet<number>>;
  readonly userIds: ReadonlySet<number>;
}

export interface DuplicateIds {
  readonly departments: ReadonlyArray<number>;
  readonly teams: ReadonlyArray<number>;
  readonly executiveBoards: ReadonlyArray<number>;
}

export interface DatasetFileSummary {
  readonly file: RequiredFile;
  readonly rows: number;
}

export interface DatasetInputSummary {
  readonly files: ReadonlyArray<DatasetFileSummary>;
  readonly decodeFailures: ReadonlyArray<DecodeFailure>;
  readonly duplicateIds: DuplicateIds;
}

export interface Dataset {
  readonly departments: ReadonlyArray<DepartmentRow>;
  readonly teams: ReadonlyArray<TeamRow>;
  readonly teamMemberships: ReadonlyArray<TeamMembershipRow>;
  readonly executiveBoards: ReadonlyArray<GlobalContainerRow>;
  readonly globalMemberships: ReadonlyArray<GlobalMembershipRow>;
  readonly departmentById: ReadonlyMap<number, DepartmentRow>;
  readonly teamById: ReadonlyMap<number, TeamRow>;
  readonly executiveBoardById: ReadonlyMap<number, GlobalContainerRow>;
  readonly duplicateIds: DuplicateIds;
  readonly decodeFailures: ReadonlyArray<DecodeFailure>;
  readonly input: DatasetInputSummary;
}

const duplicateSafeMap = <A extends { readonly id: number }>(
  rows: ReadonlyArray<A>,
): { readonly map: ReadonlyMap<number, A>; readonly duplicates: ReadonlyArray<number> } => {
  const map = new Map<number, A>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (duplicates.has(row.id)) continue;
    if (map.has(row.id)) {
      map.delete(row.id);
      duplicates.add(row.id);
      continue;
    }
    map.set(row.id, row);
  }
  return { map, duplicates: [...duplicates].sort((left, right) => left - right) };
};

const decodeCollection = <A>(
  value: unknown,
  file: RequiredFile,
  decoder: (value: unknown) => DecodeResult<A>,
): { readonly rows: ReadonlyArray<A>; readonly failures: ReadonlyArray<DecodeFailure> } => {
  try {
    return decodeRows(value, file, decoder);
  } catch (error: unknown) {
    if (error instanceof SchemaInputError) {
      throw new DatasetInputError(error.code, file, error.message);
    }
    throw error;
  }
};

export const buildDataset = (input: RawDatasetInput): Dataset => {
  const departments = decodeCollection(input.departments, "department.json", decodeDepartment);
  const teams = decodeCollection(input.teams, "team.json", decodeTeam);
  const teamMemberships = decodeCollection(
    input.teamMemberships,
    "team_membership.json",
    decodeTeamMembership,
  );
  const executiveBoards = decodeCollection(
    input.executiveBoards,
    "executive_board.json",
    decodeGlobalContainer,
  );
  const globalMemberships = decodeCollection(
    input.globalMemberships,
    "executive_board_membership.json",
    decodeGlobalMembership,
  );

  const departmentMap = duplicateSafeMap(departments.rows);
  const teamMap = duplicateSafeMap(teams.rows);
  const executiveBoardMap = duplicateSafeMap(executiveBoards.rows);
  const decodeFailures = [
    ...departments.failures,
    ...teams.failures,
    ...teamMemberships.failures,
    ...executiveBoards.failures,
    ...globalMemberships.failures,
  ];
  const duplicateIds: DuplicateIds = {
    departments: departmentMap.duplicates,
    teams: teamMap.duplicates,
    executiveBoards: executiveBoardMap.duplicates,
  };
  const files: ReadonlyArray<DatasetFileSummary> = [
    { file: "department.json", rows: departments.rows.length },
    { file: "team.json", rows: teams.rows.length },
    { file: "team_membership.json", rows: teamMemberships.rows.length },
    { file: "executive_board.json", rows: executiveBoards.rows.length },
    { file: "executive_board_membership.json", rows: globalMemberships.rows.length },
  ];
  return {
    departments: departments.rows,
    teams: teams.rows,
    teamMemberships: teamMemberships.rows,
    executiveBoards: executiveBoards.rows,
    globalMemberships: globalMemberships.rows,
    departmentById: departmentMap.map,
    teamById: teamMap.map,
    executiveBoardById: executiveBoardMap.map,
    duplicateIds,
    decodeFailures,
    input: { files, decodeFailures, duplicateIds },
  };
};

const readErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const readJson = (
  dataDir: string,
  file: RequiredFile,
): Effect.Effect<unknown, DatasetInputError, DomainFileSystem> =>
  joinPath(dataDir, file).pipe(
    Effect.flatMap(readTextFile),
    Effect.mapError(
      (error) =>
        new DatasetInputError(
          readErrorCode(error) === "ENOENT" ? "MISSING_INPUT" : "READ_FAILED",
          file,
          readErrorCode(error) === "ENOENT"
            ? "required sanitized input file is missing"
            : "required sanitized input file could not be read",
        ),
    ),
    Effect.flatMap((source) => {
      const decoded = Schema.decodeUnknownResult(JsonUnknownSchema)(source);
      return Result.isSuccess(decoded)
        ? Effect.succeed(decoded.success)
        : Effect.fail(new DatasetInputError("INVALID_JSON", file, "input file is not valid JSON"));
    }),
  );

export const loadDatasetEffect = (
  dataDir: string,
): Effect.Effect<Dataset, DatasetInputError, DomainFileSystem> => {
  if (dataDir.trim().length === 0) {
    return Effect.fail(
      new DatasetInputError(
        "INVALID_ARGUMENT",
        "dataDir",
        "dataDir must be an explicit non-empty path",
      ),
    );
  }
  return Effect.gen(function* () {
    const departments = yield* readJson(dataDir, "department.json");
    const teams = yield* readJson(dataDir, "team.json");
    const teamMemberships = yield* readJson(dataDir, "team_membership.json");
    const executiveBoards = yield* readJson(dataDir, "executive_board.json");
    const globalMemberships = yield* readJson(dataDir, "executive_board_membership.json");
    return buildDataset({
      departments,
      teams,
      teamMemberships,
      executiveBoards,
      globalMemberships,
    });
  });
};

export const loadDataset = loadDatasetEffect;

export const authorityFromEntries = (
  entries: ReadonlyArray<readonly [number, ReadonlyArray<number>]>,
): PersonAuthorityProjection => {
  const departmentIdsByUser = new Map<number, ReadonlySet<number>>();
  const userIds = new Set<number>();
  for (const [userId, departments] of entries) {
    userIds.add(userId);
    departmentIdsByUser.set(userId, new Set(departments));
  }
  return { departmentIdsByUser, userIds };
};

export const loadPersonAuthorityEffect = (
  filePath: string,
): Effect.Effect<PersonAuthorityProjection, DatasetInputError, DomainFileSystem> =>
  readTextFile(filePath).pipe(
    Effect.mapError(
      (error) =>
        new DatasetInputError(
          readErrorCode(error) === "ENOENT" ? "MISSING_INPUT" : "READ_FAILED",
          "person-authority",
          readErrorCode(error) === "ENOENT"
            ? "person authority file is missing"
            : "person authority file could not be read",
        ),
    ),
    Effect.flatMap((source) => {
      const parsed = Schema.decodeUnknownResult(JsonUnknownSchema)(source);
      if (!Result.isSuccess(parsed)) {
        return Effect.fail(
          new DatasetInputError(
            "INVALID_JSON",
            "person-authority",
            "person authority file is not valid JSON",
          ),
        );
      }
      const decoded = Schema.decodeUnknownResult(PersonAuthorityRowsSchema, {
        onExcessProperty: "error",
      })(parsed.success);
      if (!Result.isSuccess(decoded)) {
        return Effect.fail(
          new DatasetInputError(
            "INVALID_PERSON_AUTHORITY",
            "person-authority",
            "person authority file is invalid",
          ),
        );
      }

      const entries: Array<readonly [number, ReadonlyArray<number>]> = [];
      const seen = new Set<number>();
      for (const row of decoded.success) {
        if (seen.has(row.userId)) {
          return Effect.fail(
            new DatasetInputError(
              "DUPLICATE_PERSON_AUTHORITY",
              "person-authority",
              "person authority user is duplicated",
            ),
          );
        }
        seen.add(row.userId);
        entries.push([row.userId, row.departmentIds]);
      }
      return Effect.succeed(authorityFromEntries(entries));
    }),
  );

export const loadPersonAuthority = loadPersonAuthorityEffect;
