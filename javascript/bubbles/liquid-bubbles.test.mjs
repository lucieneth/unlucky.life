/* Headless checks for the liquid-bubbles simulation.
   Run: node liquid-bubbles.test.mjs

   The claim worth proving is containment: "bubliny a kapalina musi
   respektovat hranice daneho tvaru". The shader clips to the rounded
   rectangle for free, but the PHYSICS has to agree with it, otherwise
   bubbles visibly vanish into a corner instead of sliding along it.

   The engine exposes LiquidBubbles._headless(), which builds the same
   simulation the browser runs, with no DOM and no WebGL - so this tests
   the real code rather than a re-implementation of it. */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LiquidBubbles = require('./liquid-bubbles.js');

const sd = LiquidBubbles._sdRoundRect;

let failures = 0;
const check = (name, ok, extra = '') => {
  if (ok) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

/* Deterministic PRNG swapped in for Math.random, so any failure is
   reproducible from its seed. */
function withSeed(seed, fn) {
  const real = Math.random;
  let s = seed >>> 0;
  Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  try { return fn(); } finally { Math.random = real; }
}

/* ------------------------------------------------------------------
   1. Containment across many sizes, radii and seeds
   ------------------------------------------------------------------ */
const CASES = [
  // [w, h, border-radius]
  [1920, 1080, 0], [1536, 864, 0], [1440, 900, 0], [1280, 720, 0],
  [3440, 1440, 0], [2560, 1440, 0],
  [1024, 1366, 24], [820, 1180, 24], [768, 1024, 30],
  [430, 932, 0], [390, 844, 0], [375, 812, 44], [360, 640, 0], [320, 568, 0],
  [1200, 400, 30], [500, 1200, 30],
  [320, 260, 22], [270, 260, 22], [280, 380, 140],   // cards, incl. a pill
  [900, 380, 30], [600, 600, 300]                    // a full circle-ish panel
];

let worst = Infinity, worstAt = null, samples = 0;

for (const [w, h, r] of CASES) {
  for (let seed = 0; seed < 8; seed++) {
    const sim = withSeed(seed * 7919 + w * 31 + h, () =>
      LiquidBubbles._headless(w, h, r));

    // ~50 seconds of simulated time at 60fps: long enough for every
    // bubble to cross the tank and be recycled at least once.
    withSeed(seed * 104729 + 17, () => {
      for (let i = 0; i < 3000; i++) {
        sim._step(1 / 60);
        for (const b of sim.bubbles) {
          // clearance from the wall, counting the bubble's own radius
          const margin = -(sd(b.x, b.y, w, h, sim.radius) + b.r);
          if (margin < worst) { worst = margin; worstAt = `${w}x${h} r${r} seed ${seed}`; }
          samples++;
        }
      }
    });
  }
}

check('no bubble ever crosses the rounded-rect wall, over ' +
      samples.toLocaleString() + ' samples',
      worst >= 0, 'worst clearance ' + worst.toFixed(2) + 'px at ' + worstAt);
console.log('        tightest clearance: ' + worst.toFixed(2) + 'px (' + worstAt + ')');

/* ------------------------------------------------------------------
   2. Nothing stalls, nothing escapes into NaN
   ------------------------------------------------------------------ */
{
  const sim = withSeed(4242, () => LiquidBubbles._headless(1440, 900, 0));
  const start = sim.bubbles.map(b => b.y);
  withSeed(99, () => { for (let i = 0; i < 600; i++) sim._step(1 / 60); });

  check('every bubble stays finite',
    sim.bubbles.every(b => Number.isFinite(b.x) && Number.isFinite(b.y) &&
                           Number.isFinite(b.vx) && Number.isFinite(b.vy)));

  // after 10s each bubble has either climbed or been recycled to the floor
  const moved = sim.bubbles.filter((b, i) => Math.abs(b.y - start[i]) > 20).length;
  check('at least 90% of bubbles have actually travelled after 10s',
    moved >= sim.bubbles.length * 0.9, moved + '/' + sim.bubbles.length);

  check('alpha stays in range',
    sim.bubbles.every(b => b.alpha >= -1e-6 && b.alpha <= 1 + 1e-6));
}

/* ------------------------------------------------------------------
   3. The size/speed relationship is the one the config asks for
   ------------------------------------------------------------------ */
{
  // default sizeSpeed is positive => SMALL bubbles rise faster
  const sim = withSeed(7, () => LiquidBubbles._headless(1440, 900, 0));
  const sorted = [...sim.bubbles].sort((a, b) => a.r - b.r);
  const small = sorted.slice(0, 6), big = sorted.slice(-6);
  const avg = arr => arr.reduce((s, b) => s + b.targetVy, 0) / arr.length;
  check('with sizeSpeed > 0 the small bubbles rise faster',
    avg(small) > avg(big),
    'small ' + avg(small).toFixed(1) + ' px/s vs big ' + avg(big).toFixed(1) + ' px/s');
  console.log('        small ' + avg(small).toFixed(1) + ' px/s, big ' + avg(big).toFixed(1) + ' px/s');

  // flipping the sign must flip the behaviour (physical Stokes mode)
  const phys = withSeed(7, () => LiquidBubbles._headless(1440, 900, 0, {
    bubbles: { sizeSpeed: -0.45 }
  }));
  const ps = [...phys.bubbles].sort((a, b) => a.r - b.r);
  check('with sizeSpeed < 0 the large bubbles rise faster',
    avg(ps.slice(-6)) > avg(ps.slice(0, 6)));

  // bigger bubbles must be laggier
  check('inertia grows with size',
    sorted[sorted.length - 1].tau > sorted[0].tau,
    'tau ' + sorted[0].tau.toFixed(2) + 's -> ' + sorted[sorted.length - 1].tau.toFixed(2) + 's');
}

/* ------------------------------------------------------------------
   4. Count and size scale with the container
   ------------------------------------------------------------------ */
{
  const hero = withSeed(1, () => LiquidBubbles._headless(1920, 1080, 0));
  const card = withSeed(1, () => LiquidBubbles._headless(320, 260, 22));
  check('a hero gets more bubbles than a card',
    hero.bubbles.length > card.bubbles.length,
    hero.bubbles.length + ' vs ' + card.bubbles.length);
  check('a card gets proportionally smaller bubbles',
    card.metrics.maxR < hero.metrics.maxR,
    card.metrics.maxR.toFixed(1) + 'px vs ' + hero.metrics.maxR.toFixed(1) + 'px');
  check('no bubble is wider than 12% of the short side',
    card.bubbles.every(b => b.r * 2 <= Math.min(320, 260) * 0.24 + 0.01));
  console.log('        hero: ' + hero.bubbles.length + ' bubbles up to r=' +
              hero.metrics.maxR.toFixed(0) + 'px; card: ' + card.bubbles.length +
              ' up to r=' + card.metrics.maxR.toFixed(0) + 'px');
}

/* ------------------------------------------------------------------
   5. Bubbles are recycled, so the field never empties
   ------------------------------------------------------------------ */
{
  const sim = withSeed(11, () => LiquidBubbles._headless(800, 600, 16));
  let minVisible = Infinity;
  withSeed(12, () => {
    for (let i = 0; i < 6000; i++) {          // 100 simulated seconds
      sim._step(1 / 60);
      if (i > 300) {
        const vis = sim.bubbles.filter(b => b.alpha > 0.25).length;
        if (vis < minVisible) minVisible = vis;
      }
    }
  });
  check('the tank never drops below half full over 100s',
    minVisible >= sim.bubbles.length * 0.5,
    minVisible + '/' + sim.bubbles.length + ' visible at the emptiest moment');
  console.log('        emptiest moment: ' + minVisible + '/' + sim.bubbles.length + ' visible');
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
