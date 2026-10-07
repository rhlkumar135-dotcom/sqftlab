#!/usr/bin/env bash
# Day 9 endpoint probe. Kept as a file because the agent shell is dash, which
# mangles array slicing — inline probes silently produced empty output.
T="Bearer cmtv5baxv0000pdjjbobt1ojr"
B="http://localhost:3101/api/sqftlab"

probe() {
  local label="$1"; shift
  local code
  code=$(curl -s -o /tmp/d9.out -w '%{http_code}' "$@")
  printf "  %-44s → %s\n" "$label" "$code"
  printf "     %s\n" "$(head -c 300 /tmp/d9.out)"
}

probe "capital-flow/overview (anon)"        "$B/capital-flow/overview"
probe "capital-flow/overview (elite)"       -H "Authorization: $T" "$B/capital-flow/overview"
probe "capital-flow/overview?months=12"     -H "Authorization: $T" "$B/capital-flow/overview?months=12"
probe "capital-flow/overview?months=abc"    -H "Authorization: $T" "$B/capital-flow/overview?months=abc"
probe "capital-flow/downtown-dubai (elite)" -H "Authorization: $T" "$B/capital-flow/downtown-dubai"
probe "capital-flow/zzz-nope (elite)"       -H "Authorization: $T" "$B/capital-flow/zzz-nope"
probe "communities/downtown-dubai/yield"    -H "Authorization: $T" "$B/communities/downtown-dubai/yield"
probe "communities/downtown-dubai/yield anon" "$B/communities/downtown-dubai/yield"
probe "communities/zzz-nope/yield"          -H "Authorization: $T" "$B/communities/zzz-nope/yield"
