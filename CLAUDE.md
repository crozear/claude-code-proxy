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

`npx jest` currently reports **2 pre-existing failures in `server/ClaudeRequest.test.js`** (`TypeError: res.writeHead is not a function`). The real error is `Logger.truncate is not a function` — that file's `jest.mock('./Logger')` omits `truncate`, which `makeRequest` calls, and the test's `PassThrough`-based mock `res` lacks `writeHead`, so the throw surfaces as the `writeHead` TypeError instead. Adding `truncate: (v) => String(v)` and a `writeHead` stub to that file's mocks fixes both (verified); left alone as out-of-scope. 82 of 84 pass. Confirm against a clean checkout before chasing them; if you see a *third* failure, that one is yours.

Dev deps are **not** committed — `npm install` first or every suite fails with `Cannot find module 'nock'`.

## Architecture

Four files do everything:

| File | Role |
|------|------|
| `server/server.js` | Plain `http.createServer` — routing is a linear chain of `pathname.match(...)` / `if` blocks in `handleRequest`, no Express, no router lib. Also owns the PKCE state map and Docker/host detection. |
| `server/ClaudeRequest.js` | All request mutation, auth-token resolution, upstream HTTPS calls, streaming passthrough, presets, batch API. One instance per inbound request; auth cache is `static`. |
| `server/OAuthManager.js` | Singleton. PKCE generation, code exchange, refresh, `~/.claude-code-proxy/tokens.json` persistence. |
| `server/OpenAICompat.js` | Pure OpenAI ⇄ Anthropic translation for the `/v1/chat/completions` front door. No HTTP, no auth, no config reads — just body/response/SSE reshaping. |

`server/Logger.js` is a static class configured from `config.txt`; `Logger.createDebugStream()` is a `Transform` that sits in the SSE pipe at `log_level=DEBUG` to accumulate and frame the reply into one bounded log line (see the comment there about Docker's 16 KB line-splitting — don't reintroduce raw token echoing to stdout).

### Request flow

`POST /v1/messages` → `parseBody` → `new ClaudeRequest(req).handleResponse(res, body, presetName)`:

1. `processRequestBody()` **mutates** the body: unshifts `{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }` as `system[0]` (Anthropic rejects the request without it), applies the preset, then `stripTtlFromCacheControl` and `filterSamplingParams`.
2. `makeRequest()` POSTs to `https://api.anthropic.com/v1/messages` with `getHeaders()`.
3. On **401**: clears the static token cache, `loadOrRefreshToken()`, retries **the already-processed body**. Processing exactly once is load-bearing — re-processing duplicated the system block and the preset suffix, shifting the prompt prefix and killing cache hits. `ClaudeRequest.test.js` asserts the two bodies are byte-identical.
4. `streamResponse()` branches on upstream `content-type`: `text/event-stream` → pipe straight through (plus the debug stream at DEBUG); otherwise buffer, `removeHeader('content-encoding')`, re-serialize JSON.

Upstream response headers are copied verbatim to the client via `copyUpstreamHeaders()` — except on the OpenAI path, where `content-length` and `content-encoding` are dropped because the body gets rewritten.

### OpenAI-compatible route

`POST /v1/chat/completions` (and `/chat/completions`, `/v1/<preset>/chat/completions`, plus a tolerated doubled `/v1`) → `new ClaudeRequest(req).handleOpenAIResponse(res, body, presetName)`, which translates the request and then calls **the same `handleResponse`** — so auth, the Claude Code system block, presets and the 401 retry are shared, not duplicated. Only the two edges differ:

- **In**: `OpenAICompat.toAnthropicRequest()` returns `{ body, meta }` and the meta is stashed on `this.openai`. That flag is the *only* thing distinguishing the two paths downstream.
- **Out**: `streamResponse()` short-circuits to `streamOpenAIResponse()` when `this.openai` is set. SSE goes through `createStreamTranslator()` (a `Transform`, placed **after** the debug stream so DEBUG still logs Anthropic events); JSON is buffered and reshaped; upstream errors become the OpenAI `{error:{...}}` envelope.

The request body is built as a **whitelist**, not a spread — Anthropic rejects unknown top-level fields, so `n`/`presence_penalty`/`seed`/etc. are dropped by never being copied. `GET /v1/models` (and `/models`, `/v1/models/<id>`) answers discovery probes from `KNOWN_MODELS`, overridable with `openai_models` in config.

Anthropic's message rules are stricter than OpenAI's, and `normalizeMessages()` exists entirely to bridge that: merge consecutive same-role turns, force a leading user turn, drop empty/blank blocks, and **close the conversation with a user turn**. Don't "simplify" it away.

That last rule is the non-obvious one. A trailing assistant turn means *prefill* to Anthropic but *plain history* to OpenAI, and models past Opus 4.6 reject prefill outright (`This model does not support assistant message prefill. The conversation must end with a user message.`). Clients that keep their state in system messages and send an assistant-only history — game mods do this constantly — hit that on every request, so a `(Continue.)` user turn is appended. `openai_allow_prefill=true` restores the Anthropic reading, and only then does the trailing-whitespace trim matter (Anthropic rejects trailing whitespace on a prefill). The native `/v1/messages` path is untouched by any of this — ST's prefill still works exactly as before.

### Auth precedence

`getAuthToken()` resolves in this order:

