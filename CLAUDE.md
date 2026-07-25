# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# claude-code-proxy

A reverse proxy that lets any Anthropic-schema frontend borrow Claude Code subscription (OAuth) auth instead of paying API prices. It is **not** an OpenAI-compatible proxy — requests and responses are Anthropic's native `/v1/messages` schema, passed through nearly untouched.

This is a fork: `origin` is crozear/claude-code-proxy, `upstream` is horselock/claude-code-proxy. Working branch is `main`.

**The client is essentially always SillyTavern** at `C:\Users\brend\Desktop\SillyTavern` (a customized ST fork with its own CLAUDE.md, registered as an additional working directory). When changing request/response shapes here, check what ST actually sends — especially `public/scripts/claude-batch.js` and `src/endpoints/backends/chat-completions.js` on that side.

## Commands

```bash
npm install          # first time only (dev deps: jest, supertest, nock)
npm start            # node server/server.js — or run.bat (Windows) / run.sh
npx jest             # full suite
npx jest ClaudeBatch # single file by name fragment
npx jest -t "strips stream"   # single test by name
npm run test:watch
npm run test:coverage
docker-compose up    # port 42069; mounts ~/.claude and ~/.claude-code-proxy
```

There is no build step, no linter, and no TypeScript. Plain CommonJS Node, zero runtime dependencies — only `http`/`https`/`fs`/`crypto` from stdlib. **Do not add runtime dependencies casually**; `docker-compose.yml` runs `npm install --only=production || true` and expects to need nothing.

Verify edits with `node --check server/<file>.js`.

### Test suite state

