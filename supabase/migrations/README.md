# Database migrations

Schema changes are **versioned SQL files in this directory**, applied with the **Supabase CLI**, and
tracked in a ledger so we always know exactly what has run. No more ad-hoc SQL in the dashboard editor.

The CLI ships as a devDependency, so every command below is `npx supabase ...` (or the `npm run db:*`
wrappers). See `docs/deployment-and-rollouts.md` for the why and the broader rollout strategy.

## The ledger

The source of truth for *what has been applied* is the table **`supabase_migrations.schema_migrations`** on
the remote database, managed by the CLI. `npm run db:status` prints it next to the local files so you can
see which versions are applied vs pending.

## One-time setup (per machine / CI with DB access)

```bash
# Link this repo to the Supabase project (needs the project ref + DB password; store creds in env/secrets).
npx supabase link --project-ref <your-project-ref>

# BASELINE: migrations 001–008 were applied by hand BEFORE we adopted the CLI, so the ledger doesn't know
# about them. Mark them applied WITHOUT re-running (re-running would fail on existing objects):
npm run db:baseline        # = supabase migration repair --status applied 001 … 008
npm run db:status          # confirm 001–008 show as "applied"
```

Run the baseline exactly once against each environment (prod, and any long-lived staging).

## Adding a migration (the normal flow)

```bash
npm run db:new -- add_something      # creates supabase/migrations/<timestamp>_add_something.sql
# …edit the SQL…
npm run db:check                     # local consistency + safety lint (also runs in CI)
npm run db:push                      # applies pending migrations to the linked DB + records them in the ledger
```

`db:new` generates a 14-digit timestamp version (the CLI default); the legacy `00N_` files keep their
names. Both sort correctly, so the ledger order is preserved.

## Expand → deploy → contract (zero-downtime rule)

Never ship a schema change that the currently-running code can't tolerate. Split every breaking change:

1. **Expand** — add new columns/tables/RPCs as *additive, nullable/defaulted*. Apply this migration **before**
   deploying the code that uses it. Old code ignores the new shape.
2. **Deploy** — ship code that writes/reads the new shape. Backfill data in a background job, not in a request.
3. **Contract** — only after the new code is fully rolled out and stable, drop the old columns/RPCs in a
   **later** migration. Never rename/drop in the same release that stops using a thing.

**Version breaking RPCs instead of mutating them.** If a function's argument/return shape changes, add
`match_content_v2(...)`, point new code at it, and retire the old one a release later. Migration `006` had to
`drop function match_content` + recreate (return-type change → error 42P13) — that's the in-flight-failure
risk we now avoid by versioning.

## Safety check (`npm run db:check`, enforced in CI)

`scripts/check-migrations.mjs` runs with no database and fails the build on: malformed filenames, duplicate
versions, empty files, and **unguarded destructive statements** (`DROP TABLE/FUNCTION/COLUMN/SCHEMA/TYPE`,
`ALTER … DROP`, `TRUNCATE`, `RENAME`). A deliberate contract-phase migration acknowledges the drop with a
comment line so it's explicit and reviewable:

```sql
-- migration-lint:allow-destructive: contract phase — old_col unused since the <feature> release (vNNN)
alter table content drop column old_col;
```
