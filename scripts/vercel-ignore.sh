#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand). Vercel reads the exit code:
#   0 = skip this deployment, 1 = build it. Any other code fails the deployment, so this
#   script only ever exits 0 or 1, and builds whenever anything is unclear.
# Skips pushes that only change tests, the laptop server, GitHub workflows or docs, to save
# Vercel Hobby deployment storage (every deployment keeps its own copy of the functions).
BASE="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$BASE" ]; then
  echo "No previous deployment to compare with: building."
  exit 1
fi
# Vercel's clone is shallow; fetch the last deployed commit if it isn't there.
if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=100 origin "$BASE" >/dev/null 2>&1 || { echo "Previous commit not available: building."; exit 1; }
fi
if git diff --quiet "$BASE" HEAD -- . ':(exclude)tests' ':(exclude)laptop-server' ':(exclude).github' ':(exclude)*.md' ':(exclude)docs' 2>/dev/null; then
  echo "Only tests, laptop server, workflows or docs changed since the last deployment: skipping the build."
  exit 0
fi
echo "App files changed: building."
exit 1
