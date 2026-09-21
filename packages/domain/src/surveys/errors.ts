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

export type SchoolSurveyFailure =
  | SchoolSurveyDecodeError
  | SchoolSurveyPersistenceError
  | SchoolSurveyNotFound
  | SchoolSurveyValidationFailed;
