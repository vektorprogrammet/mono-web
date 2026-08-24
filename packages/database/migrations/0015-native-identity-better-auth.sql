-- Migration 0015: native Identity via better-auth (spec 0054).
--
-- Canonical schema regenerated with the version-pinned CLI:
--   npx --yes auth@1.7.1 generate \
--     --config packages/database/src/auth-schema-generator.config.ts \
--     --output /tmp/auth-schema-0015.sql --yes
--
-- better-auth generate only emits a DELTA against an initialized database;
-- against empty auth."user"/"session"/"verification"/"account" tables it
-- produced exactly the account.issuer statements below. Those statements are
-- embedded verbatim (guarded with IF NOT EXISTS) on top of the scoped base
-- DDL so this file stays runnable from zero.
--
-- Regenerate and re-scope in the same commit as any better-auth version bump.
CREATE SCHEMA IF NOT EXISTS auth;

create table if not exists auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references auth."user" ("id") on delete cascade);

create table if not exists auth."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table if not exists auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index if not exists "session_userId_idx" on auth."session" ("userId");

create index if not exists "account_userId_idx" on auth."account" ("userId");

create index if not exists "verification_identifier_idx" on auth."verification" ("identifier");

-- Version-pinned 1.7.1 delta, emitted verbatim by the generator command above:
alter table auth."account" add column if not exists "issuer" text not null;

create unique index if not exists "account_issuer_accountId_uidx" on auth."account" ("issuer", "accountId");

-- Project authority constraint: an authenticated identity is a canonical PersonId.
alter table auth."user"
  add constraint "auth_user_person_profile_fk"
  foreign key ("id") references public.person_profiles ("person_id")
  on delete restrict;