1. **`x-api-key` header containing `sk-ant`** — set in the constructor, cached in the `static cachedToken` with `cachedTokenIsApiKey = true`, used as-is (no expiry checking). In SillyTavern this is the "Proxy Password" field.
1b. **`Authorization: Bearer` matching `sk-ant-api`** — only when there's no `x-api-key`, for OpenAI-shaped clients that only have an "API key" field. Deliberately narrower than the `x-api-key` check: `sk-ant-oat*` (OAuth access) tokens must **not** be flagged as API keys or they lose the OAuth betas, and the dummy keys these clients send (`sk-1234`) must fall through to OAuth.
2. **OAuth tokens** — `~/.claude-code-proxy/tokens.json` via `OAuthManager.getValidAccessToken()` (auto-refreshes with a 1-minute buffer).
3. **Claude Code credentials** — `~/.claude/.credentials.json`, only when `fallback_to_claude_code` isn't `false`. On Windows it tries the native path first, then `wsl cat ~/.claude/.credentials.json`.

**The API-key vs OAuth distinction controls the beta headers, and getting it wrong is a hard failure.** Anthropic rejects `oauth-2025-04-20` / `claude-code-*` betas on a real API key. `getHeaders()` (sync path) always sends the OAuth set; `getBatchHeaders(token, isApiKey)` branches. Any new upstream call must make the same branch.

Note the caches are **static/process-wide**: one client sending an `sk-ant` key replaces the cached token for everyone. Tests must reset `ClaudeRequest.cachedToken`, `cachedTokenIsApiKey`, and `presetCache` in `beforeEach`.

### Preset-scoped URLs

Every route exists in a bare form and a preset-scoped form — `/v1/messages` and `/v1/<preset>/messages`, `/v1/messages/batches` and `/v1/<preset>/messages/batches`, `/v1/chat/completions` and `/v1/<preset>/chat/completions`. **When adding a route, match both.** `<preset>` names a file in `server/presets/` (e.g. `/v1/pyrite` → `presets/pyrite.json`), loaded lazily into `presetCache` — a failed load caches `null` so it isn't retried. Note the checked-in `pyrite.json` currently has **empty strings** for all three fields, so applying it is a no-op; use a scratch preset when testing that presets apply.

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
- `filter_sampling_params` — when true, drops one of `temperature`/`top_p` (Sonnet 4.5 rejects both); removes defaults of `1.0`, prefers temperature when both are non-default. Note this also eats an OpenAI `temperature` that clamped to exactly `1.0`
- `auto_open_browser`, `fallback_to_claude_code`
- `openai_default_model` / `openai_default_max_tokens` — fallbacks for the OpenAI route when the client sends a non-Claude model name or omits `max_tokens`; read at module load like the other `ClaudeRequest.js` flags. `openai_models` (read by `server.js`, so live) overrides the `/v1/models` list
- `openai_allow_prefill` — default false; see the OpenAI route section. Only affects `/v1/chat/completions`

Two module-level constants in `ClaudeRequest.js` are **not** config-driven: `STRIP_TTL` (currently `false`, so `cache_control.ttl` passes through despite the README saying it's stripped) and `TOKEN_REFRESH_METHOD` (`'OAUTH'`; the `CLAUDE_CODE_CLI` path throws).

## Testing notes

- `nock` intercepts `https://api.anthropic.com`. Header values come back as **strings, not arrays** — assert `String(headers['x-api-key'])`.
- `server/Logger` is `jest.mock`'d at the top of every test file (with `getLogLevel: () => 0`) — required, since `ClaudeRequest` calls `Logger.truncate`/`createDebugStream` on hot paths.
- **`server/server.test.js` re-implements its own copy of `handleRequest` rather than importing `server.js`** — it has already drifted (its `/auth/login` returns a 302 while the real server serves `static/login.html`). Passing OAuth route tests do not mean `server.js` routing works; add integration coverage against the real handler if you touch routing.
- `server.js` exports only `startServer`, not `handleRequest`, so end-to-end route coverage means booting the real server. The trick that works: copy `server/` to a scratch dir, rewrite `port` in its `config.txt` (the port comes from config, **not** an argument — mismatch it and you get a silent connection refusal), `require(copy + '/server.js').startServer()` **in the same process** as the `nock` interceptors, then hit `127.0.0.1:<port>` over real HTTP. Send `x-api-key: sk-ant-api03-...` to skip the OAuth path entirely.
- `server/OpenAICompat.test.js` covers the translation layer as pure functions plus `handleOpenAIResponse` end-to-end through `nock`; its mock `res` is a `PassThrough` with `writeHead`/`getHeader`/`removeHeader` added, which is the mock the older files should have had.
- `OAuthManager` is a singleton, so tests override `OAuthManager.tokenPath` to a `.test-tokens*` dir and reset `cachedToken`.

## Other directories

- `server/static/` — `login.html` (kicks off `/auth/get-url`, supports manual `code#state` paste) and `callback.html`.
- `util/` — standalone helper scripts, not part of the server. `claude-bearer.js` extracts a bearer token by running Claude Code and sniffing the header; `gemini-bearer.js` is the Gemini analogue; `claude-curl.txt` is a known-good curl.
- `Silly Tavern presets/` — Pyrite jailbreak preset for import into ST, mirroring `server/presets/pyrite.json`.
