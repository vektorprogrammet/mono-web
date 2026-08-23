import { Schema as S } from "effect";
import {
  RecruitmentBridgeOperation,
  type RecruitmentBridgeFailure,
  type RecruitmentBridgeOperation as RecruitmentBridgeOperationType,
} from "./bridge";

const MAX_BODY_BYTES = 4_096;

export type RecruitmentBridgeRequestResult =
  | {
      readonly _tag: "Success";
      readonly operation: RecruitmentBridgeOperationType;
    }
  | {
      readonly _tag: "Failure";
      readonly status: number;
      readonly failure: RecruitmentBridgeFailure;
    };

const failure = (
  status: number,
  tag: RecruitmentBridgeFailure["_tag"],
  message: string,
): RecruitmentBridgeRequestResult => ({
  _tag: "Failure",
  status,
  failure: { _tag: tag, message },
});

const readBoundedBody = async (request: Request): Promise<Uint8Array | undefined> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_BODY_BYTES) {
      return undefined;
    }
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const readRecruitmentBridgeOperation = async (
  request: Request,
): Promise<RecruitmentBridgeRequestResult> => {
  if (request.method !== "POST") {
    return failure(405, "Validation", "Recruitment requests must use POST");
  }

  const origin = request.headers.get("origin");
  if (origin === null || origin !== new URL(request.url).origin) {
    return failure(403, "Forbidden", "Recruitment request origin is not allowed");
  }

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return failure(415, "Validation", "Recruitment requests must use application/json");
  }

  const body = await readBoundedBody(request);
  if (body === undefined) {
    return failure(413, "Validation", "Recruitment request body is too large");
  }

  try {
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return {
      _tag: "Success",
      operation: S.decodeUnknownSync(RecruitmentBridgeOperation)(json, {
        onExcessProperty: "error",
      }),
    };
  } catch {
    return failure(422, "Validation", "Recruitment request body is invalid");
  }
};
