# Environment and machine migration

RunGuild source code must remain portable. Machine paths, credentials, and
host-port choices belong in local environment variables or the PostgreSQL
Project Runtime Configuration; they must not be hard-coded into application
logic.

## Current company-VM observations

The following are host or operator-state issues, not RunGuild product defects:

- The VM originally had a Snap-managed Docker data root whose daemon was not
  reachable. Its MySQL/Redis volume data and Docker metadata were backed up
  outside this repository before switching to the conventional Docker daemon.
- Host port `6379` was already occupied. The ignored local `.env` therefore
  uses `REDIS_PORT=6380` and `REDIS_URL=redis://localhost:6380`; Redis still
  listens on the standard port `6379` inside Compose. The committed Compose
  file keeps `6379` as its portable default.
- The host emitted `/etc/ld.so.preload` warnings for
  `/usr/lib/libgshkclt.so`. No RunGuild code was changed to hide or work around
  that system preload. A machine administrator should inspect it separately.
- The Codex execution sandbox can reject tests that open a local listening
  socket unless the run is explicitly approved outside the sandbox. Native
  terminal runs and a normal personal machine are not expected to need a
  RunGuild code workaround.
- Codex five-hour usage limits can pause development orchestration. They do not
  represent an API, Worker, PostgreSQL, Redis, or configured model failure.

There are currently **no application-code branches or weakened safety checks
added only for this company VM**. Configurable published ports, absolute-path
validation, and opt-in local Worker control are portable operational features.
The Integration conflict-recovery state machine and migration
`0017_integration_conflict_recovery.sql` were prompted by a real Mission whose
branch had fallen behind `main`; they are portable Git correctness fixes, not VM
workarounds.

## Local state that Git does not move

- `.env` is ignored. Recreate it on the target machine and copy secrets through
  a secure channel; never commit `OPENAI_API_KEY`.
- `project_runtime_configs` stores the repository path, Worktree root, setup
  argv, test allowlist, timeouts, context limits, and Agent model names in
  PostgreSQL. Paths such as `/home/sid/runguild` and
  `/home/sid/runguild-worktrees` must be updated after moving the checkout.
- PostgreSQL contains Missions, Runs, Evidence, Artifact Versions, Reviews,
  Worker history, and Trace records. Moving only the Git repository starts with
  a new ledger. Use `pg_dump`/`pg_restore` if the existing execution history
  must move too.
- Redis is not a fact source and does not need to be migrated. Restarting
  Scheduler/Workers republishes or polls durable PostgreSQL work.
- Docker named volumes and the earlier Snap-Docker backup are outside Git.

## Personal-machine checklist

1. Clone the repository and install the Node version declared in
   `package.json` plus conventional Docker Compose.
2. Copy `.env.example` to `.env`; set a fresh API key, the chosen compatible
   endpoint/model, and host ports that are free on that machine.
3. Start PostgreSQL and Redis with `docker compose up -d postgres redis` and
   verify both health checks.
4. Run `npm ci`, `npm run build`, and `npm run db:migrate`.
5. Bootstrap or restore PostgreSQL, then set the new absolute repository and
   Worktree paths in the Web project configuration.
6. Keep `ENABLE_LOCAL_RUNTIME_CONTROL=false` unless the API is intentionally
   allowed to own local Worker child processes.
7. Run `npm test`; the external PostgreSQL suite additionally requires a
   dedicated database whose name ends in `_test`.

If a future fix is introduced only because of a machine constraint, document
the affected file, reason, portable default, and removal condition in this file
in the same commit.
