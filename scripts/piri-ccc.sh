#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
	printf 'piri-ccc: %s\n' "$*" >&2
	exit 2
}

has_argument() {
	local expected="$1"
	shift
	local argument
	for argument in "$@"; do
		[[ "$argument" == "$expected" ]] && return 0
	done
	return 1
}

cli="${PIRI_CLI_PATH:-$ROOT/packages/coding-agent/dist/cli.js}"
if [[ "$cli" == */* ]]; then
	[[ -x "$cli" ]] || fail "PIRI_CLI_PATH is not executable: $cli"
else
	cli="$(command -v "$cli" 2>/dev/null || true)"
	[[ -n "$cli" ]] || fail "PIRI_CLI_PATH command was not found"
fi

launcher_args=()
default_model="${PIRI_DEFAULT_MODEL:-}"
if [[ -n "$default_model" ]] && ! has_argument --model "$@"; then
	[[ "$default_model" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] ||
		fail "PIRI_DEFAULT_MODEL must be a provider-qualified model id"
	launcher_args+=(--model "$default_model")
fi

default_thinking="${PIRI_DEFAULT_THINKING:-}"
if [[ -n "$default_thinking" ]] && ! has_argument --thinking "$@"; then
	case "$default_thinking" in
		off|minimal|low|medium|high|xhigh|max) ;;
		*) fail "PIRI_DEFAULT_THINKING is invalid" ;;
	esac
	launcher_args+=(--thinking "$default_thinking")
fi

bootstrap_file="${PIRI_BOOTSTRAP_CONTEXT_FILE:-}"
if [[ -n "$bootstrap_file" ]]; then
	max_bytes="${PIRI_BOOTSTRAP_MAX_BYTES:-262144}"
	[[ "$max_bytes" =~ ^[1-9][0-9]*$ ]] || fail "PIRI_BOOTSTRAP_MAX_BYTES must be a positive integer"
	[[ -e "$bootstrap_file" ]] || fail "bootstrap context file does not exist"
	[[ ! -L "$bootstrap_file" ]] || fail "bootstrap context file must not be a symlink"
	[[ -f "$bootstrap_file" && -r "$bootstrap_file" ]] || fail "bootstrap context file is not a readable regular file"

	file_owner="$(stat -c '%u' -- "$bootstrap_file")"
	[[ "$file_owner" == "$(id -u)" ]] || fail "bootstrap context file must be owned by the Piri process user"
	file_mode="$(stat -c '%a' -- "$bootstrap_file")"
	(( (8#$file_mode & 077) == 0 )) || fail "bootstrap context file must not be accessible by group or other users"
	file_bytes="$(wc -c < "$bootstrap_file")"
	(( file_bytes > 0 )) || fail "bootstrap context file must not be empty"
	(( file_bytes <= max_bytes )) || fail "bootstrap context file exceeds PIRI_BOOTSTRAP_MAX_BYTES"

	launcher_args+=(--append-system-prompt "$bootstrap_file")
fi

exec "$cli" "${launcher_args[@]}" "$@"
