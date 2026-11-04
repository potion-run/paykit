#!/usr/bin/env bash
# Vendor shallow git source mirrors under .agent_sources/github.com/<owner>/<repo>.
# Reference-only — never a runtime dependency. Refresh: ./scripts/vendor-agent-sources.sh --refresh
#
# The only sources are the three libraries this repo is built on: Effect, Alchemy and Foldkit.
# Refs are derived from the catalog in pnpm-workspace.yaml, so bumping a pin and re-running the
# script keeps the mirrors matched. A pin with no upstream tag fails instead of vendoring a guess.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${ROOT}/.agent_sources/github.com"
REFRESH=false

for arg in "$@"; do
  case "$arg" in
    --refresh) REFRESH=true ;;
    -h | --help)
      echo "Usage: $0 [--refresh]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

# Read one pin from the catalog block of pnpm-workspace.yaml — the single place a version lives.
catalog_pin() {
  awk -v key="$1" '
    /^catalog:[[:space:]]*$/ { inside = 1; next }
    inside && /^[^[:space:]#]/ { exit }
    inside {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (index(line, ":") == 0) next
      name = substr(line, 1, index(line, ":") - 1)
      gsub(/["\047]/, "", name)
      if (name != key) next
      value = substr(line, index(line, ":") + 1)
      sub(/#.*/, "", value)
      gsub(/["\047[:space:]]/, "", value)
      print value
      exit
    }
  ' "${ROOT}/pnpm-workspace.yaml"
}

# The catalog stores ranges; the upstream tag names the floor of that range.
catalog_version() {
  local pin
  pin="$(catalog_pin "$1")"
  if [[ -z "$pin" ]]; then
    echo "No catalog pin for $1 in pnpm-workspace.yaml." >&2
    exit 1
  fi
  echo "${pin}" | sed -E 's/^[[:space:]]*[~^>=<]+//'
}

require_tag() {
  local owner="$1" repo="$2" remote="$3" tag="$4"
  if ! git ls-remote --exit-code --refs "${remote}" "refs/tags/${tag}" >/dev/null; then
    echo "Cannot resolve ${owner}/${repo} tag ${tag}; fix the catalog pin before vendoring." >&2
    exit 1
  fi
}

require_version() {
  local owner="$1" repo="$2" package_path="$3" want="$4"
  local got
  got="$(node -p "require('${PREFIX}/${owner}/${repo}/${package_path}/package.json').version")"
  if [[ "$got" != "$want" ]]; then
    echo "${owner}/${repo} mirror is at ${got}, catalog pin is ${want}; refresh the mirror." >&2
    exit 1
  fi
}

clone_source() {
  local owner="$1" repo="$2" remote="$3" ref="$4" note="${5:-}"
  local dest="${PREFIX}/${owner}/${repo}"
  local metadata="${dest}/.agent-source.json"
  local commit=""

  if [[ -d "${dest}/.git" ]]; then
    if [[ "$REFRESH" != true ]]; then
      echo "skip ${owner}/${repo} (exists; pass --refresh to replace)"
      return 0
    fi
    rm -rf "$dest"
  elif [[ -e "$dest" ]]; then
    rm -rf "$dest"
  fi

  mkdir -p "$(dirname "$dest")"
  echo "clone ${owner}/${repo} @ ${ref}"
  git clone --depth 1 --branch "$ref" "$remote" "$dest"
  commit="$(git -C "$dest" rev-parse HEAD)"

  cat >"$metadata" <<EOF
{
  "type": "github-repo-source",
  "owner": "${owner}",
  "repo": "${repo}",
  "remote": "${remote}",
  "ref": "${ref}",
  "commit": "${commit}",
  "addedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "note": "${note:-Project-local shallow git source mirror. Refresh: ./scripts/vendor-agent-sources.sh --refresh}"
}
EOF

  echo "  -> ${dest} (${commit})"
}

EFFECT_VERSION="$(catalog_version effect)"
ALCHEMY_VERSION="$(catalog_version alchemy)"
FOLDKIT_VERSION="$(catalog_version foldkit)"

EFFECT_REF="effect@${EFFECT_VERSION}"
ALCHEMY_REF="v${ALCHEMY_VERSION}"
FOLDKIT_REF="foldkit@${FOLDKIT_VERSION}"

require_tag Effect-TS effect https://github.com/Effect-TS/effect.git "${EFFECT_REF}"
require_tag alchemy-run alchemy https://github.com/alchemy-run/alchemy.git "${ALCHEMY_REF}"
require_tag foldkit foldkit https://github.com/foldkit/foldkit.git "${FOLDKIT_REF}"

clone_source Effect-TS effect https://github.com/Effect-TS/effect.git "${EFFECT_REF}" \
  "Effect v4 monorepo matching the catalog effect pin ${EFFECT_VERSION}. Read packages/effect/src/ and AGENTS.md."
clone_source alchemy-run alchemy https://github.com/alchemy-run/alchemy.git "${ALCHEMY_REF}" \
  "Alchemy matching the catalog alchemy pin ${ALCHEMY_VERSION}. Read packages/alchemy/src/ and packages/cloudflare/."
clone_source foldkit foldkit https://github.com/foldkit/foldkit.git "${FOLDKIT_REF}" \
  "Foldkit matching the catalog foldkit pin ${FOLDKIT_VERSION}. Read packages/foldkit/src/."

require_version Effect-TS effect packages/effect "${EFFECT_VERSION}"
require_version alchemy-run alchemy packages/alchemy "${ALCHEMY_VERSION}"
require_version foldkit foldkit packages/foldkit "${FOLDKIT_VERSION}"

echo "done — agent sources under ${PREFIX}"
