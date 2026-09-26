import { expect, it } from "vitest";
import { semesterLabel } from "./semester-label";

it("labels canonical semesters with Norwegian local dates rather than UTC dates", () => {
  expect(semesterLabel({ startAt: "2023-12-31T23:00:00Z", endAt: "2024-06-30T21:59:59Z" })).toBe(
    "1. jan. 2024 – 30. juni 2024",
  );
});
