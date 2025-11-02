#!/bin/bash
set -e
set -o pipefail

pause() {
    read -r -n 1 -s -p 'Press any key to continue. . .'
    echo
}
run() {
    echo "Running: $*" >&2
    while :; do
        local status=0
        bash -c "$*" || status=$?
        [[ $status == 0 ]] && break
        echo "Failed" >&2
        read -r -n 1 -s -p 'Press any key to retry or Ctrl+C to exit'
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
# run npx vsce verify-pat
# pause

: ''
run npx ncu -u
run npm i
run git add package.json package-lock.json
run git commit -m 'dependencies upgrade' ||:
echo 'deps upgraded'
pause
# '

run npm run type-check

run npm run lint

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
[ -z "$changes" ] && exit 1
echo changes:
echo "$changes"

version=$(npm version patch --no-git-tag-version)
echo version: $version
pause

sed -i $'/<!-- CHANGELOG_PLACEHOLDER -->/r'<(echo $'\n### '${version} $(date +"%Y-%m-%d")$'\n\n'"$changes") CHANGELOG.md

run git add README.md CHANGELOG.md package.json package-lock.json
run git commit -m "$version"
run git tag "$version"
echo 'patched package.json version patch, updated changelog, committed, tagged'
pause

run npx vsce package
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

run npx vsce publish
echo 'vsce published'
pause

run npx ovsx publish "$vsix_file" -p "$(cat ~/.open-vsx-access-token)"
echo 'ovsx published'
pause

run git push --tags origin master

if [[ -z $version || -z $changes || -z $vsix_file ]]; then
    echo version/changes empty
    exit 1
fi
echo 'will create github release'
pause
run gh release create "$version" --target master --title "$version" --notes "${changes@Q}" --verify-tag "${vsix_file@Q}"
echo 'github release created'