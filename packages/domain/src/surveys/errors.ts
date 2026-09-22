import { Data } from "effect";

export class SchoolSurveyDecodeError extends Data.TaggedError("SchoolSurveyDecodeError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class SchoolSurveyPersistenceError extends Data.TaggedError("SchoolSurveyPersistenceError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** The requested survey is absent or has a non-school target audience. */
export class SchoolSurveyNotFound extends Data.TaggedError("SchoolSurveyNotFound")<{
  readonly surveyId: string;
}> {}

/** Transactional participant input failed without creating a response. */
export class SchoolSurveyValidationFailed extends Data.TaggedError("SchoolSurveyValidationFailed")<{
  readonly surveyId: string;
  readonly field: string;
}> {}

/** The selected department is not admitted for the selected semester. */
export class SchoolSurveyScopeInvalid extends Data.TaggedError("SchoolSurveyScopeInvalid")<{
  readonly departmentId: string;
  readonly semesterId: string;
}> {}

/** A close command did not observe the revision currently stored by PostgreSQL. */
export class SchoolSurveyStaleRevision extends Data.TaggedError("SchoolSurveyStaleRevision")<{
  readonly surveyId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
}> {}

/** A lifecycle operation is not permitted from the survey's current state. */
export class SchoolSurveyInvalidState extends Data.TaggedError("SchoolSurveyInvalidState")<{
  readonly surveyId: string;
  readonly state: "Open" | "Closed";
}> {}

/** One command identity was reused for a different durable survey command. */
export class SchoolSurveyCommandConflict extends Data.TaggedError("SchoolSurveyCommandConflict")<{
  readonly commandId: string;
}> {}

export type SchoolSurveyFailure =
  | SchoolSurveyDecodeError
  | SchoolSurveyPersistenceError
  | SchoolSurveyNotFound
  | SchoolSurveyValidationFailed
  | SchoolSurveyScopeInvalid
  | SchoolSurveyStaleRevision
  | SchoolSurveyInvalidState
  | SchoolSurveyCommandConflict;
