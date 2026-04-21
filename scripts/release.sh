#!/usr/bin/env bash
#
# Tag a release based on the version in discord/.claude-plugin/plugin.json.
# Run this AFTER the release PR has been merged to main.
#
# What it does:
#   1. Preflight: on main, clean, up to date, tag doesn't already exist.
#   2. Shows the commits that will be in the release and asks for confirmation.
#   3. Creates an annotated git tag, pushes it.
#   4. Creates a GitHub Release with auto-generated notes (or opens $EDITOR on
#      the very first release, where auto-notes would span the whole repo).
#
# See RELEASE.md for when and why to bump, and CLAUDE.md for the agent-facing
# summary.
#
# Usage:
#   scripts/release.sh
#
# No arguments. The version is read from plugin.json — single source of truth.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

MANIFEST="discord/.claude-plugin/plugin.json"

# ─── Preflight ───────────────────────────────────────────────────────

BRANCH=$(git symbolic-ref --short HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "error: release must be cut from main (currently on '$BRANCH')" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree not clean — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

git fetch origin --tags --quiet

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "error: local main ($LOCAL_SHA) differs from origin/main ($REMOTE_SHA)" >&2
  echo "  run: git pull --ff-only" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (used to read plugin.json)" >&2
  exit 1
fi

VERSION=$(jq -r '.version' "$MANIFEST")
if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "error: could not read .version from $MANIFEST" >&2
  exit 1
fi

TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists locally — bump the version in $MANIFEST first" >&2
  exit 1
fi

if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "$TAG"; then
  echo "error: tag $TAG already exists on origin — someone else released it, or the version needs bumping" >&2
  exit 1
fi

# ─── Find the previous release tag (for changelog scoping) ──────────

PREV_TAG=""
if git describe --tags --abbrev=0 HEAD >/dev/null 2>&1; then
  PREV_TAG=$(git describe --tags --abbrev=0 HEAD)
fi

# ─── Show what's going out ──────────────────────────────────────────

echo "Release plan"
echo "  tag:         $TAG"
echo "  commit:      $LOCAL_SHA"
echo "  previous:    ${PREV_TAG:-<none, first release>}"
echo

if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..HEAD"
else
  RANGE="HEAD"
fi

echo "Commits in this release (touching discord/):"
git log --oneline "$RANGE" -- discord/ | sed 's/^/  /' || true
echo
echo "All commits in this release:"
git log --oneline "$RANGE" | sed 's/^/  /'
echo

read -rp "Proceed with tag + GitHub release? [y/N] " CONFIRM
case "$CONFIRM" in
  y|Y) ;;
  *) echo "aborted"; exit 1 ;;
esac

# ─── Tag + push ─────────────────────────────────────────────────────

git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
echo "Tagged and pushed $TAG."
echo

# ─── GitHub release ─────────────────────────────────────────────────

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not installed — create the release manually:"
  echo "  gh release create $TAG --title '$TAG' --generate-notes"
  exit 0
fi

if [ -n "$PREV_TAG" ]; then
  # Incremental release — auto-generate notes from prior tag
  gh release create "$TAG" \
    --title "$TAG" \
    --generate-notes \
    --notes-start-tag "$PREV_TAG"
else
  # First release — auto-notes would span the whole repo history;
  # open $EDITOR instead so you can write a meaningful summary.
  echo "(first release — \$EDITOR will open for release notes)"
  gh release create "$TAG" --title "$TAG"
fi

echo
echo "Release created:"
gh release view "$TAG" --json url -q .url
echo
echo "Consumers can now:"
echo "  claude plugin update discord@Ricky-N/claude-discord-ops"
