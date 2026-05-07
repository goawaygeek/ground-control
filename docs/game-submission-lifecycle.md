# Game Submission Lifecycle (Future)

## Overview

A process for community members to propose, submit, and graduate games through a structured lifecycle. Think of it like how a sport gets added to the Olympics.

## Game States

```
  SUGGESTED ──→ BETA ──→ APPROVED
     │            │
     └── rejected └── demoted/removed
```

### Suggested
- **What it is:** A description only — no code yet
- **How it gets here:** Anyone can submit a game concept (name, description, player count, how Claude coaches, etc.)
- **What happens next:** Existing players vote on suggested games on a regular cadence (e.g. weekly). Top-voted games move to Beta and the author is invited to submit code.

### Beta
- **What it is:** A working game module in the repository, flagged as beta
- **How it gets here:** Author submits the `GameModule` implementation after their concept is voted through
- **Visible to players:** Yes, but clearly marked as beta. Players opt in knowing it may be rough.
- **What happens next:** Needs to hit a graduation threshold to become Approved.

### Approved
- **What it is:** A fully vetted, stable game in the main rotation
- **How it gets here:** Meets graduation criteria from Beta (see below)
- **Visible to players:** Yes, listed as a standard game option

## Graduation Criteria (Beta -> Approved)

TBD — candidates include:
- Minimum hours played across unique players
- Player satisfaction (NPS or similar)
- Minimum number of completed sessions
- Author responsiveness to bugs/feedback
- Code quality review

## Open Questions

- **Code submission mechanism:** GitHub PRs work well (see OpenClaw model) and create acquisition signal, but creates a platform dependency. Alternatives: CLI upload, npm package registry, custom submission API.
- **Voting mechanics:** Who votes? All players? Only players with X hours? Weighted by activity?
- **Cadence:** Weekly vote cycles? Monthly? On-demand once a threshold of suggestions is reached?
- **Rejection/removal:** What happens to games that don't graduate from beta? Time limit? Activity cliff?
- **Metadata requirements:** Game modules will eventually need to export metadata beyond `gameId` — things like `displayName`, `description`, `minPlayers`, `maxPlayers`, `author`, `version`. This is a non-breaking addition to the `GameModule` interface whenever we're ready.

## Architecture Compatibility

The current P0 refactor (GameModule interface + game factory) fully supports this. The factory/registry is the natural seam:

- **Now:** `createGame("comedy-battle")` — hardcoded switch
- **Later:** `registry.getGame("comedy-battle")` — dynamic registry with status, votes, play hours, etc.

The game module interface doesn't change. The submission lifecycle is a product layer on top.
