/**
 * Spec 0072 — representative preview scenario runner.
 *
 * Composes the existing seed surfaces into one small synthetic scenario shaped
 * like the deployed legacy organization (steering: NTNU/UiB/NMBU departments,
 * legacy team titles, @example.invalid contacts, legacy-register article and
 * receipt wording). Everything enters through native boundaries:
 *
 *   - identity:seed (better-auth engine, caller-supplied PersonIds)
 *   - POST /api/admin/departments|teams      (native Organization administration)
 *   - Organization.importLegacyOrganization  (memberships — no native create command)
 *   - POST /api/admin/admission-periods      (CreateAdmissionPeriod)
 *   - POST /api/applications                 (public application submit)
 *   - POST /api/admin/recruitment/interviews/assign
 *   - POST /api/receipts/submit              (multipart, payment authority prerequisite)
 *   - POST /api/admin/content/articles + /{id}/publish
 *
 * Named prerequisites (recorded, never silent): admission semester row (0049
 * journey-seed precedent), economy_payment_authorities row, schools_directory
 * rows (no native write command exists).
 *
 * Usage:
 *   PREVIEW_SCENARIO_PG_URL='postgres://postgres@127.0.0.1:5435/preview_scenario' \
 *     bun infra/host/preview-scenario.ts
 *
 * Idempotent: safe re-run, every command replay returns replayed:true and
 * business-table counts stay stable. Loopback-only, disposable databases only.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const databaseRequire = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
);
const { Pool } = databaseRequire("pg");

const postgresUrl =
  process.env.PREVIEW_SCENARIO_PG_URL ?? "postgres://postgres@127.0.0.1:5435/preview_scenario";

// Loopback-only + production-host guard (spec 0072 falsifier 4).
const parsedUrl = new URL(postgresUrl);
assert.ok(
  parsedUrl.protocol === "postgres:" || parsedUrl.protocol === "postgresql:",
  "preview scenario seed requires PostgreSQL",
);
assert.ok(
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedUrl.hostname),
  "preview scenario seed is restricted to loopback PostgreSQL",
);
assert.ok(!parsedUrl.hostname.endsWith("vektorprogrammet.no"), "production hosts are forbidden");

// --- Legacy-aligned scenario values (steering: legacy shapes, synthetic data) ---
const persons = {
  admin: {
    personId: "preview-0072-admin",
    firstName: "An",
    lastName: "Administrator",
    email: "admin.preview.0072@example.invalid",
    password: "preview-0072-admin-password",
  },
  leader: {
    personId: "preview-0072-leader",
    firstName: "Lina",
    lastName: "Leder",
    email: "lina.leader.preview.0072@example.invalid",
    password: "preview-0072-leader-password",
  },
  member: {
    personId: "preview-0072-member",
    firstName: "Ming",
    lastName: "Medlem",
    email: "ming.medlem.preview.0072@example.invalid",
    password: "preview-0072-member-password",
  },
  interviewer: {
    personId: "preview-0072-interviewer",
    firstName: "Irene",
    lastName: "Intervjuer",
    email: "irene.intervjuer.preview.0072@example.invalid",
    password: "preview-0072-interviewer-password",
  },
  receiptOwner: {
    personId: "preview-0072-owner",
    firstName: "Ulla",
    lastName: "Utleggsier",
    email: "ulla.utlegg.preview.0072@example.invalid",
    password: "preview-0072-owner-password",
  },
  author: {
    personId: "preview-0072-author",
    firstName: "Erik",
    lastName: "Forfatter",
    email: "erik.forfatter.preview.0072@example.invalid",
    password: "preview-0072-author-password",
  },
} as const;

const departmentId = "preview-0072-department-trondheim";
const semesterId = "preview-0072-semester";
const admissionPeriodCommandId = "preview-0072-period-command";
const fieldOfStudyId = "preview-0072-fos-datateknologi";
const recruitmentTeamCommandId = "preview-0072-team-rekruttering-command";
const applicantEmail = "sofie.soker.preview.0072@example.invalid";
const applicationCommandId = "preview-0072-application-command";
const assignmentCommandId = "preview-0072-assignment-command";
const interviewSchemaId = "preview-0072-interview-schema";
const receiptCommandId = "preview-0072-receipt-command";
const draftCommandId = "preview-0072-draft-command";
const publishCommandId = "preview-0072-publish-command";
const snapshotId = "sha256:preview-0072-membership-snapshot";

// Wide window brackets "now" so the period stays OPEN and memberships stay
// ACTIVE across re-runs for years (real clock, no fixed-now requirement).
const semesterStartAt = "2026-01-01T00:00:00.000Z";
const semesterEndAt = "2037-01-01T00:00:00.000Z";
const periodStartAt = "2026-08-01T00:00:00.000Z";
const periodEndAt = "2036-12-31T23:59:59.999Z";
const membershipStartAt = "2026-01-01T00:00:00.000Z";
const receiptDate = "2026-08-20";
const receiptBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
