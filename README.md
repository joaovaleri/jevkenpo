# Jevkenpo

**Rock, paper, scissors. And literally anything else.**

[Play](https://jevkenpo.vercel.app/) · [Source](https://github.com/joaovaleri/jevkenpo)

A deliberately minimal browser game. Start with paper, name anything that beats it,
and let TypeSafe's Jev judge. Every accepted answer becomes the next challenge.

Open source under the [MIT license](LICENSE). Plain HTML/CSS/JavaScript, a tiny
Node.js API, and no runtime packages or database.

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fjoaovaleri%2Fjevkenpo&env=TYPESAFE_API_KEY&envDescription=Your%20TypeSafe%20API%20key&envLink=https%3A%2F%2Fconsole.typesafe.ai)

1. Import this repository into Vercel (framework preset **Other**).
2. Set the server environment variable `TYPESAFE_API_KEY`.
3. Deploy. The included `vercel.json` configures the static page and API function.

### OpenRouter with a spending cap

The hosted demo uses Jev through OpenRouter. To use the same setup:

1. Create a dedicated OpenRouter API key and set a **$10 spending limit with no
   reset**. This is a total API usage cap, not a recurring monthly allowance.
2. Set `JEV_PROVIDER=openrouter`, `JEV_MODEL=jev-latest`, and the server secret
   `OPENROUTER_API_KEY` in Vercel (or `.env.local` when running locally).
3. Deploy again after changing environment variables. The key stays server-side.

OpenRouter enforces the cap across requests and server instances. A local counter
would not provide this guarantee on Vercel. When OpenRouter reports an exhausted
key limit or balance, the game shows a spending-limit message and preserves the
run. Cached results may still work without another paid request. It never falls
back to the direct TypeSafe key, even if both credentials are configured.

The limit must be configured on the OpenRouter key; setting environment variables
alone does **not** create a cap. Credit purchases, fees, and hosting are separate.
This setup uses OpenRouter credits; if you configure BYOK in your OpenRouter
account, include BYOK usage in the key limit as well. See the official
[credit limits](https://openrouter.ai/docs/api_reference/limits) and
[TypeSafe integration](https://openrouter.ai/docs/guides/community/typesafe-sdk).

The Vercel version stores a signed save in the player's browser. Any function
instance can verify it, so a cold start does not lose the chain. Saves expire after
24 hours without a judged move. `SESSION_SECRET` is optional; otherwise a dedicated
signing key is derived from the selected provider key. Changing that key expires old saves.
Neither secret is sent to the browser or committed to the repository.

Vercel's local preview is also available with `npx vercel dev` after setting the
environment variable. The command below runs the standalone Node.js server.

## Run

Node.js 22; no packages to install.

```sh
cp .env.example .env.local
# Set TYPESAFE_API_KEY, or use the OpenRouter configuration above.
npm start
```

Open http://127.0.0.1:5180. `npm run dev` restarts the server when source files change.
The API key stays on the server. Without it, the page opens and explicitly reports
that Jev is not connected; no fake or hard-coded judgments are substituted.

## Rules and behavior

- Starts with paper. Each accepted answer earns one point and becomes the next target.
- Jev accepts recognizable physical, fictional, conceptual, or humorous counters.
- Repeated concepts and invalid input get another attempt. A losing matchup ends the run.
- One request asks Jev only for the verdict. A local English/Portuguese dictionary
  selects a representative emoji, falling back to ✨ for unknown concepts.
  Jev does not generate prose; result messages are interface text.
- Results show Jev's win probability from `answers.verdict.probabilities.win`,
  including on losses. It uses the existing response, with no additional API call.
  This is the model's estimate for the matchup. Older saves or results without
  a valid probability omit the percentage.
- A shared in-memory cache reuses identical judgments for 24 hours, up to 10,000
  entries. It includes the full chain, current target and exact answer, so a cached
  win cannot bypass semantic-repeat detection in another chain. Concurrent identical
  requests share one upstream call. Errors are never cached. Restarting clears it.
- Answers may be in any language. The interface is English.
- On Vercel, the chain is kept in a signed browser save that survives cold starts.
  The standalone server uses an HTTP-only cookie session kept in memory; restarting
  that local server clears its runs.
- Personal best is stored only in that browser. Share uses the native share sheet or
  copies the score, sequence, and game URL; it is not a publicly verified leaderboard.
- Request timeout: 15 seconds. Failed requests do not lose a run. Duplicate concurrent
  requests and stale tabs cannot award extra points.
- Answers have an 80-character limit; runs support up to 499 wins.

## Verify

```sh
npm run check
npm test
```

Tests use an injected judge and incur no API cost. They cover progression, defeat,
repeat handling, stale/concurrent requests, error recovery, and server-only credentials.

## Structure

- `public/`: responsive page, game UI, animation, accessibility, and sharing.
- `lib/judge.mjs`: TypeSafe request, local emoji dictionary, and response validation.
- `lib/judge-cache.mjs`: bounded, context-aware judgment cache.
- `server.mjs`: static files, session state, request limits, and TypeSafe proxy.
- `api/index.js` and `lib/cloud-game.mjs`: Vercel handler and signed run state.
- `vercel.json`: static files, API routes, security headers, and function timeout.

Uses the [TypeSafe System One API](https://docs.typesafe.ai/introduction), with
one [Choice question](https://docs.typesafe.ai/primitives/choice) per uncached guess.
The direct TypeSafe default is `jev-1.13.0`. OpenRouter defaults to `jev-latest`
through its compatible `/api/v1/systemone` endpoint, with the same verdict and
probabilities. `JEV_MODEL` overrides the default. The latest alias follows new
Jev releases, so model behavior and pricing may change over time.

## Measured API cost

On 2026-09-21, removing the emoji question reduced the paper/black-hole request
from **2,665 to 646 input tokens (75.8%)**, preserving the exact original verdict
instructions. The ten paired smoke cases in `docs/cost-measurement.json` retained
all ten verdicts. These are selected checks, not a general accuracy guarantee.
The attempted shorter prompt failed repeat checks and was not shipped; its
measurement is retained in `docs/cost-measurement-short-prompt-rejected.json`.

The final version measured 732 tokens with a synthetic 20-item chain and 1,083
with a 100-item chain. Using 750 tokens as a rough planning average for short runs
and the verified TypeSafe rate of $0.042 per million input tokens:

| Workload | Estimated API cost before cache savings |
| --- | ---: |
| 1,000 players × 20 answers | $0.63 |
| Same workload daily, 30 days | $18.90 |

Actual names, chain lengths, retries, and cache hit rate change the total. Cache
hits incur no new TypeSafe request; no cache hit rate has been measured in production.
Hosting, tax and custom domains are excluded. Output tokens are currently free.

`node scripts/measure-cost.mjs` makes ten paid smoke-test calls and records usage.
An optional absolute path to a previous judge module enables a paired comparison.
See the [official model price](https://docs.typesafe.ai/models).

## Operational limits

Vercel handles HTTPS. The API has a 60-request/minute/IP burst guard per warm
function instance. The cache is also per warm instance and can be cleared on cold
starts. Neither is a global quota; configure a provider spending cap as described
above and use Vercel Firewall for stronger abuse protection. Uncached guesses
incur usage charges at the selected provider.

Signed saves prevent forging accepted moves, but without a database a player can
replay an older valid save or fork a run between tabs. Scores are personal, not an
authoritative competitive leaderboard. A future public leaderboard would require
server-side persistence and replay prevention. The standalone server's existing
in-memory sessions enforce one current revision while the process is running.
