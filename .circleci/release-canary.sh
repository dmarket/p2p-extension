#!/usr/bin/env bash
set -euo pipefail
set +x
[[ "${CIRCLE_BRANCH:-}" == codex/devops-320-identity-validation-20261105 ]] || exit 2
[[ "${CIRCLE_SHA1:-}" =~ ^[a-f0-9]{40}$ && "${CIRCLE_WORKFLOW_ID:-}" =~ ^[a-f0-9-]{36}$ ]] || exit 2
: "${RELEASE_TOKEN:?Scoped release wrapper required}"
for tool in git timeout node curl; do command -v "$tool" >/dev/null || exit 2; done
bounded_git() { timeout 30 git "$@"; }
repo="${REPO_SLUG:?}"
[[ "$repo" == "${CIRCLE_PROJECT_USERNAME:?}/${CIRCLE_PROJECT_REPONAME:?}" ]] || exit 2
ref="refs/heads/codex/devops-320-write-canary-20261105-${CIRCLE_PROJECT_REPONAME}-${CIRCLE_WORKFLOW_ID}"
[[ "$ref" == refs/heads/codex/devops-320-write-canary-20261105-* ]] || exit 2
remote="https://github.com/$repo.git"
new_sha=''
work=$(mktemp -d)
cleanup() {
  original=$?
  trap - EXIT
  if [[ -n "$new_sha" ]]; then
    lookup_ok=1
    tip=$(bounded_git ls-remote --heads "$remote" "$ref") || { echo 'Canary cleanup lookup failed' >&2; original=1; lookup_ok=0; }
    tip=${tip%%[[:space:]]*}
    if [[ "$lookup_ok" == 0 ]]; then
      : # Leave the remote ref untouched when its current value cannot be established.
    elif [[ -n "$tip" && "$tip" != "$new_sha" ]]; then
      echo 'Canary ref changed; refusing to delete another writer commit' >&2; original=1
    elif [[ "$tip" == "$new_sha" ]]; then
      bounded_git push --force-with-lease="$ref:$new_sha" "$remote" ":$ref" || original=1
    fi
    remaining=$(bounded_git ls-remote --heads "$remote" "$ref") || original=1
    [[ -z "${remaining:-}" ]] || original=1
    [[ "$original" != 0 ]] || echo 'CANARY_REF_REMOVED=true'
  fi
  rm -rf "$work"
  exit "$original"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
inventory=$(curl --fail --silent --show-error --connect-timeout 10 --max-time 30 https://api.github.com/installation/repositories)
printf '%s' "$inventory" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.total_count!==1||x.repositories.length!==1||x.repositories[0].full_name!==process.env.REPO_SLUG)process.exit(1)})'
denied=dmarket/terraform
code=$(curl --silent --show-error --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' "https://api.github.com/repos/$denied/contents/.circleci/config.yml")
[[ "$code" == 403 || "$code" == 404 ]] || { echo 'Out-of-repository HTTP denial not confirmed' >&2; exit 1; }
rc=0
bounded_git -c credential.helper= -c 'credential.helper=!f() { printf "%s\n" "username=x-access-token" "password=$RELEASE_TOKEN"; }; f' -c credential.useHttpPath=true -c "url.https://github.com/$denied.git.insteadOf=https://github.com/$denied.git" ls-remote "https://github.com/$denied.git" HEAD >"$work/denied.out" 2>"$work/denied.err" || rc=$?
[[ "$rc" != 0 && "$rc" != 124 ]] || exit 1
grep -Eiq 'repository not found|Repository not found|403|404|access denied' "$work/denied.err" || { echo 'Out-of-repository Git error was not an authorization denial' >&2; exit 1; }
default_before=$(bounded_git ls-remote "$remote" HEAD)
rc=0
bounded_git ls-remote --exit-code --heads "$remote" "$ref" >/dev/null || rc=$?
[[ "$rc" == 2 ]] || { echo 'Canary ref must be absent before creation' >&2; exit 1; }
bounded_git init -q "$work/repo"
bounded_git -C "$work/repo" fetch --depth=1 "$remote" "$CIRCLE_SHA1"
bounded_git -C "$work/repo" checkout -q --detach FETCH_HEAD
base=$(bounded_git -C "$work/repo" rev-parse HEAD)
[[ "$base" == "$CIRCLE_SHA1" ]] || exit 1
bounded_git -C "$work/repo" -c user.name='DEVOPS-320 bounded validation' -c user.email='devops320@example.invalid' commit --allow-empty -qm 'DEVOPS-320 bounded writer validation [skip ci]'
new_sha=$(bounded_git -C "$work/repo" rev-parse HEAD)
[[ "$(bounded_git -C "$work/repo" rev-parse HEAD^)" == "$base" ]] || exit 1
[[ "$(bounded_git -C "$work/repo" rev-parse HEAD^{tree})" == "$(bounded_git -C "$work/repo" rev-parse "$base^{tree}")" ]] || exit 1
bounded_git -C "$work/repo" push --force-with-lease="$ref:" "$remote" "HEAD:$ref"
[[ "$(bounded_git ls-remote --heads "$remote" "$ref" | cut -f1)" == "$new_sha" ]] || exit 1
[[ "$(bounded_git ls-remote "$remote" HEAD)" == "$default_before" ]] || { echo 'Default ref changed concurrently; cannot confirm stable baseline' >&2; exit 1; }
printf 'CANARY_BASE=%s\nCANARY_COMMIT=%s\nCANARY_REF=%s\nCANARY_PARENT_TREE_MATCH=true\nOUT_OF_REPO_HTTP=%s\nOUT_OF_REPO_GIT_DENIED=true\n' "$base" "$new_sha" "$ref" "$code"
