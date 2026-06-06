// Migration consistency + safety checker — runs in CI, no database required.
//
// The authoritative applied-state LEDGER is `supabase_migrations.schema_migrations` on the remote DB,
// managed by the Supabase CLI (see docs/deployment-and-rollouts.md). This script can't (and shouldn't)
// reach that table from CI; instead it guards the migration *files* so the set stays well-formed and the
// expand→deploy→contract policy is enforced before anything is ever applied:
//   • filenames are <version>_<lower_snake>.sql (CLI-compatible: legacy 00N_ and 14-digit timestamps both ok)
//   • versions are unique (a duplicate version silently shadows a migration in the CLI)
//   • no empty migrations (a comment-only file usually means a mistake)
//   • no UNGUARDED destructive statements — those break zero-downtime deploys, so they must be an explicit,
//     acknowledged "contract phase", never an accident.
//
// Exit code 1 on any violation so the CI gate blocks the merge.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

const NAME_RE = /^(\d+)_[a-z0-9_]+\.sql$/

// New migrations opt out per-file with this marker — the machine-readable "this is the deliberate contract
// phase, the destructive change is intentional and safe" acknowledgement.
const ALLOW_MARKER = 'migration-lint:allow-destructive'

// Pre-ledger historical migrations with an intentional destructive statement. Recorded here (not as edits
// to the already-applied SQL) so history stays untouched while the policy is enforced for NEW migrations.
// 006 drops+recreates the match_content RPC to add return columns (documented in-file; CREATE OR REPLACE
// can't change a function's return shape → error 42P13). This is exactly the case we now forbid going
// forward: future RPC changes must add match_content_v2 instead of dropping the old one.
const HISTORICAL_DESTRUCTIVE_OK = new Set(['006'])

// Data-/contract-destructive statements that must be explicitly acknowledged. (Index/trigger/policy drops
// are intentionally excluded — they're recreatable and don't drop data or break a response contract.)
const DESTRUCTIVE = [
  [/\bdrop\s+table\b/, 'DROP TABLE'],
  [/\bdrop\s+function\b/, 'DROP FUNCTION'],
  [/\bdrop\s+schema\b/, 'DROP SCHEMA'],
  [/\bdrop\s+type\b/, 'DROP TYPE'],
  [/\bdrop\s+column\b/, 'DROP COLUMN'],
  [/\balter\s+table\s+[^;]*\bdrop\b/, 'ALTER TABLE ... DROP'],
  [/\btruncate\b/, 'TRUNCATE'],
  [/\brename\s+(to|column)\b/, 'RENAME'],
]

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function main() {
  let files
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    console.error(`✖ cannot read ${MIGRATIONS_DIR}: ${err.message}`)
    process.exit(1)
  }

  const errors = []
  const seen = new Map() // version -> filename
  const ledger = []

  for (const file of files) {
    const match = NAME_RE.exec(file)
    if (!match) {
      errors.push(`${file}: bad name — expected <version>_<lower_snake>.sql (e.g. 009_add_x.sql or a 14-digit timestamp from \`supabase migration new\`)`)
      continue
    }
    const version = match[1]
    if (seen.has(version)) {
      errors.push(`${file}: duplicate version "${version}" (also ${seen.get(version)}) — versions must be unique`)
      continue
    }
    seen.set(version, file)

    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    const body = stripComments(raw)
    if (!body.replace(/\s+/g, ' ').trim()) {
      errors.push(`${file}: contains no SQL statements (comment-only file?)`)
      continue
    }

    const sql = body.toLowerCase()
    const hits = DESTRUCTIVE.filter(([re]) => re.test(sql)).map(([, label]) => label)
    const acknowledged = raw.toLowerCase().includes(ALLOW_MARKER) || HISTORICAL_DESTRUCTIVE_OK.has(version)
    if (hits.length > 0 && !acknowledged) {
      errors.push(
        `${file}: destructive statement(s) [${hits.join(', ')}] without acknowledgement.\n` +
          `        → Use expand→contract: add additively first, deploy, then drop in a LATER migration.\n` +
          `        → For a changed RPC/function, add a NEW version (e.g. match_content_v2) — don't drop the old one.\n` +
          `        → If this truly IS the contract phase, add a comment line:  -- ${ALLOW_MARKER}: <reason>`
      )
    }

    ledger.push({ version, file, destructive: hits.length > 0 && acknowledged })
  }

  console.log(`Migration files in supabase/migrations/ (${ledger.length}):`)
  for (const row of ledger) {
    console.log(`  ${row.version.padEnd(14)} ${row.file}${row.destructive ? '   [destructive — acknowledged]' : ''}`)
  }

  if (errors.length > 0) {
    console.error(`\n✖ Migration check failed (${errors.length} issue${errors.length > 1 ? 's' : ''}):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log('\n✓ Migrations consistent: names valid, versions unique, no empty files, no unguarded destructive changes.')
}

main()
