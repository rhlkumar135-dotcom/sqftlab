#!/usr/bin/env python3
"""Bake the live register into src/data/snapshot.json.

Static deployments (and any moment the API is unreachable) serve data from this
snapshot, so the site shows the real register instead of placeholder figures.
Run against a running API server:

    python3 scripts/build-snapshot.py [base-url]

Defaults to http://127.0.0.1:3101. Commit the result so the build is
self-contained.
"""
import json
import subprocess
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3101"
LISTING_PAGES = 10  # the listings route pages at 20/page

ENDPOINTS = [
    "/api/sqftlab/stats",
    "/api/sqftlab/communities",
    "/api/sqftlab/deals",
    "/api/sqftlab/portfolio",
    "/api/sqftlab/watchlist",
    "/api/sqftlab/alerts",
    "/api/sqftlab/alerts/matches",
    "/api/sqftlab/alert-rules",
    "/api/sqftlab/me",
    "/api/sqftlab/markets",
    "/api/sqftlab/market/analytics",
    "/api/sqftlab/predictions",
    "/api/sqftlab/intelligence",
]

# The forecast page is per-district, so a single path-level snapshot would serve
# one district's projection for every district. Capture each one under its full
# URL (including the query) and let safeFetch prefer the exact-URL key.
FORECAST_MONTHS = 6

# Endpoints that resolve the caller from the request and answer 401 without a
# session, so they need the bootstrap header.
AUTH_ENDPOINTS = {
    "/api/sqftlab/portfolio",
    "/api/sqftlab/watchlist",
    "/api/sqftlab/alerts",
    "/api/sqftlab/alerts/matches",
    "/api/sqftlab/alert-rules",
}

SESSION_ID = None

MARKET_FILTERS = [
    "/api/sqftlab/markets?emirate=all&type=any",
    "/api/sqftlab/markets?emirate=dubai&type=any",
    "/api/sqftlab/markets?emirate=abu_dhabi&type=any",
    "/api/sqftlab/markets?emirate=sharjah&type=any",
    "/api/sqftlab/markets?emirate=all&type=apartment",
    "/api/sqftlab/markets?emirate=all&type=villa",
    "/api/sqftlab/markets?emirate=all&type=townhouse",
    "/api/sqftlab/markets?emirate=all&type=commercial",
]


def get(path, auth=False):
    cmd = ["curl", "-s", "--max-time", "25"]
    if auth and SESSION_ID:
        cmd += ["-H", f"Authorization: Bearer {SESSION_ID}"]
    cmd.append(BASE + path)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    if not out.strip():
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    # Account-scoped routes now answer 401 without a session. Never bake an error
    # envelope into the snapshot as if it were data — the static site would then
    # render an "Unauthorized" payload as the portfolio.
    if auth and isinstance(data, dict) and data.get("error"):
        return None
    return data


def bootstrap_session():
    """Ask /me who we are, the same way the browser does, so the authed endpoints
    above can be captured into the snapshot."""
    data = get("/api/sqftlab/me")
    if isinstance(data, dict):
        return ((data.get("user") or {}).get("id"))
    return None


def main():
    global SESSION_ID
    SESSION_ID = bootstrap_session()
    if SESSION_ID:
        print(f"  session: {SESSION_ID}")
    else:
        print("  session: none — account-scoped endpoints will be skipped")

    snap = {}
    for path in ENDPOINTS:
        data = get(path, path in AUTH_ENDPOINTS)
        if data is None:
            print(f"  {path:36} SKIP (empty or unreachable)")
            continue
        snap[path] = data
        print(f"  {path:36} ok")

    for path in MARKET_FILTERS:
        data = get(path)
        if data is not None:
            snap[path] = data
    print(f"  markets: {len(MARKET_FILTERS)} filter combinations captured")

    slugs = [c["slug"] for c in (snap.get("/api/sqftlab/communities", {}).get("communities") or [])]
    got = 0
    for slug in slugs:
        path = f"/api/sqftlab/forecast?district={slug}&months={FORECAST_MONTHS}"
        data = get(path)
        if data is None or not data.get("forecast"):
            continue
        snap[path] = data
        got += 1
    print(f"  forecast: {got}/{len(slugs)} districts captured")

    rows = []
    total = None
    for page in range(1, LISTING_PAGES + 1):
        data = get(f"/api/sqftlab/listings?purpose=sale&page={page}")
        if not isinstance(data, dict) or not data.get("listings"):
            break
        total = data.get("total") or total
        rows += data["listings"]

    if rows:
        snap["/api/sqftlab/listings"] = {"listings": rows, "total": total or len(rows)}
        with_image = sum(1 for r in rows if r.get("imageUrl"))
        with_link = sum(1 for r in rows if r.get("sourceUrl"))
        print(f"  listings: {len(rows)} (images {with_image}, source links {with_link})")

    if not snap:
        print("nothing fetched — is the API server running? snapshot NOT written")
        sys.exit(1)

    with open("src/data/snapshot.json", "w") as fh:
        json.dump(snap, fh, separators=(",", ":"))
    print(f"wrote src/data/snapshot.json (keys: {len(snap)})")


if __name__ == "__main__":
    main()
