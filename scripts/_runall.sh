#!/usr/bin/env bash
# Runs every verify-* suite. Suites that WRITE rows run against a throwaway copy of
# the project database; the rest run against the project database via _env-guard.
# Written as a file because the agent shell is dash, which mangles inline loops.
set -u
cd "$(dirname "$0")/.."

pass=0; fail=0; failed_names=""

for f in scripts/verify-*.ts; do
  n=$(basename "$f" .ts)
  url=""
  case "$n" in
    verify-day9)  cp prisma/dev.db /tmp/day9-e2e.db;  url="file:/tmp/day9-e2e.db" ;;
    verify-day10) cp prisma/dev.db /tmp/day10-e2e.db; url="file:/tmp/day10-e2e.db" ;;
    # Positive-path deal-engine test. Named after the feature, not the day: its
    # guard requires the URL to contain "deal-e2e". Without a case here it would
    # run against the project database — but detectDeals() rewrites every isDeal
    # flag, so it would corrupt real state before its guard even mattered.
    verify-deal-engine) cp prisma/dev.db /tmp/deal-e2e.db; url="file:/tmp/deal-e2e.db" ;;
    verify-day11) cp prisma/dev.db /tmp/day11-e2e.db; url="file:/tmp/day11-e2e.db" ;;
    verify-day12) cp prisma/dev.db /tmp/day12-e2e.db; url="file:/tmp/day12-e2e.db" ;;
    verify-day13) cp prisma/dev.db /tmp/day13-e2e.db; url="file:/tmp/day13-e2e.db" ;;
    verify-day14) cp prisma/dev.db /tmp/day14-e2e.db; url="file:/tmp/day14-e2e.db" ;;
    verify-day15) cp prisma/dev.db /tmp/day15-e2e.db; url="file:/tmp/day15-e2e.db" ;;
    # Day 17's suites drive the RUNNING SERVER over HTTP, so they must write where the
    # server reads — a throwaway copy would put the fixtures somewhere the server never
    # looks, and every assertion would fail for the wrong reason. They scope their own
    # writes instead (throwaway users, deleted in a finally block) and refuse to run
    # against any database that is not this project's, which also protects them from the
    # shell's default DATABASE_URL pointing at the workspace-root stub. Routing is
    # read-mostly but creates two accounts for the IDOR check, so it gets the same guard.
    verify-day17) url="file:$(pwd)/prisma/dev.db" ;;
    verify-day17-routing) url="file:$(pwd)/prisma/dev.db" ;;
    # Day 16 goes over HTTP too, for the same reason: the gate and the `/mine` vs `/:id`
    # precedence are properties of the mounted app, not of a route handler, and it must
    # write its fixtures where the server reads them. Same guard, same scoped teardown.
    verify-day16) url="file:$(pwd)/prisma/dev.db" ;;
    # Named after the feature, not the day: its guard requires the URL to contain "cma-e2e".
    verify-day6-e2e) cp prisma/dev.db /tmp/cma-e2e.db; url="file:/tmp/cma-e2e.db" ;;
    verify-day*-e2e) d=$(echo "$n" | sed 's/^verify-//'); cp prisma/dev.db "/tmp/${d}.db"; url="file:/tmp/${d}.db" ;;
  esac

  if [ -n "$url" ]; then
    out=$(DATABASE_URL="$url" bun run "$f" 2>&1)
  else
    out=$(bun run "$f" 2>&1)
  fi
  code=$?

  # Each suite prints "<n> passed, <n> failed" or "<n>/<n>" style lines; take the
  # passed/failed pair when present, otherwise fall back to the exit code.
  line=$(printf '%s\n' "$out" | grep -oE '[0-9]+ passed, [0-9]+ failed' | tail -1)
  checks=$(printf '%s\n' "$out" | grep -cE '^  (✓|✗)')

  if [ "$code" -eq 0 ]; then
    pass=$((pass+1))
    printf "  PASS  %-26s %s\n" "$n" "${line:-exit 0}"
  else
    fail=$((fail+1))
    failed_names="$failed_names $n"
    printf "  FAIL  %-26s exit=%s  %s\n" "$n" "$code" "${line:-}"
    printf '%s\n' "$out" | grep -E '^  ✗' | head -6 | sed 's/^/          /'
  fi
  printf "        (%s individual checks)\n" "$checks"
done

echo
echo "  suites passed: $pass   failed: $fail"
[ -n "$failed_names" ] && echo "  failing:$failed_names"
exit $fail
