#!/bin/bash
set -e
set -o pipefail

pause() {
    read -r -n 1 -s -p 'Press any key to continue. . .'
    echo
}

on_close() {
    echo "module.exports = require('./src/extension')" > main.js # revert
    rm -f worker.js # bundled only for packaging; dev loads src/worker.js
}
trap on_close EXIT

run() {
    while :; do
        echo "Running: $*" >&2
        local status=0
        bash -c "$*" || status=$?
        [[ $status == 0 ]] && break
        echo "Failed" >&2
        read -r -n 1 -s -p 'Press any key to retry or Ctrl+C to exit'
        echo
    done
}

echo update readme
pause

if ! [ -z "$(git status --porcelain)" ]; then
    echo 'git working tree not clean'
    # exit 1
fi

run git push --tags origin master --dry-run

# broken since somewhere between vsce 2.2.0 and 2.15.0
# run node_modules/.bin/vsce verify-pat
# pause

: ''
run node_modules/.bin/ncu -u -x '@types/vscode'
run npm i
run git add package.json package-lock.json
run git commit -m 'dependencies-upgrade'
echo 'deps upgraded'
pause
# '

run npm run type-check

run npm run lint

# main.js is different for bundle than for local testing, so we can skip the esbuild step in dev
# but still keep the same entrypoint in package.json for both scenarios
# @vscode/ripgrep is kept external so its rgPath (__dirname/../bin/rg) still resolves to the shipped binary.
# better-sqlite3 is a native N-API addon: keep it external so its prebuilds/*.node loader resolves at runtime
# from node_modules (esbuild cannot bundle a .node binary). N-API is ABI-stable, so the same prebuilds work
# under VS Code's Electron without a per-version rebuild; all target OS/arch binaries ship in one VSIX.
node_modules/.bin/esbuild src/extension.js --bundle --platform=node --outfile=main.js --external:vscode --external:@vscode/ripgrep --external:better-sqlite3
# the indexer runs in a separate worker thread; it is bundled to the root as worker.js (src/ is not shipped)
node_modules/.bin/esbuild src/worker.js --bundle --platform=node --outfile=worker.js --external:vscode --external:@vscode/ripgrep --external:better-sqlite3

echo built

echo built. manual tests:
pause

vscodium --extensionDevelopmentPath="$PWD" --disable-extensions
pause
pause

git fetch
changes=$(git log --reverse "$(git describe --tags --abbrev=0)".. --pretty=format:"%h___%B" |grep . |sed -E 's/^([0-9a-f]{6,})___(.)/- [`\1`](https:\/\/github.com\/phil294\/search++\/commit\/\1) \U\2/')

echo edit changelog
pause
changes=$(micro <<< "$changes")
[ -z "$changes" ] && echo 'no changes. will skip creating gh release but package anyway.' && pause
echo changes:
echo "$changes"

version=$(npm version patch --no-git-tag-version)
# version=v0.0.3
echo version: $version
pause

! [ -z "$changes" ] && \
    sed -i $'/<!-- CHANGELOG_PLACEHOLDER -->/r'<(echo $'\n### '${version} $(date +"%Y-%m-%d")$'\n\n'"$changes") CHANGELOG.md

run git add README.md package.json package-lock.json
! [ -z "$changes" ] && \
    run git add CHANGELOG.md
run git commit -m "$version"
run git tag "$version"
echo 'patched package.json version patch, updated changelog, committed, tagged'
pause

run node_modules/.bin/vsce package
vsix_file=$(ls -tr search-plusplus-*.vsix* |tail -1)
mv "$vsix_file" vsix-out/"$vsix_file"
vsix_file=vsix-out/"$vsix_file"
echo $vsix_file

run xdg-open "${vsix_file@Q}"
ls -hltr vsix-out
ls -hltr
echo 'check vsix package before publish'
pause
pause

echo 'install vsix and test'
pause
pause

run node_modules/.bin/vsce publish
echo 'vsce published'
pause

run node_modules/.bin/ovsx publish "$vsix_file" -p "$(cat ~/.open-vsx-access-token)"
echo 'ovsx published'
pause

run git push --tags origin master

if [[ -z $version || -z $vsix_file ]]; then
    echo version/changes empty
    exit 1
fi

if ! [ -z "$changes" ]; then
    echo 'will create github release'
    pause
    run gh release create "$version" --target master --title "$version" --notes "${changes@Q}" --verify-tag "${vsix_file@Q}"
    echo 'github release created'
else
    echo 'skipping github release creation since no changes'
fi