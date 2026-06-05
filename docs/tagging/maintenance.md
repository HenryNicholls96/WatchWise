# Tag System Maintenance

> Owner doc for the `tag_mappings` system. The quality of `mood_tags` and `theme_tags`
> directly determines recommendation quality and the semantic richness of `embedding_input`.
> Treat every change as a production change: **validate → version → apply → re-embed.**

---

## Core Principle

`tag_mappings` is a flat `keyword → (tag_type, tag_value)` lookup. It has **no AND/OR logic** —
each TMDb keyword maps to exactly one tag. Therefore a mapping is only as good as the keyword's
*precision*: does the presence of this keyword reliably indicate this tag, with few false positives?

A keyword that fires on the wrong content is worse than a missing mapping, because it actively
misleads the recommender.

---

## The Change Workflow (mandatory order)

Every tag change follows this sequence. No step is optional.

```
1. VALIDATE   → run scripts/validate-tag-impact.ts with the candidate batch (dry-run, writes nothing)
2. REVIEW     → manually inspect Q3 sample titles; confirm signal quality; check Q4 over-tagging
3. VERSION    → insert a tag_change_log row recording what/why/impact
4. APPLY      → run the idempotent INSERT ... ON CONFLICT DO NOTHING
5. RE-SEED    → npm run seed  (regenerates mood_tags, theme_tags, embedding_input on affected titles)
6. RE-EMBED   → npm run embed (re-embeds only titles whose embedding_input drifted — see below)
```

If you skip step 1, you are guessing. If you skip step 6, the new tags exist in the database but
**do not affect recommendations**, because vector search runs on the embedding, not the tag arrays.

---

## Promotion Criteria (when a keyword earns a mapping)

A keyword may be promoted to `tag_mappings` only if **all four** hold:

1. **Frequency** — appears on ≥3 titles in the current catalog, *or* is a high-precision keyword
   certain to appear as the catalog grows (documented as "forward-coverage" — see below).
2. **Precision** — its presence reliably indicates exactly one tag. If it plausibly fires on
   unrelated content, reject it.
3. **Expressibility** — a user could realistically express this as a preference in natural language
   ("I want something *[tag]*"). If not, it is metadata, not a recommendation signal.
4. **Validated** — `validate-tag-impact.ts` has been run and the Q3 sample manually confirms the
   keyword fires on the right titles.

**Borderline default: reject.** If a keyword feels ambiguous and you cannot show clear user-facing
value from the validation output, do not add it.

### Forward-coverage exception
A high-precision keyword with **0 current hits** (e.g. `manga adaptation`) may be added if it is
unambiguous and certain to appear as the catalog grows. It must be logged in `tag_change_log` with
`titles_affected = 0` and rationale noting "forward-coverage". This is the *only* sanctioned reason
to add a zero-hit keyword.

---

## Ignore List (never map these)

These keywords are TMDb production/metadata artifacts or are too generic to discriminate. They must
never be added, regardless of frequency.

| Keyword | Reason |
|---|---|
| `aftercreditsstinger` | Production metadata — describes scene placement, not content character |
| `duringcreditsstinger` | Same |
| `sequel` | Production context; users do not filter by "is a sequel" |
| `short film` | Content format, not a preference signal |
| `new york city` | Location; not a meaningful filter below ~10k titles + geo preference data |
| `hero` | Fires on nearly every protagonist-driven story — zero discriminatory value |
| `based on comic` | **Rejected 2026-06-05.** False-positive vector (non-superhero comics: webcomics, Sin City, The Walking Dead). Validation showed every genuine superhero title also carries an unambiguous keyword, so it adds 0 true recall while mislabeling fantasy/crime content. |
| `excited` | Describes viewer emotion, not content |
| `villain` | Too generic — villains appear across crime, fantasy, drama, superhero |
| `songs and dance` | Catches dance films (Step Up) that are not musicals |

---

## Monthly Health Check

Run in Supabase SQL Editor on the 1st of each month. Record the result in the tracking table below.

```sql
-- Tag coverage health snapshot
WITH coverage AS (
  SELECT
    (array_length(mood_tags, 1)  IS NULL OR array_length(mood_tags, 1)  = 0) AS no_mood,
    (array_length(theme_tags, 1) IS NULL OR array_length(theme_tags, 1) = 0) AS no_theme
  FROM content
)
SELECT
  COUNT(*)                                                       AS total_titles,
  COUNT(*) FILTER (WHERE no_mood)                                AS no_mood_tag,
  COUNT(*) FILTER (WHERE no_theme)                               AS no_theme_tag,
  COUNT(*) FILTER (WHERE no_mood AND no_theme)                   AS no_tags_at_all,
  ROUND(COUNT(*) FILTER (WHERE NOT no_mood AND NOT no_theme)::numeric
        / COUNT(*) * 100, 1)                                     AS pct_fully_tagged
FROM coverage;
```

```sql
-- Most recent run's unmapped keywords, ranked candidates for promotion
SELECT jsonb_array_elements_text(metadata->'unmapped_keywords') AS keyword
FROM sync_jobs
WHERE status = 'completed' AND metadata ? 'unmapped_keywords'
ORDER BY created_at DESC
LIMIT 1;
```

