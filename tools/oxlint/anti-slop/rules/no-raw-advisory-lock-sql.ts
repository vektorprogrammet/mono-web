import { defineRule } from "@oxlint/plugins";

// A PostgreSQL advisory-lock call, such as `pg_advisory_xact_lock(`.
const ADVISORY_LOCK_CALL = /\bpg_(?:try_)?advisory_[a-z_]*\s*\(/iu;

/** Ban hand-written advisory-lock SQL in favor of the registered-key construct. */
export const noRawAdvisoryLockSqlRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow PostgreSQL advisory-lock calls in string and template text, such as SQL templates and query strings; take the lock through `lockAdvisory` with a registered `AdvisoryLockKey`.",
    },
    messages: {
      rawAdvisoryLock:
        "Take this lock with `lockAdvisory` or `tryLockAdvisory` from `@vektorprogrammet/database/advisory-lock` and a named `AdvisoryLockKey`. Hand-written advisory-lock SQL copies key text that migrations and other writers must match byte for byte.",
    },
  },
  createOnce(context) {
    return {
      TemplateElement(node) {
        if (ADVISORY_LOCK_CALL.test(node.value.raw)) {
          context.report({ node, messageId: "rawAdvisoryLock" });
        }
      },
      Literal(node) {
        if (
          typeof node.value === "string" &&
          ADVISORY_LOCK_CALL.test(node.value)
        ) {
          context.report({ node, messageId: "rawAdvisoryLock" });
        }
      },
    };
  },
});
