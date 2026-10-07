#!/usr/bin/env python3
"""Flag `for` loops whose body awaits Prisma inside the iteration.

A per-item `await prisma.` inside a loop over N rows is N+1 round trips. Loops
that only build in-memory arrays are fine, so we only report the ones that
actually hit the database per iteration.
"""
import re
import sys
from pathlib import Path

LOOP = re.compile(r"^\s*(for\s*\(|for\s+await\s*\(|.*\.(?:map|forEach)\(\s*async)")
AWAIT_DB = re.compile(r"await\s+prisma\.|await\s+tx\.|await\s+ensureCommunity\(")


def loop_body(lines, start):
    """Yield lines belonging to the loop opened at `start` via brace depth."""
    indent = len(lines[start]) - len(lines[start].lstrip())
    depth = 0
    seen_brace = False
    for i in range(start, min(len(lines), start + 200)):
        line = lines[i]
        depth += line.count("{") - line.count("}")
        if "{" in line:
            seen_brace = True
        if i > start:
            stripped = line.strip()
            if seen_brace and depth <= 0:
                return
            if not seen_brace and stripped:
                yield i, line
                return
        yield i, line


def main(path):
    lines = Path(path).read_text().splitlines()
    found = []
    for i, line in enumerate(lines):
        if not LOOP.match(line):
            continue
        body = list(loop_body(lines, i))[1:]
        hits = [(j, ln) for j, ln in body if AWAIT_DB.search(ln)]
        if hits:
            found.append((i + 1, line.strip(), hits))

    for ln, header, hits in found:
        print(f"\n{path}:{ln}  {header}")
        for j, hl in hits:
            print(f"    {j + 1}: {hl.strip()[:110]}")
    print(f"\n{len(found)} loop(s) awaiting Prisma per iteration")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "custom-routes.ts"))
