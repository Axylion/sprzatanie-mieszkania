# v13-11-0 — test-only rollout runbook

Implementation is prepared, **not deployed**. Do not run these steps without the
owner's separate approval. Production must remain unchanged.

## Scope and prerequisites

- Supabase: **goleszan-19-test**, project **pbsubdmuupwmtgzncxmh** only.
- Cloudflare Pages: **goleszan-19-preview** only.
- Current rollback deployment: **d43af471-1cf1-4bdc-b906-864d3d763281** (v13-10-2).
- Existing migrations 001–019 must be present. If the migration ledger is
  incomplete because SQL was applied manually, compare actual objects/functions.
- Run `proposals/v13-11-0/preflight.read-only.sql`. Check grants, function owners,
  empty search paths and publications. Never add private tables to Realtime.
- Save an access-controlled schema/data backup outside the repository, including
  rooms/devices, messages/reactions, inbox/delivery/subscriptions. Capture counts
  and current `g19-deliver` source/deployment, VAPID configuration and Cron schedule
  without printing secrets. Failure to back up/verify means stop.

## Migrations

Apply, in order, only to the approved test database:

1. `202611220020_private_chat_foundation.sql`: privacy periods, archive identities,
   private tables, RLS/ACL denial, reply/context columns, disabled feature flag.
   It aborts atomically if an ALL TABLES publication could expose new tables.
2. `202611220021_private_chat_api.sql`: token-scoped RPCs, archive read/write
   separation, replies, compatible legacy inbox operations and private delivery.
   Device row locks use `FOR NO KEY UPDATE` to avoid peer-notification FK deadlocks;
   authentication and revocation checks are unchanged.

Both scripts are transactional and additive. Existing messages and bindings are
not migrated away, deleted or re-keyed. No private messages/events are imported.
Default `private_chat_settings.enabled=false` prevents private sends and reads.

Verify existing counts, subscriptions, data and ACLs before continuing. Verify
capabilities reports `replies=true`, `privateChat=false`; private RPCs fail closed.
Test administrator checks remain separate from device tokens. Do not create real
messages, events or pushes during these read-only checks.

## Worker and site

1. Deploy the updated `g19-deliver` source to the **test** project, retaining
   secrets, schedule, VAPID and existing subscriptions. Its private payload is
   neutral, and a service-only RPC revalidates the conversation before delivery.
2. Publish the verified v13-11-0 ZIP only to `goleszan-19-preview`. It has **55 files**:
   the existing 54 plus `dyskusje/private-chat.js`. Verify all hashes, nonempty
   `index.html`, redirects/asset MIME, test config and SW shell version v13-11-0.
3. Verify both themes/mobile, general history/reactions, login, calendar anchor and
   no console errors without creating user data. Private tabs stay disabled until
   the approved feature activation.
4. Only when feature activation is also approved, enable private chat in the
   SQL Editor of the selected **test** project:

```sql
update g19_private.private_chat_settings set enabled = true where singleton = true;
```

The client refreshes capabilities on reconnect and periodically. It may also be
reloaded. Do not send real test messages/pushes until separately authorized.

## Disabling and recovery

For an approved emergency pause, set `enabled=false` with the same scoped WHERE.
This blocks private RPCs, delivery and new private events; it does not delete data.

Do not drop private tables, restore old period IDs or loosen access to roll back.
Once private events exist, retain the legacy inbox guards so old clients cannot
read/acknowledge them or trigger unsafe bigint casts. Prefer a forward corrective
migration. Restoring the old Pages deployment does not itself undo the DB/worker;
keep the private flag off and preserve the compatible server protections.

Backups contain private plaintext and must remain protected, never committed or
included in the static ZIP. Restoring data requires its own approval and must not
resurrect old tokens or map an old residency to a new occupant.

## Local validation

Node browser/SQL tests use Playwright/Chromium and an isolated PGlite instance;
Python cleanup/calendar tests remain unchanged. The architecture probes in
`tests/private-foundation.test.mjs` now test migration 020 directly.

Native multi-session checks are optional and require a fresh/local PostgreSQL
cluster listening only through an owner-only `/tmp/g19-*` Unix socket. Its data
directory must also be owner-only and located under `/tmp/g19-*`; the test refuses
a normal or network-listening database server:

```sh
G19_NATIVE_PSQL=/absolute/path/to/psql G19_NATIVE_SOCKET=/tmp/g19-private-socket \
  python3 scripts/test_private_concurrency.py
```

The script creates/drops only its uniquely named test DB, reproduces the former
lock conflict there, restores the fixed helper there, and checks concurrent sends,
read-all and resident-release races. It never accepts a Supabase URL or push keys.

Architecture and limitations: `proposals/v13-11-0/ARCHITECTURE.txt`.
