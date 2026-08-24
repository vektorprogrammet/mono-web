export type DecisionReason = "Unauthenticated" | "NotInScope" | "AuthorityInactive" | "Ambiguous";

export type Decision<A> =
  | { readonly _tag: "Allow"; readonly value: A }
  | { readonly _tag: "Deny"; readonly reason: DecisionReason };

export const allow = <A>(value: A): Decision<A> => ({ _tag: "Allow", value });

export const deny = <A = never>(reason: DecisionReason): Decision<A> => ({
  _tag: "Deny",
  reason,
});
