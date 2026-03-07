# ADR-0000: Migrate tech stack to TypeScript from PHP

**Date:** 2024-01-01 (retroactive)
**Status:** Accepted

## Context

Vektorprogrammet's production system is built in PHP (Symfony 6.4) with server-rendered Twig templates, jQuery, and Bootstrap 4. The codebase is functional but increasingly difficult to staff:

- **Recruitment:** NTNU informatics students learn languages like Java and C in their coursework. Few are motivated to contribute to a PHP/jQuery stack in their spare time — and this project should be fun, not a chore.
- **Why TypeScript over Java:** Java would be a natural fit given the curriculum, but carries its own legacy baggage. TypeScript is a great compromise between developer experience and practical learning. The c-like syntax is accessible to any informatics student, while the ecosystem (React, Node, Bun) offers a modern DX with fast feedback loops.
- **Educational value:** TypeScript teaches concepts less frequently covered in informatics curricula — functional programming alongside OOP, an expressive type system with generics, algebraic data types, and union/intersection types. Working with this stack exposes contributors to ideas they won't get from Java or C alone.
- **AI tooling:** TypeScript has strong support across AI coding agents and tools. Contributors who want to explore AI-assisted development will find it well-supported.
- **Knowledge transfer:** High turnover in a student org means the stack must be learnable quickly. TypeScript and React have extensive documentation and community support.

A full rewrite is not viable — the PHP backend has 1000+ tests, 93 API endpoints, and years of battle-tested business logic. A "big bang" migration carries too much risk for a volunteer organization with limited capacity.

## Decision

Incrementally migrate the entire tech stack to TypeScript, starting with the frontend:

1. **Build new frontends in TypeScript with React Router 7.** Two apps: a public homepage and an admin dashboard. This is where contributors spend most of their time, so it has the highest recruitment impact.
2. **Keep the PHP backend during migration.** Symfony stays as the API backend via API Platform 3.4 — exposing existing entities as REST endpoints with JWT auth. No business logic rewrite needed yet.
3. **Bridge with a type-safe SDK.** Auto-generate TypeScript types from the Symfony OpenAPI spec (`@vektorprogrammet/sdk`). Full type safety against the PHP backend without manual type maintenance.
4. **Deploy per-app on Railway.** Each app is an independent service with its own build and deploy lifecycle.
5. **Replace the PHP backend with TypeScript over time.** A TypeScript API (`@monoweb/api` with Express, Drizzle, Zod) exists for eventual backend migration. The PHP backend is deprecated incrementally as endpoints are ported.

## Consequences

**What becomes easier:**
- Recruiting contributors — the stack matches what students learn in their CS degree
- Onboarding — TypeScript and React are well-documented and widely taught
- Frontend iteration — component model, hot reload, type safety
- End-state simplicity — one language across the entire stack

**What becomes harder:**
- Two runtime environments during migration (PHP + Bun)
- Auth complexity — JWT across services instead of server-side sessions
- More infrastructure — multiple services instead of a single deployment

**What stays the same:**
- All business logic remains in Symfony until explicitly ported — no rewrite risk
- Database schema unchanged — Doctrine entities are the source of truth during migration
- Existing PHP tests continue to pass — the backend is additive (API endpoints alongside controllers)
