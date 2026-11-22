// sokoban-solver: a push-optimal Sokoban solver, built for make.fun's sokoban-solver-01.
//
// Why this shape
// --------------
// The levels this competition draws are a one-square-wide hallway with small rooms opening off it, and a box
// pushed out of a room into the hallway can never be brought back: pushing it back through the door would need
// the player standing on the hallway's far side, and that is wall. So every box stays in the room it started
// in, the rooms are independent sub-problems, and a level's push optimum is exactly the sum of its rooms'
// optima. The solver therefore
//
//   1. splits the level into rooms: the squares of the player's row from which a box could never reach a goal
//      are cut away, and each connected part of what remains that holds boxes is a room;
//   2. solves each room on its own with a breadth-first search over pushes — a state is the boxes' squares
//      plus the player's reachable region, so the first solution found is push-optimal — pruning any push that
//      lands a box on a dead square or freezes a 2x2 block of walls and boxes with a box off its goal;
//   3. stitches the rooms' move strings together with plain walks along the hallway (walks are free: only
//      pushes are scored).
//
// If a level does not split into rooms, one push search over the whole level is the fallback, and a level that
// still will not solve is answered empty rather than illegally. Every decision is made by search work, never
// by the clock or any randomness, so two runs on the same set write byte-identical answers.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions in a fixed order: [dx, dy, the walk letter, the push letter].
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Search budgets, counted in states kept: work, never the clock, so the answers cannot vary between runs.
const ROOM_MAX_STATES = 600_000;
const WHOLE_MAX_STATES = 1_500_000;

/** A level in XSB text: width, height, walls (short rows and the outer frame padded as walls), goals, boxes, player. */
function parseLevel(text) {
  const rows = text
    .split('\n')
    .map((r) => (r.endsWith('\r') ? r.slice(0, -1) : r))
    .filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can still be pushed onto some goal, found by pulling boxes back from the
 * goals over open floor: a box on x - d can be pushed onto a live square x only when the square it lands on and
 * the square the player stands on, x - 2d's neighbour x - d aside, are both open — precisely, x - d open and the
 * stand square beyond it open. A box on any other square is dead weight: no solution moves it to a goal.
 */
function liveSquares(w, h, wall, goals) {
  const size = w * h;
  const live = new Uint8Array(size);
  const queue = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  for (const g of goals) {
    live[g] = 1;
    queue[qt++] = g;
  }
  while (qh < qt) {
    const x = queue[qh++];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (y < 0 || y >= size) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue[qt++] = y;
      }
    }
  }
  return live;
}

/** Flood the player's reachable region from `from` around walls and `occupied`, marking `seen` with `stamp`; return its lowest square. */
function floodRegion(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with some box off its goal. */
function frozenBlock(w, h, wall, occupied, isGoal, t) {
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      const ax = tx + ox;
      const ay = ty + oy;
      if (ax < 0 || ay < 0 || ax >= w - 1 || ay >= h - 1) continue;
      const a = ay * w + ax;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !isGoal[a]) || (occupied[b] && !isGoal[b]) || (occupied[c] && !isGoal[c]) || (occupied[d] && !isGoal[d])) return true;
    }
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and `occupied`, in lower-case LURD, or null when there is none. */
function walkPath(w, wall, occupied, from, to) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size);
  const queue = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  queue[qt++] = from;
  prev[from] = from;
  while (qh < qt) {
    const p = queue[qh++];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue[qt++] = q;
    }
  }
  if (prev[to] === -1) return null;
  const letters = [];
  for (let p = to; p !== from; p = prev[p]) letters.push(DIRS[how[p]][2]);
  return letters.reverse().join('');
}

/**
 * The push-optimal solution of a board {w, h, wall, goals, boxes, player}, as {pushes, moves} with the moves in
 * LURD (a lower letter a step, an upper one a push), or null when the search keeps `maxStates` states without
 * solving it. Breadth-first over pushes, so the first solution met is push-optimal.
 */
