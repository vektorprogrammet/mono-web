import { describe, expect, it } from "@effect/vitest";
import type { DepartmentId } from "../organization/schema.js";
import { ArticleSlug, type PublishedNewsListing } from "./schema.js";
import { filterNewsListingByDepartment } from "./projection.js";

const departmentA = "department-a" as DepartmentId;
const departmentB = "department-b" as DepartmentId;

const listing: PublishedNewsListing = {
  articles: [
    {
      slug: ArticleSlug.make("organization-wide"),
      title: "Organization wide",
      sticky: true,
      publishedAt: "2031-01-03T00:00:00.000Z",
      authorDisplayName: "Global Publisher",
      departmentIds: [],
      hasImage: false,
    },
    {
      slug: ArticleSlug.make("department-a"),
      title: "Department A",
      sticky: false,
      publishedAt: "2031-01-02T00:00:00.000Z",
      authorDisplayName: "Department Publisher",
      departmentIds: [departmentA],
      hasImage: false,
    },
    {
      slug: ArticleSlug.make("department-b"),
      title: "Department B",
      sticky: false,
      publishedAt: "2031-01-01T00:00:00.000Z",
      authorDisplayName: "Department Publisher",
      departmentIds: [departmentB],
      hasImage: false,
    },
  ],
};

describe("public news department projection", () => {
  it("keeps organization-wide articles and narrows department-scoped articles", () => {
    expect(
      filterNewsListingByDepartment(listing, departmentA).articles.map((article) => article.slug),
    ).toEqual(["organization-wide", "department-a"]);
  });
});