### Coverage Tracking Log

Append one row per monthly check. A falling `pct_fully_tagged` means TMDb keyword vocabulary is
drifting ahead of our mappings.

| Date | Total titles | % fully tagged | No tags at all | Notes |
|---|---|---|---|---|
| 2026-06-05 | 230 | _baseline TBD_ | _TBD_ | Pre high-priority batch |

---

## Post-Seed-Run Workflow (every `npm run seed`)

1. Open Supabase → `sync_jobs` → newest row → `metadata.unmapped_keywords`.
2. Any keyword you recognize as a real content signal → evaluate against promotion criteria.
3. If promoting: follow the full Change Workflow above (validate first).
4. Confirm `metadata.phase_results.write.content_upserted` matches expectations.

---

## Dry-Run Before Applying (required)

`scripts/validate-tag-impact.ts` is the gate. Run it via the npm script. Pass candidate
mappings on the command line as `keyword=type:tag` (no args = the default batch baked into the file):

```bash
# Validate an ad-hoc batch without editing any file:
npm run validate:tags -- "zombie=theme:supernatural" "zombie apocalypse=theme:survival"

# Or run the default batch defined in the script:
npm run validate:tags
```

Read the output before applying anything:

- **Q1** — total titles affected. Sanity-check the magnitude.
- **Q2** — distribution. A healthy batch is mostly 1–2 new tags per title.
- **Q3** — per-tag samples. **Manually confirm** each tag is firing on the right titles.
- **Q4** — over-tagging. Any title gaining ≥4 new tags is a red flag; investigate before applying.
- **Keyword hit counts** — any `DEAD (0 hits)` keyword is forward-coverage only; justify or drop it.
- **Recall-risk** — for any keyword under consideration for removal, list it in `WATCH_KEYWORDS`
  to see how many titles match *only* via that keyword.

---

## Running the Embed Step After Tag Changes

Tags only affect recommendations once they reach the **embedding** — vector search runs on
`content.embedding`, not on the tag arrays. After any change that alters `embedding_input`
(a re-seed, a tag-mapping change), you must re-embed the affected titles:

```bash
npm run embed
```

This is the second half of the loop and is **not optional**. It is idempotent and self-targeting:

- It re-embeds a title only when `embedding IS NULL` **or** `md5(embedding_input) != embedded_input_hash`.
- Titles whose input did not change are skipped — no wasted Voyage calls.
- Per-title failures are isolated, logged, and surfaced in the end-of-run summary; a non-zero exit
  code signals a partial run.

Typical output:
```
Found 53 title(s) needing embedding
Progress: 53/53 embedded
─── Summary ───
  Candidates found : 53
  Embedded         : 53
  Failed           : 0
```

**Cost:** voyage-3-lite is ~$0.00002 per 1K tokens. Each title's input is ~120 tokens, so a
53-title re-embed is ≈ 6.4K tokens ≈ **$0.0001** — effectively free. A full 230-title re-embed is
still well under a cent.

If `npm run embed` reports `skipped (no embedding_input)`, run `npm run seed` first — those titles
have no input string to embed yet.

---

## Versioning Tag Changes

Every applied batch gets a `tag_change_log` row (migration `003`). This is the audit trail —
it answers "when did we add `superhero` and why" months later.

```sql
INSERT INTO tag_change_log (change_type, tag_type, tag_value, keywords, rationale, validated, titles_affected, applied_by)
VALUES (
  'add', 'theme', 'superhero',
  ARRAY['superhero','superhero team','marvel cinematic universe (mcu)','supervillain'],
  'High-priority genre signal, entirely unrepresented. Validated: 29 titles, max 2 new tags, no over-tagging.',
  true, 29, 'henry'
);
```

For rejected keywords, log a `reject` row so the decision is permanent and discoverable:

```sql
INSERT INTO tag_change_log (change_type, keywords, rationale, validated, applied_by)
VALUES (
  'reject', ARRAY['based on comic'],
  'False-positive vector for non-superhero comics. Validation: drops only 2 false positives (Along with the Gods), 0 true recall loss.',
  true, 'henry'
);
```

---

## How We Will Measure Whether Tags Improve Recommendations

Tags are a *means*, not the goal. Once feedback data exists (`recommendation_feedback`), evaluate:

1. **Tag → sentiment correlation.** Which tags appear disproportionately in `loved` vs `disliked`
   recommendations. High-signal tags concentrate in loved; noisy tags spread evenly or concentrate
   in disliked.
2. **Coverage vs engagement.** Do titles with richer tags (and therefore richer `embedding_input`)
   get clicked/loved more than thinly-tagged ones? If yes, coverage is worth investing in.
3. **Query-tag alignment.** When a user's NL query implies a tag (e.g. "superhero"), do the returned
   results actually carry it? Low alignment means the embedding isn't capturing the tag — re-embed.

These become real queries once the recommendation engine and feedback loop ship (next phases).
