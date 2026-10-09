import { ArticleId } from "@vektorprogrammet/domain/content";
import { Schema } from "effect";

/**
 * An article id read as PostgreSQL text: the read selects `article_id::text`.
 *
 * `article_id` is a bigint identity whose check constraint admits every safe integer, as ArticleId
 * does. The native client decodes an int8 as a bigint, and `CAST(article_id AS integer)` fails with
 * "integer out of range" above 2147483647, so the id crosses as text and decodes to ArticleId.
 */
export const ArticleIdFromText = Schema.FiniteFromString.pipe(Schema.decodeTo(ArticleId));
