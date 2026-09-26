import { Schema } from "effect";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const parseDisposableCohortDatabaseUrl = (
  value: string | undefined,
  pathnamePattern: RegExp,
  invalid: () => Error,
): string => {
  try {
    const url = new URL(value!);

    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      !pathnamePattern.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw invalid();

    return url.toString();
  } catch (cause) {
    throw cause instanceof Error && cause.message === "InvalidSnapshot" ? cause : invalid();
  }
};

export const readPrivateCohortJson = async (
  path: string | undefined,
  invalid: () => Error,
  maxBytes = 1_048_576,
): Promise<Schema.Json> => {
  if (!path) throw invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const stat = await file.stat();

    if (
      !stat.isFile() ||
      stat.size > maxBytes ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw invalid();

    return Schema.decodeSync(Schema.fromJsonString(Schema.Json))(await file.readFile("utf8"));
  } catch (cause) {
    throw cause instanceof Error && cause.message === "InvalidSnapshot" ? cause : invalid();
  } finally {
    await file.close();
  }
};
