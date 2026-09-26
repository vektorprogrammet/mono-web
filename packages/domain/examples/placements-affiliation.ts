import assert from "node:assert/strict";
import { nextAffiliationStatus } from "@vektorprogrammet/domain/placements";

const requested = nextAffiliationStatus("Absent", "Request");

assert.equal(requested, "Pending");

const repeated = nextAffiliationStatus(requested, "Request");

assert.equal(repeated, null);

// A rejected transition leaves the caller's current status unchanged.
const current = repeated ?? requested;

assert.equal(current, "Pending");

assert.equal(nextAffiliationStatus(current, "Withdraw"), "Inactive");

console.log("Absent -> Pending; repeated Request rejected; Withdraw -> Inactive");
