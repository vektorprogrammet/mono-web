import { ContentAuthorityInactive, ContentNotInScope } from "@vektorprogrammet/sdk/effect";
import { describe, expect, it } from "vitest";
import { failureFrom } from "./command";

describe("Content workspace failure classification", () => {
  it("renders internal Content denial tags as denials", () => {
    expect(failureFrom(new ContentAuthorityInactive())).toEqual({
      _tag: "Denied",
      message: "Tilgangen din til artikkeladministrasjon er ikke aktiv.",
    });
    expect(failureFrom(new ContentNotInScope())).toEqual({
      _tag: "Denied",
      message: "Du har ikke tilgang til artikkeladministrasjon.",
    });
  });
});
