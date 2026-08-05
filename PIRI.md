# Piri

Piri is a ccc-node-oriented distribution of the Pi agent harness. It keeps Pi's provider-neutral agent loop for providers that expose supported coding-plan credentials and delegates providers with product-bound agent loops to dedicated ccc-node runtimes.

## Product boundary

- Piri owns the application identity, configuration directory, model aliases, operator experience, and versioned ccc-node launch contract.
- Pi remains the upstream source for the core TUI, agent loop, provider implementations, and extension API.
- ccc-node owns Telegram transport, workload routing, scheduling, policy, diagnostics, and cross-runtime session recovery.
- Upstream copyright and MIT license notices remain intact.

## Runtime layout

```text
Telegram
   |
ccc-node
   |-- PiriRuntime
   |     |-- OpenAI Codex via ChatGPT subscription
   |     |-- Kimi K3 via Kimi Code subscription
   |     `-- GLM via Z.AI Coding Plan
   `-- ClaudeRuntime
         `-- official Claude Code or Claude Agent SDK transport
```

Claude stays outside Piri's native model loop when subscription usage requires Anthropic's product-bound runtime. API-billed Anthropic models may still be used through Piri's native provider.

## Bootstrap decisions

- Product name and command: `piri`
- Default state directory: `~/.piri/agent`
- Upstream remote: `upstream` pointing to `earendil-works/pi`
- Internal package namespace: retain `@earendil-works/pi-*` until a Piri release boundary requires republishing
- Secrets: environment variables or owner-only auth storage; never source control or durable operating documentation

## Initial roadmap

1. Add stable Piri model aliases and provider selection policy.
2. Define the ccc-node `PiriRuntime` streaming and approval contract.
3. Add quota-aware routing for OpenAI Codex, Kimi Code, and GLM Coding Plan.
4. Keep Claude subscription sessions on `ClaudeRuntime` and normalize their events at the ccc-node boundary.
5. Add Piri-specific readiness and diagnostics without forking upstream provider internals unnecessarily.

## ccc-node launch and bootstrap contract

`scripts/piri-ccc.sh` is the versioned entrypoint for ccc-node. It runs the
built Piri CLI and accepts only non-secret policy through its environment:

| Variable | Purpose |
| --- | --- |
| `PIRI_CLI_PATH` | Optional executable override; defaults to the built `packages/coding-agent/dist/cli.js`. |
| `PIRI_DEFAULT_MODEL` | Optional provider-qualified default, such as `kimi-coding/k3`. An explicit ccc session `--model` wins. |
| `PIRI_DEFAULT_THINKING` | Optional default thinking level. An explicit ccc session `--thinking` wins. |
| `PIRI_BOOTSTRAP_CONTEXT_FILE` | Optional bounded ccc memory snapshot appended to Piri's system prompt at process start. |
| `PIRI_BOOTSTRAP_MAX_BYTES` | Maximum accepted snapshot size; defaults to 262144 bytes. |

The bootstrap file path, not its contents, appears in the child argv. The
launcher fails closed unless the file is a non-empty, readable, non-symlink
regular file owned by the Piri process user with no group/other permissions.
ccc-node owns atomic snapshot materialization and refresh timing. Piri owns
safe consumption at session start. Transcript extraction and Wiki/Honcho/local
writeback remain ccc-node responsibilities and are not implied by this read
bootstrap.

## Upstream synchronization

Piri changes should stay in small, clearly owned surfaces. Provider fixes and generally useful harness improvements should be suitable for upstreaming. Piri-only policy, branding, Telegram behavior, and ccc-node integration remain downstream.

## Deployment (this repo → a node)

This repo (`jinwon-int/piri`) is the canonical source for the Piri distribution.
`node_modules/` is **not** committed; a node rebuilds it. Per-node secrets and
the model launcher are **not** committed either (see `.gitignore`).

```bash
# 1. Clone, install without lifecycle scripts, and build from the frozen model
#    catalog shipped by this repository (Node >= 22).
git clone https://github.com/jinwon-int/piri.git /opt/piri
cd /opt/piri
npm ci --ignore-scripts
npm run build:offline

# 2. Provision provider credentials through Piri's interactive /login flow or
#    the node's owner-only secret manager. Never place credential values in a
#    launcher, command line, repository, deployment log, or Wiki page.

# 3. Wire ccc-node to the versioned launcher (systemd drop-in zz-piri.conf):
#    Environment="CCC_AGENT_PROVIDER=piri"
#    Environment="CCC_PIRI_CLI_PATH=/opt/piri/scripts/piri-ccc.sh"
#    Environment="PIRI_DEFAULT_MODEL=kimi-coding/k3"
#    Environment="PIRI_DEFAULT_THINKING=max"
#    Environment="PIRI_BOOTSTRAP_CONTEXT_FILE=/var/lib/ccc-node/piri-bootstrap.md"
#    (unset ANTHROPIC_*/CLAUDE_CODE_* so the Piri subprocess is not polluted)
```

Updating a node is `git pull --ff-only`, `npm ci --ignore-scripts`, then
`npm run build:offline`. The owner-only `~/.piri/agent/auth.json` remains
outside the checkout and is preserved across updates.

Upstream Pi is tracked via the `upstream` remote (`earendil-works/pi`); rebase or
cherry-pick generally-useful changes onto this distribution.
