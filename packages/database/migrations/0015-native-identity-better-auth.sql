-- Migration 0015: native Identity via better-auth (spec 0054).
-- Generated with: npx auth@latest generate (better-auth ^1.7.1) against the
-- AuthEngine config in packages/database/src/auth-engine.ts, then scoped to the
-- dedicated 'auth' schema. Regenerate and re-scope in the same commit as any
-- better-auth version bump.
CREATE SCHEMA IF NOT EXISTS auth;

create table auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references auth."user" ("id") on delete cascade);

create table auth."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index "session_userId_idx" on auth."session" ("userId");

create index "account_userId_idx" on auth."account" ("userId");

create index "verification_identifier_idx" on auth."verification" ("identifier");