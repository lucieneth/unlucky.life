/* The viewport is meant to be a hard boundary. Rather than trust one screen
   size in a browser pane, replicate the seeding geometry and the orbit maths
   from index.html and prove containment across many sizes and many seeds.

   The constants below are read straight out of index.html so this cannot
   silently drift away from the real engine. */
import fs from 'node:fs';

const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const grab = (name) => {
  const m = page.match(new RegExp('const ' + name + '=([-\\d.]+)'));
  if (!m) throw new Error('constant not found in index.html: ' + name);
  return parseFloat(m[1]);
};
const consts = {};
for (const name of ['SPREAD_RATIO', 'VIS_RATIO', 'SIZE_SHARE', 'SPIN']) consts[name] = grab(name);
const nudgeMatch = page.match(/SPRITE_CAP=\d+,NUDGE=(\d+)/);
consts.NUDGE = parseInt(nudgeMatch[1], 10);
console.log('constants read from index.html:', consts);

// --- the exact furthest point the sprite painter can draw, in units of R ---
// lobes:     distance <= SPREAD_RATIO*R, radius <= 0.94R
// satellite: distance <= 1.02R,          radius <= 0.38R
const lobeReach = consts.SPREAD_RATIO + 0.94;
const satelliteReach = 1.02 + 0.38;
const trueReach = Math.max(lobeReach, satelliteReach);
console.log('furthest drawn point: ' + trueReach.toFixed(3) + 'R, VIS_RATIO = ' + consts.VIS_RATIO);

let failures = 0;
const check = (name, cond, extra = '') => {
  if (!cond) { failures++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
  else console.log('  ok    ' + name);
};

check('VIS_RATIO covers the furthest drawn point', consts.VIS_RATIO >= trueReach,
  'need >= ' + trueReach.toFixed(3) + ', have ' + consts.VIS_RATIO);

// --- replicate seedBubbles() geometry ---
function seed(w, h, rand) {
  const maxR = Math.max(8, (Math.min(w, h) / 2 - consts.NUDGE) * consts.SIZE_SHARE / consts.VIS_RATIO);
  const tiers = [[2, maxR * .8, maxR], [3, maxR * .34, maxR * .52], [5, 6, 20]];
  const out = [];
  for (const [count, min, max] of tiers) {
    for (let i = 0; i < count; i++) {
      const r = min + rand() * (max - min);
      const big = r > 26;
      const vis = big ? r * consts.VIS_RATIO : r;
      const place = k => {
        const lo = vis + consts.NUDGE, hi = k - vis - consts.NUDGE;
        if (hi <= lo) return { c: k / 2, a: 0 };
        const c = lo + rand() * (hi - lo);
        return { c, a: Math.min(c - lo, hi - c) };
      };
      const px = place(w), py = place(h);
      out.push({
        vis, ox: px.c, oy: py.c,
        ax: px.a * (.3 + rand() * .7),
        ay: py.a * (.3 + rand() * .7),
        phase: rand() * 6.283,
        rate: .9 + rand() * .2
      });
    }
  }
  return out;
}

// deterministic PRNG so a failure is reproducible
function makeRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const sizes = [
  [1920, 1080], [1536, 864], [1440, 900], [1366, 768], [1280, 720],
  [1024, 1366], [834, 1112], [820, 1180], [768, 1024],
  [430, 932], [414, 896], [390, 844], [375, 812], [360, 640], [320, 568],
  [2560, 1440], [3440, 1440], [1200, 400], [500, 1200]
];

let worstMargin = Infinity, worstAt = null, checked = 0;
for (const [w, h] of sizes) {
  for (let s = 0; s < 40; s++) {
    const blobs = seed(w, h, makeRand(s * 7919 + w * 31 + h));
    // walk a full revolution, plus a full cursor nudge in the worst direction
    const steps = 720;
    for (let i = 0; i <= steps; i++) {
      const spin = i / steps * 6.283;
      for (const b of blobs) {
        const t = spin * b.rate + b.phase;
        const x = b.ox + b.ax * Math.cos(t);
        const y = b.oy + b.ay * Math.sin(t);
        // worst case: the nudge pushes straight at the nearest edge
        const margin = Math.min(
          x - b.vis - consts.NUDGE, w - (x + b.vis + consts.NUDGE),
          y - b.vis - consts.NUDGE, h - (y + b.vis + consts.NUDGE)
        );
        if (margin < worstMargin) { worstMargin = margin; worstAt = w + 'x' + h + ' seed ' + s; }
        checked++;
      }
    }
  }
}
check('no blob ever crosses an edge, over ' + checked.toLocaleString() + ' samples',
  worstMargin >= 0, 'worst margin ' + worstMargin.toFixed(1) + 'px at ' + worstAt);
console.log('        tightest clearance: ' + worstMargin.toFixed(1) + 'px (' + worstAt + ')');

// --- size: are the blobs actually as large as containment allows? ---
for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 720], [390, 844]]) {
  const blobs = seed(w, h, makeRand(1));
  const widest = Math.max(...blobs.map(b => b.vis * 2));
  const ceiling = 2 * (Math.min(w, h) / 2 - consts.NUDGE) * consts.SIZE_SHARE;
  check(w + 'x' + h + ': largest blob ' + Math.round(widest) + 'px across, cap ' + Math.round(ceiling) + 'px (' + Math.round(widest / Math.min(w,h) * 100) + '% of the short side)',
    widest > ceiling * 0.75 && widest <= ceiling + 0.01);
}

// --- does anything actually move? ---
const moving = seed(1440, 900, makeRand(3));
const travel = moving.map(b => Math.round(Math.max(b.ax, b.ay) * 2));
check('every blob has a non-degenerate path', travel.every(t => t > 0), JSON.stringify(travel));
console.log('        sweep per blob (px): ' + travel.join(', '));
const turnSeconds = Math.round(6.283 / consts.SPIN / 60);
console.log('        one full revolution: ' + turnSeconds + 's at 60fps');

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
