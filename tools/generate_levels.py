"""Builds levels.js: one fixed layout per level, each one solvable by pure logic
(no guessing) starting from the green starting square.

How it works: for each level, try random layouts (from a fixed seed, so the
output is the same every run) until a logic solver can clear the whole board
from the starting square without guessing. The solver uses only deductions a
careful player could make: the numbers, and the mine counter.

Run:  python tools/generate_levels.py
"""
import json, os, random, sys, time

LEVEL_COUNT = 50


def level_dims():
    out, prev = [], 0
    for i in range(LEVEL_COUNT):
        t = i / (LEVEL_COUNT - 1)
        cols = int(8 + t * 22 + 0.5)
        rows = int(8 + t * 12 + 0.5)
        density = 0.10 + t * 0.13
        mines = max(prev + 1, int(cols * rows * density + 0.5))
        out.append((cols, rows, mines))
        prev = mines
    return out


class Board:
    def __init__(self, R, C, mine_set):
        self.R, self.C, self.N = R, C, R * C
        self.nb = []
        for i in range(self.N):
            r, c = divmod(i, C)
            self.nb.append([rr * C + cc for rr in range(r - 1, r + 2) for cc in range(c - 1, c + 2)
                            if (rr, cc) != (r, c) and 0 <= rr < R and 0 <= cc < C])
        self.mine = [False] * self.N
        for m in mine_set:
            self.mine[m] = True
        self.adj = [sum(self.mine[j] for j in self.nb[i]) for i in range(self.N)]
        self.total_mines = len(mine_set)


ENUM_NODE_LIMIT = 200_000


def solve(b, start):
    """Return True if the board can be fully cleared from `start` by logic alone."""
    N = b.N
    open_ = [False] * N
    flag = [False] * N
    opened = 0
    safe_target = N - b.total_mines

    def reveal(i):
        nonlocal opened
        stack = [i]
        while stack:
            j = stack.pop()
            if open_[j] or flag[j]:
                continue
            if b.mine[j]:
                raise RuntimeError('solver revealed a mine (bug)')
            open_[j] = True
            opened += 1
            if b.adj[j] == 0:
                stack.extend(k for k in b.nb[j] if not open_[k])

    reveal(start)
    while opened < safe_target:
        # Build constraints from opened numbers that still touch unknown cells.
        cons = []
        for i in range(N):
            if open_[i] and b.adj[i]:
                unk = [j for j in b.nb[i] if not open_[j] and not flag[j]]
                if unk:
                    need = b.adj[i] - sum(flag[j] for j in b.nb[i])
                    cons.append((frozenset(unk), need))

        safe, mines = set(), set()
        # 1) single-number rules
        for s, need in cons:
            if need == 0:
                safe |= s
            elif need == len(s):
                mines |= s
        # 2) pairwise rules
        if not safe and not mines:
            by_cell = {}
            for k, (s, _) in enumerate(cons):
                for j in s:
                    by_cell.setdefault(j, []).append(k)
            seen = set()
            for ks in by_cell.values():
                for a in ks:
                    for c in ks:
                        if a == c or (a, c) in seen:
                            continue
                        seen.add((a, c))
                        A, na = cons[a]
                        B, nb_ = cons[c]
                        only_b = B - A
                        only_a = A - B
                        if A <= B:
                            if nb_ - na == 0:
                                safe |= only_b
                            elif nb_ - na == len(only_b):
                                mines |= only_b
                        elif only_b and nb_ - na == len(only_b):
                            mines |= only_b
                            safe |= only_a
        # 3) full enumeration of each frontier group, plus the mine counter
        if not safe and not mines:
            safe, mines = enumerate_deduce(b, open_, flag, cons)
        if not safe and not mines:
            return False
        for j in mines:
            if not b.mine[j]:
                raise RuntimeError('solver flagged a safe square (bug)')
            flag[j] = True
        for j in safe:
            if not open_[j]:
                reveal(j)
    return True


