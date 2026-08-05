# Piri

Piri is a ccc-node-oriented distribution of the Pi agent harness. It keeps Pi's provider-neutral agent loop for providers that expose supported coding-plan credentials and delegates providers with product-bound agent loops to dedicated ccc-node runtimes.

## Product boundary

- Piri owns the application identity, configuration directory, model aliases, operator experience, and ccc-node adapter.
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

## Upstream synchronization

Piri changes should stay in small, clearly owned surfaces. Provider fixes and generally useful harness improvements should be suitable for upstreaming. Piri-only policy, branding, Telegram behavior, and ccc-node integration remain downstream.

## Deployment (this repo → a node)

This repo (`jinwon-int/piri`) is the canonical source for the Piri distribution.
`node_modules/` is **not** committed; a node rebuilds it. Per-node secrets and
the model launcher are **not** committed either (see `.gitignore`).

```bash
# 1. Clone to /opt/piri and install dependencies (Node >= 22; tsx runs on v24).
git clone https://github.com/jinwon-int/piri.git /opt/piri
cd /opt/piri && npm ci

# 2. Per-node model launcher (/opt/piri/piri-ccc.sh — NOT committed).
#    Pick the node's model:
cat > /opt/piri/piri-ccc.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec /opt/piri/piri-test.sh --model zai/glm-5.2 "$@"   # or kimi-coding/k3
SH
chmod 700 /opt/piri/piri-ccc.sh

# 3. Provider credentials in the Piri auth store (owner-only, never committed).
mkdir -p ~/.piri/agent && chmod 700 ~/.piri/agent
# zai node:
#   echo '{"zai":{"type":"api_key","key":"<ZAI_KEY>"}}' > ~/.piri/agent/auth.json
# kimi node:
#   echo '{"kimi-coding":{"type":"api_key","key":"<KIMI_KEY>"}}' > ~/.piri/agent/auth.json
chmod 600 ~/.piri/agent/auth.json

# 4. Wire ccc-node to the Piri runtime (systemd drop-in zz-piri.conf):
#    Environment="CCC_AGENT_PROVIDER=piri"
#    Environment="CCC_PIRI_CLI_PATH=/opt/piri/piri-ccc.sh"
#    (unset ANTHROPIC_*/CLAUDE_CODE_* so the Piri subprocess is not polluted)
```

Updating a node is then `git pull && npm ci` (the per-node `piri-ccc.sh` and
`~/.piri/agent/auth.json` are preserved across pulls because they are gitignored).

Upstream Pi is tracked via the `upstream` remote (`earendil-works/pi`); rebase or
cherry-pick generally-useful changes onto this distribution.
