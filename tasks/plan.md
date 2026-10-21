# Implementation Plan: Stage 10 Follow-up – Dependabot rules and faster CI

Approved by the user on 2026-10-21, after the first Dependabot PRs and a look at CI timings.

## Problem

- Dependabot PR #22 (TypeScript 6 → 7) fails `nest build`: TypeScript 7.0 ships no programmatic compiler API, which the Nest CLI needs ("expected to return in 7.1").
- Dependabot PR #23 (Vitest 4 → 5) fails `npm ci`: `@vitest/coverage-v8` 4.1.11 requires exactly `vitest` 4.1.11, and Dependabot updated `vitest` alone.
- Every commit on a PR branch runs CI twice (`push` and `pull_request`), and the `docker` job waits for `checks`, so one run takes about 2 min 45 s.

## Change

1. `.github/dependabot.yml`: ignore `typescript` majors (until the Nest CLI works with TypeScript 7); group `vitest` and `@vitest/*`, and ignore their majors for now (user's decision). Close #22 and #23.
2. `.github/workflows/ci.yml`: `push` only on `main` (pull requests still run on every commit); `docker` no longer waits for `checks`.

**Proof.** The PR gets one CI run per commit, both jobs start together, and both pass. Measured run time compared with the 2 min 45 s before.
