import { defineRule } from "@oxlint/plugins";

// The persisted leadership flag of an appointment in SQL text.
const LEADERSHIP_COLUMN = /\bis_team_leader\b/u;

/**
 * Keep unit leadership inside the reach interpreter. Department reach comes from a board
 * leadership, a national board leadership or a delegation (O8-11); a leadership flag read
 * anywhere else grants reach that the interpreter does not know about.
 */
export const noLeadershipReachRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading a unit leadership flag (`unitLeader`, SQL `is_team_leader`) outside the organisational reach interpreter.",
    },
    messages: {
      leadershipRead:
        "Ask `reaches`, `reachedDepartments`, `leadsUnit` or `leadsAnyTeam` in `packages/domain/src/authz/reach.ts` instead of reading a leadership flag. A leadership read here decides authority outside the one interpreter.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "unitLeader"
        ) {
          context.report({ node, messageId: "leadershipRead" });
        }
      },
      ObjectPattern(node) {
        for (const property of node.properties) {
          if (
            property.type === "Property" &&
            property.key.type === "Identifier" &&
            property.key.name === "unitLeader"
          ) {
            context.report({ node: property, messageId: "leadershipRead" });
          }
        }
      },
      TemplateElement(node) {
        if (LEADERSHIP_COLUMN.test(node.value.raw)) {
          context.report({ node, messageId: "leadershipRead" });
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && LEADERSHIP_COLUMN.test(node.value)) {
          context.report({ node, messageId: "leadershipRead" });
        }
      },
    };
  },
});
