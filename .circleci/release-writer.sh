#!/usr/bin/env bash
# Scope one native release command to the current repository; keep reader credentials unchanged.
set -euo pipefail
set +x
[[ "${1:-}" == -- && $# -gt 1 ]] || { echo 'Release command required' >&2; exit 2; }
shift
[[ "${CIRCLE_PROJECT_USERNAME:?}/${CIRCLE_PROJECT_REPONAME:?}" == dmarket/p2p-extension ]] || exit 2
export REPO_SLUG=dmarket/p2p-extension
case "$REPO_SLUG" in
  dmarket/frontend|dmarket/p2p-extension|dmarket/p2p-extension|dmarket/p2p-tracker-core|dmarket/steam-provenance)
    [[ "${RELEASE_WRITER_APP_ID:-}" == 5628442 && "${RELEASE_WRITER_INSTALLATION_ID:-}" == 178952329 ]] || exit 2 ;;
  MythicalGames/frontend-monorepo)
    [[ "${RELEASE_WRITER_APP_ID:-}" == 5628853 && "${RELEASE_WRITER_INSTALLATION_ID:-}" == 178951728 ]] || exit 2 ;;
  *) echo 'Repository outside release-writer scope' >&2; exit 2 ;;
esac
: "${RELEASE_WRITER_PRIVATE_KEY:?Disabled release context must be separately approved before use}"
RELEASE_TOKEN=''
cleanup() {
  original=$?
  trap - EXIT
  if [[ -n "${RELEASE_TOKEN:-}" ]]; then
    code=$(node -e 'process.stdout.write("header = "+JSON.stringify("Authorization: Bearer "+process.env.RELEASE_TOKEN)+"\n")' | command curl --config - --silent --show-error --connect-timeout 10 --max-time 20 --request DELETE --output /dev/null --write-out '%{http_code}' https://api.github.com/installation/token) || code=000
    if [[ "$code" != 204 ]]; then
      echo 'Installation token revocation failed; credential expires automatically' >&2
      [[ "$original" != 0 ]] || original=1
    else
      echo 'Installation token revoked (204)'
    fi
  fi
  unset RELEASE_TOKEN GH_TOKEN RELEASE_WRITER_PRIVATE_KEY RELEASE_JWT _RELEASE_RESPONSE
  exit "$original"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export RELEASE_JWT
RELEASE_JWT=$(node <<'JS'
const crypto=require('crypto');
const now=Math.floor(Date.now()/1000);
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
const unsigned=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iat:now-60,exp:now+540,iss:process.env.RELEASE_WRITER_APP_ID});
process.stdout.write(unsigned+'.'+crypto.sign('RSA-SHA256',Buffer.from(unsigned),process.env.RELEASE_WRITER_PRIVATE_KEY).toString('base64url'));
JS
)
export _RELEASE_RESPONSE
_RELEASE_RESPONSE=$(node <<'JS' | command curl --config - --fail --silent --show-error --connect-timeout 10 --max-time 40 "https://api.github.com/app/installations/$RELEASE_WRITER_INSTALLATION_ID/access_tokens"
const values={request:'POST',header:'Authorization: Bearer '+process.env.RELEASE_JWT,data:JSON.stringify({repositories:[process.env.CIRCLE_PROJECT_REPONAME],permissions:{contents:'write'}})};
for(const[k,v]of Object.entries(values))process.stdout.write(k+' = '+JSON.stringify(v)+'\n');
process.stdout.write('header = "Accept: application/vnd.github+json"\nheader = "Content-Type: application/json"\n');
JS
)
export RELEASE_TOKEN
RELEASE_TOKEN=$(node -e 'const x=JSON.parse(process.env._RELEASE_RESPONSE);if(typeof x.token!=="string"||!x.token)process.exit(1);process.stdout.write(x.token)')
node -e 'const p=JSON.parse(process.env._RELEASE_RESPONSE).permissions;if(!p||p.contents!=="write"||p.metadata!=="read"||Object.keys(p).some(k=>!["contents","metadata"].includes(k)))process.exit(1)'
unset RELEASE_WRITER_PRIVATE_KEY RELEASE_JWT _RELEASE_RESPONSE
# GH_TOKEN is an alias only inside this native release subprocess; the reader GITHUB_TOKEN is retained.
export GH_TOKEN="$RELEASE_TOKEN"
# Replace stale credential-bearing origins, even when a workspace restored an old checkout.
git remote set-url origin "https://github.com/${REPO_SLUG}.git"
add_git_config() {
  local n="${GIT_CONFIG_COUNT:-0}" key value
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  key="GIT_CONFIG_KEY_$n"; value="GIT_CONFIG_VALUE_$n"
  printf -v "$key" '%s' "$1"; printf -v "$value" '%s' "$2"
  export "$key" "$value"; export GIT_CONFIG_COUNT=$((n+1))
}
add_git_config "credential.https://github.com/${REPO_SLUG}.git.helper" ''
add_git_config "credential.https://github.com/${REPO_SLUG}.git.helper" '!f() { printf "%s\n" "username=x-access-token" "password=$RELEASE_TOKEN"; }; f'
add_git_config "credential.https://github.com/${REPO_SLUG}.git.useHttpPath" true
add_git_config "http.https://github.com/${REPO_SLUG}.git.extraheader" ''
add_git_config "url.https://github.com/${REPO_SLUG}.git.insteadOf" "https://github.com/${REPO_SLUG}.git"
# Native release scripts keep their existing curl calls, but Authorization is supplied only via stdin.
curl() {
  local arg next=0
  local -a clean=()
  while (($#)); do
    arg="$1"; shift
    if [[ "$arg" == -H || "$arg" == --header ]]; then
      [[ $# -gt 0 ]] || return 2
      if [[ "$1" == Authorization:* ]]; then shift; continue; fi
      clean+=("$arg" "$1"); shift
    else clean+=("$arg"); fi
  done
  local github=0 other=0
  for arg in "${clean[@]}"; do
    case "$arg" in
      https://api.github.com/*|https://uploads.github.com/repos/"$REPO_SLUG"/*) github=1 ;;
      http://*|https://*) other=1 ;;
      --location-trusted|--config|-K|--url|--url=*|--next|-k|--insecure) echo 'Unsupported release curl transport' >&2; return 2 ;;
    esac
  done
  [[ "$github" == 1 && "$other" == 0 ]] || { echo 'Release authorization is restricted to GitHub API/upload hosts' >&2; return 2; }
  node -e 'process.stdout.write("header = "+JSON.stringify("Authorization: Bearer "+process.env.RELEASE_TOKEN)+"\n")' | command curl --config - "${clean[@]}"
}
export -f curl
# Verify the issued token inventory before any native release command executes.
release_inventory=$(curl --fail --silent --show-error --connect-timeout 10 --max-time 30 https://api.github.com/installation/repositories)
printf '%s' "$release_inventory" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);if(x.total_count!==1||!Array.isArray(x.repositories)||x.repositories.length!==1||x.repositories[0].full_name!==process.env.REPO_SLUG)process.exit(1)})'
unset release_inventory
"$@"
