#!/usr/bin/env bash
# 发一个版本：改版本号 + 提交 + 打 tag + 推送，剩下的交给 GitHub Actions。
#
#   ./scripts/release.sh patch     # 0.5.1 → 0.5.2
#   ./scripts/release.sh minor     # 0.5.1 → 0.6.0
#   ./scripts/release.sh 1.0.0     # 指定版本
#
# 行为：
#   1. 工作区必须干净（除本次发版外不要夹带改动）
#   2. npm version <bump> —— 自动改 package.json、提交、打 vX.Y.Z tag
#   3. 推送提交和 tag；tag 触发 .github/workflows/release.yml
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BUMP="${1:-patch}"
if [[ -n "$(git status --porcelain)" ]]; then
    echo "工作区不干净，先提交或 stash：" >&2
    git status --short >&2
    exit 1
fi

if ! npm test >/dev/null 2>&1; then
    echo "测试没通过，先修：npm test" >&2
    exit 1
fi

npm version "$BUMP" --commit-hooks=false
VERSION="$(node -p "require('./package.json').version")"
echo "==> 推送 v$VERSION"
git push --follow-tags
echo "==> Actions: https://github.com/$(git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?#\1#')/actions"
