# WatchWise — Reviewer Brief

> 2–3 minute read. Thanks for taking a look. This tells you what WatchWise is, how to try it in 60 seconds,
> what's intentionally rough, and the feedback that helps us most right now.

## What it is

A **decision-fatigue eliminator** for streaming. You say what you're in the mood for in plain language and
get **5–8 explainable picks** from Netflix / Prime / Disney+ that you can start watching in under a minute.
It is *not* a "where to watch" search tool (that's JustWatch) — it's a **decision assistant** with a calm,
knowledgeable-friend voice.

## 60-second happy path

1. **Land on the app** → first-time visitors are routed into a short **onboarding**: swipe ~10 titles
   (♡ Like / ✕ Pass / ⌃ Not Seen) and answer 4 quick questions (platforms, movies/series, runtime, anything
   to avoid).
2. **Discovery screen** → type a vibe, e.g. *"dark psychological thriller, not on Disney, in English"* or
   *"something light and funny under 90 minutes"*.
3. **Get 5–8 cards** → poster, title, one-line summary, rating, platform badge.
4. **Open a card** → the **"Why This One?"** explanation, "Similar to", summary, and where to watch.

That's the core loop. Onboarding tunes results (likes boost similar titles; "avoid horror" etc. filter).

## Important architecture context (so behavior makes sense)

- **Explanations are deferred.** Cards render immediately; the "Why This One?" text is fetched in the
  background and appears when you open a card (you may briefly see "Thinking about why this fits…"). This is
  intentional — the grid shouldn't wait on the LLM.
- **Fail-open everywhere.** If the LLM, ratings, or a backend dependency hiccups, you still get
  recommendations — explanations fall back to a deterministic sentence, ratings degrade gracefully. You
  should never see a hard failure on the happy path; if you do, that's a bug worth reporting.
- **Recommendations are server-authoritative.** Ranking/scoring happens on the server; the client never
  supplies scores.
- **Catalog is finite.** ~900 curated titles across the three platforms (not the entire catalog), so some
  niche queries will reach. Low-confidence picks are hedged honestly rather than oversold.

## Intentionally rough / known limitations

- **UI polish & mobile** are not the focus of this round — layout, spacing, and animations are functional but
  unrefined. Note anything egregious, but we know it's not finished.
- **No accounts/email yet** — sessions are anonymous; your taste profile lives in that browser session.
- **Catalog gaps** — a query can surface a weak/"reaching" match if the catalog lacks a good fit; picks below
  the confidence floor are labeled accordingly.
- **"Surprise me" / refinement chips** and richer filtering are partial.
- First request after a cold start can be slower (warming up); subsequent ones are fast.

## Check current state in 5 seconds — `GET /api/health`

Open `<preview-url>/api/health`. You'll get JSON like:

```json
{ "status": "ok", "release": "<commit sha>",
  "checks": { "database": { "ok": true }, "distributedStore": { "ok": true, "backend": "redis" } },
  "flags": { "explanations_llm": true } }
```

- `status: ok` (HTTP 200) = ready. `degraded` = store down but usable. `error` (503) = DB down, don't bother
  testing yet — ping us.
- `release` tells us exactly which build you're on (quote it in bug reports).
- `flags` shows what's switched on.

## Kill-switch demo — `explanations_llm`

We can disable the LLM explanation step instantly (cost/incident kill switch) **without a redeploy**. To see
the graceful-degrade behavior: with the flag **off**, open a card — you'll still get a sensible "why" line,
just deterministic rather than LLM-written, and `/api/health` shows `"explanations_llm": false`. This is the
fail-open design in action; nothing should break, you just lose the LLM phrasing.
*(Flipping it is an operator action — ask us and we'll toggle it during the session.)*

## What feedback helps most right now

In priority order:

1. **Decision quality** — for a given query, are the 5–8 picks *good*? Would you actually watch one? Do the
   explanations feel specific and trustworthy (vs. generic)?
2. **Time-to-decide** — could you commit to something in under a minute? Where did you stall or hesitate?
3. **Trust & tone** — does it feel like a knowledgeable friend, or generic/pushy? Are low-confidence picks
   honest?
4. **Onboarding** — was the swipe + questions flow worth it? Did results noticeably reflect your taste?
5. **Anything that broke or felt slow** — include the `release` from `/api/health` and roughly what you typed.

**Less useful right now:** pixel-level UI nitpicks, mobile layout, and feature requests for things we've
flagged as partial above (we know). A note is fine; just don't spend your energy there.

## How to report

A sentence + the query you used + the `release` is plenty. Screenshots welcome for "this pick was weird /
this explanation was off." Thank you!
