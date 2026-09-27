[//]: # "generated from content/model/index.mdx by just docs generate; do not edit"

# Formal models

The Alloy model of the authority rules and the Context Mapper model of the bounded contexts.

The two models state intended behavior. The [system document](../system.md) is the product authority, and the [architecture document](../architecture.md) holds the technical boundaries.

| Model                                              | States                                                                   | Check                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| [authority.als](../../content/model/authority.als) | The role and principal algebra of authority, with its checks and mutants | `just model check`    |
| [contexts.cml](../../content/model/contexts.cml)   | The bounded contexts, their aggregates, and the context map              | `just model validate` |

`just guides write` renders the bounded-context part of each module guide from `contexts.cml`, and `just layout` names every context folder after one of its contexts.