`npx jest` currently reports **2 pre-existing failures in `server/ClaudeRequest.test.js`** (`TypeError: res.writeHead is not a function` — the test's `PassThrough`-based mock `res` lacks `writeHead`, so any throw inside `handleResponse` surfaces as this instead of the real error). 46 of 48 pass. Confirm against a clean checkout before chasing them; if you see a *third* failure, that one is yours.

## Architecture

Three files do everything:

| File | Role |
|------|------|
| `server/server.js` | Plain `http.createServer` — routing is a linear chain of `pathname.match(...)` / `if` blocks in `handleRequest`, no Express, no router lib. Also owns the PKCE state map and Docker/host detection. |
| `server/ClaudeRequest.js` | All request mutation, auth-token resolution, upstream HTTPS calls, streaming passthrough, presets, batch API. One instance per inbound request; auth cache is `static`. |
| `server/OAuthManager.js` | Singleton. PKCE generation, code exchange, refresh, `~/.claude-code-proxy/tokens.json` persistence. |

`server/Logger.js` is a static class configured from `config.txt`; `Logger.createDebugStream()` is a `Transform` that sits in the SSE pipe at `log_level=DEBUG` to accumulate and frame the reply into one bounded log line (see the comment there about Docker's 16 KB line-splitting — don't reintroduce raw token echoing to stdout).

### Request flow

`POST /v1/messages` → `parseBody` → `new ClaudeRequest(req).handleResponse(res, body, presetName)`:

1. `processRequestBody()` **mutates** the body: unshifts `{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }` as `system[0]` (Anthropic rejects the request without it), applies the preset, then `stripTtlFromCacheControl` and `filterSamplingParams`.
2. `makeRequest()` POSTs to `https://api.anthropic.com/v1/messages` with `getHeaders()`.
3. On **401**: clears the static token cache, `loadOrRefreshToken()`, retries **the already-processed body**. Processing exactly once is load-bearing — re-processing duplicated the system block and the preset suffix, shifting the prompt prefix and killing cache hits. `ClaudeRequest.test.js` asserts the two bodies are byte-identical.
4. `streamResponse()` branches on upstream `content-type`: `text/event-stream` → pipe straight through (plus the debug stream at DEBUG); otherwise buffer, `removeHeader('content-encoding')`, re-serialize JSON.

Upstream response headers are copied verbatim to the client.

### Auth precedence

`getAuthToken()` resolves in this order:

1. **`x-api-key` header containing `sk-ant`** — set in the constructor, cached in the `static cachedToken` with `cachedTokenIsApiKey = true`, used as-is (no expiry checking). In SillyTavern this is the "Proxy Password" field.
2. **OAuth tokens** — `~/.claude-code-proxy/tokens.json` via `OAuthManager.getValidAccessToken()` (auto-refreshes with a 1-minute buffer).
3. **Claude Code credentials** — `~/.claude/.credentials.json`, only when `fallback_to_claude_code` isn't `false`. On Windows it tries the native path first, then `wsl cat ~/.claude/.credentials.json`.

**The API-key vs OAuth distinction controls the beta headers, and getting it wrong is a hard failure.** Anthropic rejects `oauth-2025-04-20` / `claude-code-*` betas on a real API key. `getHeaders()` (sync path) always sends the OAuth set; `getBatchHeaders(token, isApiKey)` branches. Any new upstream call must make the same branch.

Note the caches are **static/process-wide**: one client sending an `sk-ant` key replaces the cached token for everyone. Tests must reset `ClaudeRequest.cachedToken`, `cachedTokenIsApiKey`, and `presetCache` in `beforeEach`.

### Preset-scoped URLs

Every route exists in a bare form and a preset-scoped form — `/v1/messages` and `/v1/<preset>/messages`, `/v1/messages/batches` and `/v1/<preset>/messages/batches`. **When adding a route, match both.** `<preset>` names a file in `server/presets/` (e.g. `/v1/pyrite` → `presets/pyrite.json`), loaded lazily into `presetCache` — a failed load caches `null` so it isn't retried.

Preset JSON shape: `{ system, suffix, suffixEt }`. `system` is appended as an extra system block; the suffix is spliced in as a `user` message **immediately after the last user message**, and `suffixEt` is used instead when thinking is on (`body.thinking.type === 'enabled' | 'adaptive'`).

### Message Batches API

`createBatch` / `retrieveBatch` / `cancelBatch` / `getBatchResults` back ST's "Claude Flex" feature (async generation at ~50% cost). Key behaviors:

- Each `requests[].params` gets the **same** `processRequestBody()` treatment as a sync call, and `stream` is deleted (not allowed inside a batch).
- Batch endpoints never stream — `requestRaw()` buffers everything as text, 60s timeout.
- `getBatchResults` retrieves the batch first, follows `results_url`, and returns JSONL. If `results_url` is absent it synthesizes a **409** carrying `processing_status` — ST's poller depends on that.
- The 50% discount only applies to real API-key billing; OAuth/subscription tokens aren't per-token billed anyway.

## Config

`server/config.txt` (git-tracked; `config.docker.txt` is the Docker variant, copy manually). Parsed by a hand-rolled `key=value` reader that strips `#` comments — **inline comments after a value are stripped, so don't put `#` in a value**. Both `server.js` and `ClaudeRequest.js` parse it independently with separate copies of the reader; `ClaudeRequest.js` reads it once at **module load** into `CONFIG`, so its flags (`filter_sampling_params`, `fallback_to_claude_code`) only take effect on restart.

- `port` (default 3000 in code, 42069 in configs), `host` (blank = auto: `127.0.0.1` native, `0.0.0.0` in Docker via `/.dockerenv` + cgroup detection)
- `log_level` — `TRACE|DEBUG|INFO|WARN|ERROR`; `DEBUG` dumps full request/response bodies
- `filter_sampling_params` — when true, drops one of `temperature`/`top_p` (Sonnet 4.5 rejects both); removes defaults of `1.0`, prefers temperature when both are non-default
- `auto_open_browser`, `fallback_to_claude_code`

Two module-level constants in `ClaudeRequest.js` are **not** config-driven: `STRIP_TTL` (currently `false`, so `cache_control.ttl` passes through despite the README saying it's stripped) and `TOKEN_REFRESH_METHOD` (`'OAUTH'`; the `CLAUDE_CODE_CLI` path throws).

## Testing notes

- `nock` intercepts `https://api.anthropic.com`. Header values come back as **strings, not arrays** — assert `String(headers['x-api-key'])`.
- `server/Logger` is `jest.mock`'d at the top of every test file (with `getLogLevel: () => 0`) — required, since `ClaudeRequest` calls `Logger.truncate`/`createDebugStream` on hot paths.
- **`server/server.test.js` re-implements its own copy of `handleRequest` rather than importing `server.js`** — it has already drifted (its `/auth/login` returns a 302 while the real server serves `static/login.html`). Passing OAuth route tests do not mean `server.js` routing works; add integration coverage against the real handler if you touch routing.
- `OAuthManager` is a singleton, so tests override `OAuthManager.tokenPath` to a `.test-tokens*` dir and reset `cachedToken`.

## Other directories

- `server/static/` — `login.html` (kicks off `/auth/get-url`, supports manual `code#state` paste) and `callback.html`.
- `util/` — standalone helper scripts, not part of the server. `claude-bearer.js` extracts a bearer token by running Claude Code and sniffing the header; `gemini-bearer.js` is the Gemini analogue; `claude-curl.txt` is a known-good curl.
- `Silly Tavern presets/` — Pyrite jailbreak preset for import into ST, mirroring `server/presets/pyrite.json`.
