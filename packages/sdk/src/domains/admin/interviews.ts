/**
 * Admin interviews domain — list, schedule, conduct, cancel, schemas.
 *
 * Endpoints:
 *   GET  /api/admin/interviews
 *   POST /api/admin/interviews/assign
 *   POST /api/admin/interviews/{id}/schedule
 *   POST /api/admin/interviews/{id}/conduct
 *   PUT  /api/admin/interviews/{id}/cancel
 *   GET  /api/admin/interview-schemas
 */

import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import { NotFound, Validation, type InternalSdkError } from "../../errors.js"
import {
  AdminInterviewListFromRaw,
  Interview,
  InterviewId,
  InterviewScheduleInput,
  InterviewSchema_,
  type InterviewScheduleInput as InterviewScheduleInputType,
} from "../../schemas/interview.js"

type InterviewList = {
  readonly items: Interview[]
  readonly totalItems: number
}

export interface AdminInterviewsDomain {
  list(params?: {
    department?: number
    semester?: number
  }): Effect.Effect<InterviewList, InternalSdkError>
  read(id: number): Effect.Effect<Interview, InternalSdkError>

  assign(
    applicationId: number,
    interviewerId: number,
    schemaId: number,
  ): Effect.Effect<void, InternalSdkError>

  schedule(
    id: number,
    input: InterviewScheduleInputType,
  ): Effect.Effect<void, InternalSdkError>

  conduct(
    id: number,
    score: number | null,
    answers: Record<string, string>,
  ): Effect.Effect<void, InternalSdkError>

  cancel(id: number): Effect.Effect<void, InternalSdkError>

  schemas(): Effect.Effect<readonly typeof InterviewSchema_.Type[], InternalSdkError>
}

const invalidInput = (cause: unknown): Validation =>
  new Validation({
    message: cause instanceof Error ? `Invalid interview input: ${cause.message}` : "Invalid interview input",
    fields: {},
  })

export function createAdminInterviewsDomain(transport: Transport): AdminInterviewsDomain {
  const list = (params?: {
    department?: number
    semester?: number
  }): Effect.Effect<InterviewList, InternalSdkError> => {
    const query: Record<string, string | number | undefined> = {
      department: params?.department,
      semester: params?.semester,
    }
    return transport.get("/api/admin/interviews", AdminInterviewListFromRaw, query).pipe(
      Effect.map(({ interviews }) => ({
        items: Array.from(interviews),
        totalItems: interviews.length,
      })),
    )
  }

  return {
    list,

    read(id) {
      return Schema.decodeUnknownEffect(InterviewId)(id).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap((validId) =>
          list().pipe(
            Effect.flatMap(({ items }) => {
              const interview = items.find((candidate) => candidate.id === validId)
              return interview === undefined
                ? Effect.fail(new NotFound({ message: "Interview not found" }))
                : Effect.succeed(interview)
            }),
          ),
        ),
      )
    },

    assign(applicationId, interviewerId, schemaId) {
      return transport.postVoid("/api/admin/interviews/assign", {
        applicationId,
        interviewerId,
        interviewSchemaId: schemaId,
      })
    },

    schedule(id, input) {
      return Effect.all({
        interviewId: Schema.decodeUnknownEffect(InterviewId)(id),
        input: Schema.decodeUnknownEffect(InterviewScheduleInput)(input),
      }).pipe(
        Effect.mapError(invalidInput),
        Effect.flatMap(({ interviewId, input: validInput }) =>
          transport.postVoid(`/api/admin/interviews/${interviewId}/schedule`, validInput),
        ),
      )
    },

    conduct(id, score, answers) {
      return transport.postVoid(`/api/admin/interviews/${id}/conduct`, { score, answers })
    },

    cancel(id) {
      return transport.put(`/api/admin/interviews/${id}/cancel`, {})
    },

    schemas() {
      return transport
        .getCollection("/api/admin/interview-schemas", InterviewSchema_)
        .pipe(Effect.map(({ items }) => items))
    },
  }
}