function solvePushes(board, maxStates) {
  const { w, h, wall, goals, boxes, player } = board;
  const size = w * h;
  const nb = boxes.length;
  if (nb === 0) return { pushes: 0, moves: '' };
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const allOnGoals = (flat, off) => {
    for (let i = 0; i < nb; i++) if (!isGoal[flat[off + i]]) return false;
    return true;
  };
  const live = liveSquares(w, h, wall, goals);
  for (const b of boxes) if (!live[b]) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in the order found, stored flat: each state's sorted boxes, the square the player stands on,
  // and the parent state's index. The visited key is the player region's lowest square followed by the boxes:
  // a number while that stays exact, a string of char codes beyond it.
  let cap = 1024;
  let sBoxes = new Int32Array(cap * nb);
  let sPlayer = new Int32Array(cap);
  let sParent = new Int32Array(cap);
  let count = 0;
  const numericKey = nb <= 5;
  const keyOf = (low, arr) => {
    if (numericKey) {
      let k = low;
      for (let i = 0; i < nb; i++) k = k * size + arr[i];
      return k;
    }
    let s = String.fromCharCode(low);
    for (let i = 0; i < nb; i++) s += String.fromCharCode(arr[i]);
    return s;
  };
  const addState = (arr, playerSq, parentIdx) => {
    if (count === cap) {
      cap *= 2;
      const nb2 = new Int32Array(cap * nb);
      nb2.set(sBoxes);
      sBoxes = nb2;
      const np = new Int32Array(cap);
      np.set(sPlayer);
      sPlayer = np;
      const nq = new Int32Array(cap);
      nq.set(sParent);
      sParent = nq;
    }
    const off = count * nb;
    for (let i = 0; i < nb; i++) sBoxes[off + i] = arr[i];
    sPlayer[count] = playerSq;
    sParent[count] = parentIdx;
    return count++;
  };

  const visited = new Map();
  for (const b of boxes) occupied[b] = 1;
  const startLow = floodRegion(w, wall, occupied, player, seen, ++stamp, stack);
  for (const b of boxes) occupied[b] = 0;
  addState(boxes, player, -1);
  visited.set(keyOf(startLow, boxes), 0);
  let found = allOnGoals(sBoxes, 0) ? 0 : -1;

  const cand = new Int32Array(nb);
  const cur = new Int32Array(nb);
  for (let head = 0; found < 0 && head < count; head++) {
    const off = head * nb;
    for (let i = 0; i < nb; i++) {
      cur[i] = sBoxes[off + i];
      occupied[cur[i]] = 1;
    }
    floodRegion(w, wall, occupied, sPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < nb && found < 0; bi++) {
      const b = cur[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, h, wall, occupied, isGoal, t);
        let key = null;
        if (!frozen) {
          for (let i = 0; i < nb; i++) cand[i] = cur[i];
          cand[bi] = t;
          cand.sort();
          const low = floodRegion(w, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(low, cand);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || visited.has(key)) continue;
        if (count >= maxStates) {
          for (let i = 0; i < nb; i++) occupied[cur[i]] = 0;
          return null;
        }
        const idx = addState(cand, b, head);
        visited.set(key, idx);
        if (allOnGoals(sBoxes, idx * nb)) found = idx;
      }
    }
    for (let i = 0; i < nb; i++) occupied[cur[i]] = 0;
  }
  if (found < 0) return null;

  // Walk the parent chain: for each push, walk the player to the push's stand square, then push.
  const chain = [];
  for (let s = found; s > 0; s = sParent[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let pPos = player;
  let curBoxes = boxes.slice();
  const occ = new Uint8Array(size);
  for (const s of chain) {
    const off = s * nb;
    const nxt = [];
    for (let i = 0; i < nb; i++) nxt.push(sBoxes[off + i]);
    let from = -1;
    let to = -1;
    for (const b of curBoxes) if (!nxt.includes(b)) from = b;
    for (const b of nxt) if (!curBoxes.includes(b)) to = b;
    const d = to - from;
    const k = DIRS.findIndex((dd) => dd[1] * w + dd[0] === d);
    for (const b of curBoxes) occ[b] = 1;
    const walk = walkPath(w, wall, occ, pPos, from - d);
    for (const b of curBoxes) occ[b] = 0;
    if (walk === null) return null;
    moves += walk + DIRS[k][3];
    pPos = from;
    curBoxes = nxt;
  }
  return { pushes: chain.length, moves };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of
 * the floor, and each connected part left that holds boxes is a room. Null when the level is no set of rooms:
 * a box starting in the hallway, a goal outside every part, or a part whose boxes and goals differ in number.
 */
function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const size = w * h;
  const live = liveSquares(w, h, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(size).fill(-1);
  const parts = [];
  const stack = new Int32Array(size);
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || comp[s] >= 0) continue;
    const id = parts.length;
    const squares = [];
    let n = 0;
    stack[n++] = s;
    comp[s] = id;
    while (n > 0) {
      const p = stack[--n];
      squares.push(p);
      const around = [p - w, p + w, p - 1, p + 1];
      for (const q of around) {
        if (q >= 0 && q < size && !wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = id;
          stack[n++] = q;
        }
      }
    }
    squares.sort((a, b) => a - b);
    parts.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) parts[comp[b]].boxes.push(b);
  for (const g of goals) {
    if (comp[g] < 0) return null;
    parts[comp[g]].goals.push(g);
  }
  if (parts.some((r) => r.boxes.length !== r.goals.length)) return null;
  const rooms = parts.filter((r) => r.boxes.length > 0);
  return rooms.length > 0 ? rooms : null;
}

/** Replay `moves` from (player, boxes); the end state, or null when a step is illegal. */
function applyMoves(w, wall, player, boxes, moves) {
  const delta = { u: -w, d: w, l: -1, r: 1 };
  let p = player;
  const bs = new Set(boxes);
  for (const ch of moves) {
    const d = delta[ch.toLowerCase()];
    if (d === undefined) return null;
    const q = p + d;
    if (wall[q]) return null;
    if (bs.has(q)) {
      const t = q + d;
      if (wall[t] || bs.has(t)) return null;
      bs.delete(q);
      bs.add(t);
    }
    p = q;
  }
  return { player: p, boxes: bs };
}

/** The moves that solve one level, or '' when no legal solving answer was found. */
function solveLevel(text) {
  const level = parseLevel(text);
  const { w, h, wall, goals, boxes, player } = level;
  if (player < 0 || boxes.length === 0) return '';
  const goalSet = new Set(goals);
  const solvedAll = (set) => {
    if (set.size !== goalSet.size) return false;
    for (const b of set) if (!goalSet.has(b)) return false;
    return true;
  };

  const rooms = roomsOf(level);
  if (rooms) {
    const row = Math.floor(player / w);
    let state = { player, boxes: new Set(boxes) };
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      // The room's doorstep: a square of the player's row beside one of the room's squares.
      let doorstep = -1;
      for (const s of room.squares) {
        for (const d of [-w, w]) {
          const t = s + d;
          if (t >= 0 && t < w * h && Math.floor(t / w) === row && !wall[t]) {
            doorstep = t;
            break;
          }
        }
        if (doorstep >= 0) break;
      }
      if (doorstep < 0) { ok = false; break; }
      const occ = new Uint8Array(w * h);
      for (const b of state.boxes) occ[b] = 1;
      const walk = walkPath(w, wall, occ, state.player, doorstep);
      if (walk === null) { ok = false; break; }
      const after = applyMoves(w, wall, state.player, state.boxes, walk);
      if (!after) { ok = false; break; }
      moves += walk;
      state = after;
      // The room on its own board: its squares and the hallway row open, everything else wall, so its boxes
      // can never leave it and the other rooms cannot interfere.
      const subWall = new Uint8Array(w * h).fill(1);
      for (const s of room.squares) subWall[s] = 0;
      for (let x = 0; x < w; x++) {
        const i = row * w + x;
        if (!wall[i]) subWall[i] = 0;
      }
      const sub = {
        w,
        h,
        wall: subWall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player: state.player,
      };
      const sol = solvePushes(sub, ROOM_MAX_STATES);
      if (!sol) { ok = false; break; }
      const done = applyMoves(w, wall, state.player, state.boxes, sol.moves);
      if (!done) { ok = false; break; }
      moves += sol.moves;
      state = done;
    }
    if (ok && solvedAll(state.boxes)) return moves;
  }

  // Fallback: one push-optimal search over the whole level.
  const sol = solvePushes(level, WHOLE_MAX_STATES);
  if (sol) {
    const end = applyMoves(w, wall, player, new Set(boxes), sol.moves);
    if (end && solvedAll(end.boxes)) return sol.moves;
  }
  return '';
}

for (const id of readdirSync(I).sort()) {
  let text;
  try {
    text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  } catch {
    continue;
  }
  let moves = '';
  try {
    moves = solveLevel(text);
  } catch {
    moves = '';
  }
  if (moves.length > 60_000) moves = '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
