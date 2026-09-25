import { describe, expect, test } from "vitest";
import { decodePostgresMajors, selectPostgresMajor } from "./index";

describe("engines.postgresql", () => {
  test("decodes the declared majors in ascending order", () => {
    expect(decodePostgresMajors("18")).toEqual([18]);
    expect(decodePostgresMajors("18 || 17")).toEqual([17, 18]);
  });

  test.each(["", "18 ||", "|| 18", "17||18", "17 | 18", "17, 18", "^18", ">=17", "017", "17 || 17"])(
    "rejects %p",
    (declared) => {
      expect(() => decodePostgresMajors(declared)).toThrow();
    },
  );
});

describe("VEKTOR_POSTGRES_MAJOR", () => {
  const supported = decodePostgresMajors("17 || 18");

  test("unset or empty selects the highest supported major", () => {
    expect(selectPostgresMajor(supported, undefined)).toBe(18);
    expect(selectPostgresMajor(supported, "")).toBe(18);
  });

  test("selects a supported major", () => {
    expect(selectPostgresMajor(supported, "17")).toBe(17);
  });

  test.each(["16", "19", "017", " 17", "latest"])("rejects %p and names the supported set", (requested) => {
    expect(() => selectPostgresMajor(supported, requested)).toThrow(
      `VEKTOR_POSTGRES_MAJOR=${requested} is not a supported PostgreSQL major. ` +
        "package.json engines.postgresql supports 17 || 18.",
    );
  });
});
