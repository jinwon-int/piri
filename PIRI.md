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

The launcher resolves `#!/.../env <interpreter>` CLI shebangs through `PATH`
before exec. This is required on Termux when an isolated ccc-node subprocess
does not inherit libtermux-exec's `LD_PRELOAD` hook and Android therefore
cannot resolve `/usr/bin/env`. The source launcher similarly invokes tsx's
module through the resolved `node` binary instead of its `.bin` env shebang.

### Where this launcher sits in the ccc-node chain

ccc-node does not call this launcher directly. It calls its own `ccc-piri`
wrapper, which materializes the node memory snapshot and then execs the real
CLI:

```
CCC_PIRI_CLI_PATH=~/.claude/hooks/ccc-piri        # ccc-node wrapper (memory)
  └─ CCC_PIRI_REAL_CLI_PATH=<this launcher>       # scripts/piri-ccc.sh
       └─ PIRI_CLI_PATH=<the Piri CLI>
```

So the variable a node points at this launcher is **`CCC_PIRI_REAL_CLI_PATH`**,
not `CCC_PIRI_CLI_PATH`. Setting `CCC_PIRI_CLI_PATH` to this launcher removes
`ccc-piri` from the chain and silently drops ccc-node memory injection.

That also makes `PIRI_BOOTSTRAP_CONTEXT_FILE` **redundant on a node running
`ccc-piri`**: the wrapper already injects the snapshot as Piri's global context
file (`~/.piri/agent/AGENTS.md`). Setting both injects the same memory twice.
Use `PIRI_BOOTSTRAP_CONTEXT_FILE` only where Piri runs without the wrapper.

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

# 3. Wire ccc-node to the versioned launcher (systemd drop-in zz-piri.conf).
#    CCC_PIRI_CLI_PATH stays on ccc-node's own ccc-piri wrapper; the launcher
#    goes in CCC_PIRI_REAL_CLI_PATH. Pointing CCC_PIRI_CLI_PATH here instead
#    drops the wrapper and with it ccc-node memory injection.
#    Environment="CCC_AGENT_PROVIDER=piri"
#    Environment="CCC_PIRI_CLI_PATH=/root/.claude/hooks/ccc-piri"
#    Environment="CCC_PIRI_REAL_CLI_PATH=/opt/piri/scripts/piri-ccc.sh"
#    Environment="PIRI_DEFAULT_MODEL=kimi-coding/k3"
#    Environment="PIRI_DEFAULT_THINKING=max"
#    (unset ANTHROPIC_*/CLAUDE_CODE_* so the Piri subprocess is not polluted)
#
#    PIRI_BOOTSTRAP_CONTEXT_FILE is deliberately absent: ccc-piri already
#    materializes the snapshot into ~/.piri/agent/AGENTS.md, so setting it here
#    would inject the same memory twice. Set it only where Piri runs without
#    the wrapper.
#
#    Step 1's build is required before this: the launcher defaults
#    PIRI_CLI_PATH to packages/coding-agent/dist/cli.js and fails closed when
#    it is missing. A node still running Piri from source must either build or
#    set PIRI_CLI_PATH explicitly.
```

Updating a node is `git pull --ff-only`, `npm ci --ignore-scripts`, then
`npm run build:offline`. The owner-only `~/.piri/agent/auth.json` remains
outside the checkout and is preserved across updates.

Upstream Pi is tracked via the `upstream` remote (`earendil-works/pi`); rebase or
cherry-pick generally-useful changes onto this distribution.
