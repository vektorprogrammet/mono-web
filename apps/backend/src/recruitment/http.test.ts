import { RecruitmentInterviewId } from "@vektorprogrammet/domain/recruitment";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { describe, expect, it } from "vitest";
import type { RecruitmentApiConfig } from "./config.js";
import { makeRecruitmentApiHttp } from "./http.js";

const token = "recruitment-token";
const config: RecruitmentApiConfig = {
  tokens: new Map([
    [
      token,
      {
        actor: {
          _tag: "DepartmentLeader",
          personId: PersonId.make("leader-1"),
          departmentId: DepartmentId.make("department-1"),
          active: true,
        },
      },
    ],
  ]),
  maxBodyBytes: 4096,
  now: () => "2031-09-15T12:00:00.000Z",
  nextInterviewId: () => RecruitmentInterviewId.make("interview-1"),
};

const backend = makeRecruitmentApiHttp({
  config,
  run: async <A>(): Promise<A> => undefined as A,
});

const request = (path: string, init?: RequestInit): Promise<Response> =>
  backend.fetch(new Request(`http://backend.test${path}`, init));

describe("native recruitment HTTP boundary", () => {
  it("requires the exact board status query and credentials", async () => {
    const missingStatus = await request("/api/admin/recruitment/assignment-board");
    const missingCredentials = await request(
      "/api/admin/recruitment/assignment-board?status=new",
    );

    expect(missingStatus.status).toBe(422);
    expect(missingCredentials.status).toBe(401);
    expect(missingCredentials.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects excess command properties before executing Recruitment", async () => {
    const response = await request("/api/admin/recruitment/interviews/assign", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        commandId: "command-1",
        applicationId: "application-1",
        interviewerPersonId: "person-1",
        interviewSchemaId: "schema-1",
        unexpected: true,
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { tag: "RecruitmentDecodeError" } });
  });
});
