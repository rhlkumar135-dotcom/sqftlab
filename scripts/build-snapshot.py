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
    "/api/sqftlab/market/analytics",
    "/api/sqftlab/predictions",
    "/api/sqftlab/intelligence",
]


def get(path):
    out = subprocess.run(
        ["curl", "-s", "--max-time", "25", BASE + path],
        capture_output=True,
        text=True,
    ).stdout
    if not out.strip():
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def main():
    snap = {}
    for path in ENDPOINTS:
        data = get(path)
        if data is None:
            print(f"  {path:36} SKIP (empty or unreachable)")
            continue
        snap[path] = data
        print(f"  {path:36} ok")

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