def enumerate_deduce(b, open_, flag, cons):
    frontier = set()
    for s, _ in cons:
        frontier |= s
    interior = [i for i in range(b.N) if not open_[i] and not flag[i] and i not in frontier]
    remaining = b.total_mines - sum(flag)

    # Split the frontier into independent groups.
    cell_cons = {}
    for k, (s, _) in enumerate(cons):
        for j in s:
            cell_cons.setdefault(j, []).append(k)
    groups, done = [], set()
    for j in frontier:
        if j in done:
            continue
        comp, stack = [], [j]
        done.add(j)
        while stack:
            x = stack.pop()
            comp.append(x)
            for k in cell_cons[x]:
                for y in cons[k][0]:
                    if y not in done:
                        done.add(y)
                        stack.append(y)
        groups.append(comp)

    results = []  # per group: dict k -> (mine_mask, safe_mask), or None if too big
    for comp in groups:
        results.append((comp, enum_group(comp, cons, cell_cons)))

    # Which mine-count for each group is possible given the global mine count?
    ranges = []
    for comp, res in results:
        ranges.append(set(res.keys()) if res is not None else set(range(len(comp) + 1)))

    def sums(sets):
        acc = {0}
        for s in sets:
            acc = {a + x for a in acc for x in s if a + x <= remaining}
        return acc

    safe, mines = set(), set()
    I = len(interior)
    for gi, (comp, res) in enumerate(results):
        if res is None:
            continue
        others = sums(ranges[:gi] + ranges[gi + 1:])
        feasible = [k for k in res if any(0 <= remaining - k - s <= I for s in others)]
        if not feasible:
            continue
        mine_any = safe_any = 0
        for k in feasible:
            mine_any |= res[k][0]
            safe_any |= res[k][1]
        for idx, cell in enumerate(comp):
            bit = 1 << idx
            if not mine_any & bit:
                safe.add(cell)
            elif not safe_any & bit:
                mines.add(cell)
    if I:
        all_sums = sums(ranges)
        interior_counts = {remaining - s for s in all_sums if 0 <= remaining - s <= I}
        if interior_counts == {0}:
            safe |= set(interior)
        elif interior_counts == {I}:
            mines |= set(interior)
    return safe, mines


def enum_group(comp, cons, cell_cons):
    order = comp[:]  # BFS-ish order improves pruning
    idx = {c: i for i, c in enumerate(order)}
    con_ids = sorted({k for c in order for k in cell_cons[c]})
    need = {k: cons[k][1] for k in con_ids}
    left = {k: len(cons[k][0]) for k in con_ids}
    have = {k: 0 for k in con_ids}
    assign = [0] * len(order)
    out = {}
    nodes = 0

    def rec(pos, k_mines):
        nonlocal nodes
        nodes += 1
        if nodes > ENUM_NODE_LIMIT:
            raise OverflowError
        if pos == len(order):
            mm = sm = 0
            for i, v in enumerate(assign):
                if v:
                    mm |= 1 << i
                else:
                    sm |= 1 << i
            prev = out.get(k_mines)
            out[k_mines] = (mm, sm) if prev is None else (prev[0] | mm, prev[1] | sm)
            return
        cell = order[pos]
        cks = cell_cons[cell]
        for v in (0, 1):
            ok = True
            for k in cks:
                h = have[k] + v
                l = left[k] - 1
                if h > need[k] or h + l < need[k]:
                    ok = False
                    break
            if not ok:
                continue
            for k in cks:
                have[k] += v
                left[k] -= 1
            assign[pos] = v
            rec(pos + 1, k_mines + v)
            for k in cks:
                have[k] -= v
                left[k] += 1

    try:
        rec(0, 0)
    except OverflowError:
        return None
    return out


def make_level(n, cols, rows, mines):
    attempt = 0
    while True:
        rng = random.Random(n * 1_000_003 + attempt)
        sr = int(rows * (0.25 + rng.random() * 0.5))
        sc = int(cols * (0.25 + rng.random() * 0.5))
        pool = [r * cols + c for r in range(rows) for c in range(cols)
                if abs(r - sr) > 1 or abs(c - sc) > 1]
        mine_set = rng.sample(pool, mines)
        b = Board(rows, cols, mine_set)
        if solve(b, sr * cols + sc):
            return {'n': n, 'cols': cols, 'rows': rows, 'mines': mines,
                    'start': [sr, sc], 'layout': sorted(mine_set), 'attempts': attempt + 1}
        attempt += 1


def main():
    only = set(int(a) for a in sys.argv[1:])
    levels = []
    for n, (cols, rows, mines) in enumerate(level_dims(), 1):
        if only and n not in only:
            continue
        t0 = time.time()
        lv = make_level(n, cols, rows, mines)
        print(f'level {n:2d}: {cols}x{rows} {mines:3d} mines  attempts={lv["attempts"]:5d}  {time.time() - t0:6.1f}s', flush=True)
        levels.append(lv)
    if only:
        return
    path = os.path.join(os.path.dirname(__file__), '..', 'levels.js')
    with open(path, 'w', encoding='utf8') as f:
        f.write('// Generated by tools/generate_levels.py: do not edit by hand.\n')
        f.write('// Each level: board size, starting square [row, col], and mine positions (row * cols + col).\n')
        f.write('// Every layout was checked to be solvable from the starting square without guessing.\n')
        f.write('const LEVEL_DATA = [\n')
        for lv in levels:
            lv = {k: v for k, v in lv.items() if k != 'attempts'}
            f.write('  ' + json.dumps(lv, separators=(',', ':')) + ',\n')
        f.write('];\n')
    print('wrote levels.js')


if __name__ == '__main__':
    main()
