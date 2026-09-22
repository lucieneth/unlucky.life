/*!
 * liquid-bubbles.js - v1.0.0 - no dependencies
 *
 * A rectangular "liquid-filled panel" background: a slab of tinted, slowly
 * churning liquid with air bubbles rising through it, bounded by the
 * container's own rounded rectangle. No disc, no circular mask - the shape
 * is whatever the container is.
 *
 * Usage:
 *   <link rel="stylesheet" href="liquid-bubbles.css">
 *   <script src="liquid-bubbles.js"></script>
 *   <script>LiquidBubbles.create('#hero', { bubbles:{ rise: 30 } });</script>
 *
 * Rendering - three draw calls per frame:
 *   1. liquid    -> offscreen texture (gradient + domain-warped veils + caustics)
 *   2. composite -> screen  (that texture + glass rim, vignette, grain, dither)
 *   3. bubbles   -> screen  (quads that REFRACT the pass-1 texture)
 * Physics runs on the CPU in CSS pixels. See _step() for the model.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiquidBubbles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
     1. CONFIGURATION
     Every knob lives here. Pass a partial object to create(); it is
     deep-merged over these defaults, and update() can change any of
     them at runtime.
     ============================================================ */
  var DEFAULTS = {

    /* --- palette -------------------------------------------------
       Seven stops, dark -> light. The liquid body is built from
       abyss/deep/violet, the suspended translucent veils from
       orchid/blush/sun, and `aqua` is the cool fringe that appears
       where light refracts through an edge. Keep them muted enough
       that text stays readable on top.                            */
    palette: {
      abyss:  '#111639',   // deepest shadow, bottom of the tank
      deep:   '#272a6d',   // main body of the liquid
      violet: '#543d90',   // mid tone
      orchid: '#9c5099',   // where the veils turn warm
      blush:  '#e7a7be',   // the pale pink resin swirls
      sun:    '#f4cbae',   // warm tropical highlight
      aqua:   '#4ab4c5'    // cool refraction fringe
    },

    /* --- the liquid body ---------------------------------------- */
    liquid: {
      scale:     1.15,   // zoom of the noise field (bigger = smaller features)
      flow:      0.055,  // how fast the liquid churns (very slow by design)
      opacity:   1.0,    // master opacity of the whole liquid layer. Below 1
                         // the container's own background-color (and then the
                         // page) shows through - set --lb-deep: transparent to
                         // blend the effect into an existing background.
      veil:      0.95,   // opacity of the pale suspended swirls, 0..1.5
      caustics:  0.10,   // light-through-liquid sparkle, 0..0.4
      soften:    1.6,    // composite blur radius in CSS px, 0 = off
      edge:      1.0,    // strength of the inner glass rim highlight
      vignette:  0.20,   // corner darkening, sells depth
      grain:     0.013,  // film grain
      dither:    0.006,  // anti-banding noise - leave on, gradients need it
      depth:     0.28,   // top-lit falloff: how much darker the bottom is

      /* How hard the vessel wall acts on the liquid itself, 0..1.5.
         The pigment field is infinite noise and the container only ever
         cropped a window of it, so at 0 a pool sails straight through the
         wall and the frame slices it. Raising this swaps that drift for one
         that wanders the same distances and returns, so the medium stays in
         the vessel. 0..1; the pigment blobs below do their own containment.
         An earlier version also squeezed the domain against the glass, which
         contained it but flattened every pool into a plane along the wall -
         the reason the blobs exist.                                       */
      wall:      0.0,

      /* The pigment as actual objects rather than as thresholds on noise.
         A warped noise field has no things in it, so it can only ever be
         compressed (which flattens its shapes against the wall) or folded
         (which caustics on the line it turns on). Round shapes that rebound
         need round shapes: these are metaballs, simulated on the CPU, which
         reverse off the wall the way they came and merge into each other on
         the way. `wobble` runs the same domain warp that shapes the medium
         through their outlines, so they read as poured resin rather than as
         circles. count:0 leaves the pools to the noise field, as before.
         POOL_MAX in the shader caps count at 12.                          */
      pools: {
        count:      0,
        minRadius:  0.17,   // fraction of the vessel's short side
        maxRadius:  0.35,
        speed:      0.021,  // short sides per second
        wobble:     0.17    // how hard the warp bends their outlines
      }
    },

    /* --- the bubbles -------------------------------------------- */
    bubbles: {
      count:     'auto', // 'auto' derives it from area * density
      density:   4.2,    // bubbles per 100k CSS px^2 when count is 'auto'
      minCount:  10,
      maxCount:  150,

      minRadius: 2.5,    // CSS px, before the viewport size scale
      maxRadius: 30,
      sizeBias:  2.3,    // >1 skews the distribution toward small bubbles

      rise:      26,     // px/s for a reference 10px bubble
      sizeSpeed: 0.45,   // >0 -> small bubbles rise FASTER (stylised, calm)
                         // <0 -> large ones faster (physical, Stokes-like)
      inertia:   0.85,   // seconds for a reference bubble to reach its target
                         // velocity; scales with size = heavier big bubbles
      drift:     10,     // px/s lateral sway amplitude
      wobble:    0.11,   // sway frequency in Hz
      jitter:    0.35,   // micro-flutter on top of the sway, 0..1

      cluster:   0.28,   // chance a respawn opens a vent for a small group
      ceiling:   0.17,   // top share of the height where bubbles slow down
      ceilingDrag: 2.0,  // how hard they brake against the surface
      fade:      1.8,    // seconds to fade out at the top / in at the bottom
      wallMargin: 6,     // px of clearance kept from the rounded-rect wall

      opacity:   0.95,   // master opacity of the bubble layer
      refraction: 0.55,  // how much each bubble lenses the liquid behind it
      highlight: 0.85,   // specular dot strength
      rim:       0.90,   // bright ring at the bubble edge
      glow:      0.55    // soft halo bleeding outside the bubble
    },

    /* --- shape --------------------------------------------------- */
    container: {
      radius: 'auto'     // 'auto' reads border-radius off the element,
                         // or give a number in CSS px
    },

    /* --- interactivity ------------------------------------------- */
    interaction: {
      enabled:  true,
      strength: 1.0,     // master multiplier for the cursor-driven flow
      radius:   190,     // px of influence around the pointer
      swirl:    0.55,    // rotational component, 0 = pure push
      parallax: 8        // px of depth-parallax across the pointer sweep
    },

    /* --- performance --------------------------------------------- */
    performance: {
      dprMax:      2,    // cap device pixel ratio
      liquidScale: 0.7,  // render the liquid pass at this fraction of full res
      adaptive:    true, // downgrade automatically if frames get slow
      minFps:      42
    },

    /* 'auto' honours prefers-reduced-motion; true/false forces it */
    motion: 'auto'
  };

  /* ============================================================
     2. SMALL UTILITIES
     ============================================================ */
  var isObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };

  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (base.hasOwnProperty(k)) out[k] = isObj(base[k]) ? merge(base[k], {}) : base[k];
    for (k in over) if (over.hasOwnProperty(k)) {
      out[k] = isObj(over[k]) && isObj(out[k]) ? merge(out[k], over[k]) : over[k];
    }
    return out;
  }

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var rand  = function (a, b) { return a + Math.random() * (b - a); };

  /** '#e7a7be' | '#abc' -> [r,g,b] in 0..1 */
  function hex2rgb(hex) {
    var h = String(hex).trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (h.length !== 6 || isNaN(n)) return [1, 0, 1];
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /**
   * Signed distance to a rounded rectangle. Negative inside, zero on the
   * wall, positive outside. This is the ONE definition of "the shape":
   * the physics and the shader both use it, so the bubbles can never
   * disagree with the visible border-radius.
   */
  function sdRoundRect(px, py, w, h, r) {
    r = Math.min(r, Math.min(w, h) / 2);
    var qx = Math.abs(px - w / 2) - (w / 2 - r);
    var qy = Math.abs(py - h / 2) - (h / 2 - r);
    var ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
  }

  /* ============================================================
     3. SHADERS
     ============================================================ */
  var PRECISION = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif'
  ].join('\n');

  // Shared value-noise + fbm. Cheap, smooth, and good enough for a body of
  // liquid that should look soft rather than detailed.
  var NOISE = [
    'float hash(vec2 p){',
    '  p = fract(p * vec2(123.34, 345.45));',
    '  p += dot(p, p + 34.345);',
    '  return fract(p.x * p.y);',
    '}',
    'float noise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i), b = hash(i + vec2(1.0,0.0));',
    '  float c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));',
    '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);',
    '}',
    // Five octaves, normalised to 0..1. Used for fine detail (caustics).
    'float fbm(vec2 p){',
    '  float v = 0.0, a = 0.5;',
    '  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
    '  for (int i = 0; i < 5; i++){ v += a * noise(p); p = m * p; a *= 0.5; }',
    '  return v / 0.96875;',
    '}',
    // Three octaves. The pigment pools want big smooth shapes, not wisps,
    // so the field that defines them deliberately has no fine detail.
    'float fbmS(vec2 p){',
    '  float v = 0.0, a = 0.55;',
    '  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);',
    '  for (int i = 0; i < 3; i++){ v += a * noise(p); p = m * p; a *= 0.5; }',
    '  return v / 0.9625;',
    '}'
  ].join('\n');

  /* Signed distance to the rounded rectangle, for the shaders. The CPU has
     its own copy above; both passes share this one so the liquid, the rim and
     the bubbles can never disagree about where the wall is. */
  var SHAPE = [
    'float sdRoundRect(vec2 p, vec2 b, float r){',
    '  vec2 q = abs(p) - b + r;',
    '  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;',
    '}'
  ].join('\n');

  // One big triangle covering the screen - cheaper than a quad, no seam.
  var VS_FULLSCREEN = [
    'attribute vec2 aPos;',
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  /* --- pass 1: the liquid body ------------------------------------
     A vertical sunset ramp through the palette, warped by two octaves
     of fbm fed back into itself (domain warping). That warp is what
     turns a plain gradient into something reading as pigment suspended
     in a viscous medium rather than a CSS gradient.                 */
  var FS_LIQUID = [
    PRECISION, NOISE,
    'uniform vec2  uRes;',
    'uniform float uTime, uScale, uFlow, uVeil, uCaustics, uSeed, uDepth;',
    'uniform float uWall, uPoolWobble, uPoolMix;',
    'uniform vec3  uPools[12];',
    'uniform vec2  uParallax;',
    'uniform vec3  uColors[7];',   // abyss deep violet orchid blush sun aqua
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  vec2 asp = vec2(uRes.x / max(uRes.y, 1.0), 1.0);',
    '  vec2 p = (uv - 0.5) * asp * uScale + uParallax;',
    '  float t = uTime * uFlow;',


    /* The drift. A wall the pigment cannot cross is only half of a vessel -
       the other half is a current that comes back, or everything simply queues
       up against one side and stays there. Translating linearly in t is what
       carried the field out of frame in the first place: it crossed the whole
       viewport in about two minutes and whatever led the way was gone for
       good, wall or no wall.

       These wander the same distances and return, so a pool travels, reaches
       the glass, piles up against it and rides back out on the way home. The
       frequencies are deliberately incommensurate - the three fields never
       come back into phase together, so the picture never actually repeats,
       and they never all stall at a turning point in the same frame.

       Mixed in by uWall rather than replacing the old drift outright, so
       wall:0 is still the original motion exactly. */
    '  float lw = clamp(uWall, 0.0, 1.0);',
    '  vec2  d1 = mix(vec2(0.0, t * 0.35),          vec2(sin(t * 0.51) * 0.52, sin(t * 0.37 + 1.7) * 0.80), lw);',
    '  vec2  d2 = mix(vec2(t * 0.22, -t * 0.18),    vec2(sin(t * 0.29 + 0.6) * 0.68, sin(t * 0.43 + 3.1) * -0.55), lw);',
    '  vec2  d3 = mix(vec2(-t * 0.12, t * 0.26),    vec2(sin(t * 0.33 + 2.2) * -0.47, sin(t * 0.47 + 0.9) * 0.74), lw);',

    // Domain warp: sample noise, then use it to displace the next sample.
    // This is what turns concentric blobs into poured, folded shapes.
    '  float w1 = fbmS(p + d1 + uSeed);',
    '  float w2 = fbmS(p * 1.3 + d2 + 5.2 + uSeed);',
    '  vec2  q  = vec2(w1, w2) - 0.5;',
    '  float n  = fbmS(p * 1.05 + q * 1.8 + d3);',

    // Contrast-stretch the field. Raw fbm clusters tightly around 0.5, which
    // is why an un-stretched version reads as haze instead of pigment.
    '  float m = clamp((n - 0.5) * 2.6 + 0.5, 0.0, 1.0);',

    /* The pigment blobs. Evaluated in a space normalised by the vessel's
       height, so it is isotropic and a blob is actually round rather than
       round-in-uv and oval on screen. The same warp q that folds the medium
       is run through the lookup first, which is what stops them reading as
       twelve circles: the outline wanders with the liquid while the body
       stays a blob.

       k*k falls to zero at the radius with a zero derivative, so two blobs
       meeting merge into one contour instead of crossing with a visible
       lens - the whole reason for a metaball rather than a distance test.
       Fixed loop bound because GLSL ES 1.0 wants one, and unused slots carry
       r = 0 and are multiplied out rather than branched around. */
    '  vec2  sp = vec2(uv.x * asp.x, uv.y) + q * uPoolWobble;',
    '  float pf = 0.0;',
    '  for (int i = 0; i < 12; i++){',
    '    vec3  b  = uPools[i];',
    '    vec2  dv = (sp - b.xy) / max(b.z, 1e-4);',
    '    float k  = max(0.0, 1.0 - dot(dv, dv)) * step(1e-3, b.z);',
    '    pf += k * k;',
    '  }',
    /* max(), not a replacement: the medium keeps its own poured pools, a
       touch weaker, and the blobs sit in it rather than instead of it.
       Feeding the blobs only their own field made the background go flat.
       Inside a blob the noise is centred on zero so it modulates the level
       rather than raising it, which is what keeps the interior from reading
       as one dead wash of colour. Crossfades back to the old behaviour when
       no blobs are configured. */
    '  m = mix(m, clamp(max(m - 0.10, pf * 0.90 + (m - 0.5) * 0.20), 0.0, 1.0), uPoolMix);',

    // --- body of the liquid: a deep vertical ramp, only slightly disturbed
    '  float g = clamp(uv.y * 0.90 + (m - 0.5) * 0.30, 0.0, 1.0);',
    '  vec3 col = mix(uColors[0], uColors[1], smoothstep(0.00, 0.52, g));',
    '  col = mix(col, uColors[2], smoothstep(0.44, 1.00, g) * 0.88);',

    // --- pools of pale pigment suspended in that body. Three nested
    // thresholds give each pool a warm rim, a blush field and a hot core,
    // which is what reads as resin poured into a slab rather than fog.
    /* No wall term here on purpose. An earlier version lifted the threshold
       near the glass, which closed each pool off neatly and was wrong: the
       pigment visibly evaporated at the edge instead of being turned round.
       Containment belongs entirely to the fold above, where it costs no
       pigment at all. */
    '  col = mix(col, uColors[3], smoothstep(0.46, 0.62, m) * uVeil * 0.55);',
    '  col = mix(col, uColors[4], smoothstep(0.58, 0.75, m) * uVeil * 0.80);',
    '  col = mix(col, uColors[5], smoothstep(0.76, 0.93, m) * uVeil * 0.50);',

    // cool fringe right at the outer boundary of a pool - reads as refraction
    '  float fringe = smoothstep(0.38, 0.46, m) - smoothstep(0.46, 0.56, m);',
    '  col += uColors[6] * fringe * 0.10;',

    // caustics: sharp ridges of a finer noise field, kept very faint
    '  float ca = fbm(p * 3.1 + q * 2.0 + vec2(t * 0.5, -t * 0.4));',
    '  float caust = pow(1.0 - abs(ca * 2.0 - 1.0), 14.0);',
    '  col += (uColors[5] * 0.6 + vec3(0.22)) * caust * uCaustics;',

    // light enters from above: the tank is darker at the bottom
    '  col *= (1.0 - uDepth) + uDepth * 2.0 * smoothstep(-0.1, 1.1, uv.y);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* --- pass 2: composite to screen --------------------------------
     Adds everything that belongs to the PANEL rather than to the
     liquid: the inner glass rim, the top sheen, a vignette, grain and
     dithering.                                                      */
  var FS_COMPOSITE = [
    PRECISION,
    'uniform sampler2D uTex;',
    'uniform vec2  uRes;',
    'uniform float uRadius, uEdge, uVignette, uGrain, uDither, uTime, uSoften;',
    SHAPE,
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  vec3 c;',
    // 5-tap softening - a real, controllable blur on the liquid only
    '  if (uSoften > 0.01){',
    '    vec2 o = uSoften / uRes;',
    '    c  = texture2D(uTex, uv).rgb * 0.36;',
    '    c += texture2D(uTex, uv + vec2( o.x, 0.0)).rgb * 0.16;',
    '    c += texture2D(uTex, uv + vec2(-o.x, 0.0)).rgb * 0.16;',
    '    c += texture2D(uTex, uv + vec2(0.0,  o.y)).rgb * 0.16;',
    '    c += texture2D(uTex, uv + vec2(0.0, -o.y)).rgb * 0.16;',
    '  } else { c = texture2D(uTex, uv).rgb; }',

    // distance from the wall, in px, positive inside
    '  float dist = -sdRoundRect(gl_FragCoord.xy - uRes * 0.5, uRes * 0.5, uRadius);',

    // glass rim: a soft inner glow plus a hairline right at the wall
    '  float glow = exp(-max(dist, 0.0) / max(uRes.y * 0.10, 1.0));',
    '  float line = 1.0 - smoothstep(0.0, 2.2, max(dist, 0.0));',
    '  c += vec3(1.0, 0.95, 0.99) * (glow * 0.085 + line * 0.16) * uEdge;',

    // light entering the top surface
    '  c += vec3(1.0, 0.97, 1.0) * exp(-(uRes.y - gl_FragCoord.y) / max(uRes.y * 0.30, 1.0)) * 0.05 * uEdge;',

    '  float v = length((uv - 0.5) * vec2(uRes.x / max(uRes.y, 1.0), 1.0));',
    '  c *= 1.0 - smoothstep(0.35, 1.05, v) * uVignette;',

    // dither kills the banding a big smooth gradient would otherwise show
    '  float rnd = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime) * 43758.5453);',
    '  c += (rnd - 0.5) * (uDither + uGrain);',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  /* --- pass 3: the bubbles ----------------------------------------
     One padded quad per bubble. The fragment shader treats the disc as
     a sphere: it reconstructs a normal, uses it to offset a lookup into
     the liquid texture (refraction), then adds fresnel, a rim and two
     specular dots on top.                                            */
  var VS_BUBBLE = [
    'attribute vec2  aCorner;',   // -1..1 quad corner
    'attribute vec2  aCenter;',   // device px, y up
    'attribute float aRadius;',   // device px
    'attribute float aSeed;',
    'attribute float aAlpha;',
    'uniform   vec2  uRes;',
    'uniform   float uPad;',
    'varying   vec2  vLocal;',    // |vLocal| == 1 exactly on the surface
    'varying   vec2  vUv;',
    'varying   float vRadius, vSeed, vAlpha;',
    'void main(){',
    '  vec2 pos = aCenter + aCorner * (aRadius * uPad);',
    '  vLocal  = aCorner * uPad;',
    '  vUv     = pos / uRes;',
    '  vRadius = aRadius; vSeed = aSeed; vAlpha = aAlpha;',
    '  gl_Position = vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_BUBBLE = [
    PRECISION,
    'uniform sampler2D uTex;',
    'uniform vec2  uRes;',
    'uniform float uRefract, uHighlight, uRim, uGlow, uOpacity, uTime;',
    'uniform vec3  uSpec, uTint;',
    'varying vec2  vLocal, vUv;',
    'varying float vRadius, vSeed, vAlpha;',
    'void main(){',
    '  float d = length(vLocal);',
    '  if (d > 1.45) discard;',

    // a bubble in a moving liquid is never a perfect circle
    '  float ang = atan(vLocal.y, vLocal.x);',
    '  d /= 1.0 + 0.013 * sin(ang * 2.0 + uTime * 1.1 + vSeed * 6.283)',
    '           + 0.008 * sin(ang * 3.0 - uTime * 0.8 + vSeed * 3.0);',

    // antialias in normalised units: 1.6 device px wide, whatever the size
    '  float aa   = 1.6 / max(vRadius, 2.0);',
    '  float mask = 1.0 - smoothstep(1.0 - aa, 1.0, d);',

    '  float dc   = min(d, 1.0);',
    '  float z    = sqrt(max(0.0, 1.0 - dc * dc));',
    '  float fres = pow(1.0 - z, 3.0);',   // grazing angles reflect most

    // refraction: push the lookup along the surface normal, and split the
    // channels slightly so the edge picks up a faint chromatic fringe
    '  vec2 off = vLocal * uRefract * (vRadius / uRes) * (0.35 + 0.65 * fres);',
    '  vec3 behind = vec3(',
    '    texture2D(uTex, clamp(vUv - off * 1.07, 0.003, 0.997)).r,',
    '    texture2D(uTex, clamp(vUv - off,        0.003, 0.997)).g,',
    '    texture2D(uTex, clamp(vUv - off * 0.93, 0.003, 0.997)).b);',

    // air is lighter than the liquid around it
    '  vec3 col = mix(behind, behind * 1.14 + uTint * 0.10, 0.62);',

    // contact shading along the lower edge grounds the sphere
    '  col *= 1.0 - smoothstep(0.55, 1.0, d) * smoothstep(0.25, -0.65, vLocal.y) * 0.18;',

    '  float rim = smoothstep(0.80, 0.995, d) * (1.0 - smoothstep(0.985, 1.0, d));',
    '  col += uSpec * rim * uRim * (0.55 + 0.45 * fres);',

    // key highlight up-left, soft bounce down-right
    '  vec2 h1 = vLocal - vec2(-0.40,  0.44); float s1 = exp(-dot(h1, h1) * 16.0);',
    '  vec2 h2 = vLocal - vec2( 0.34, -0.42); float s2 = exp(-dot(h2, h2) *  7.0);',
    '  col += uSpec * (s1 + s2 * 0.30) * uHighlight;',

    // the halo lives OUTSIDE the surface, so it is composited separately
    '  float halo = exp(-(d - 1.0) * (d - 1.0) * 20.0) * step(1.0, d);',

    '  float inner = 0.28 + 0.50 * fres + rim * 0.60 + s1 * 1.10 + s2 * 0.35;',
    '  float aIn   = clamp(inner, 0.0, 1.0) * mask;',
    '  float aHalo = halo * uGlow * 0.22 * (1.0 - mask);',
    '  float a     = aIn + aHalo;',
    '  if (a < 0.002) discard;',
    '  vec3 outc = (col * aIn + uSpec * aHalo) / a;',
    '  a *= vAlpha * uOpacity;',
    '  gl_FragColor = vec4(outc * a, a);',   // premultiplied
    '}'
  ].join('\n');

  /* ============================================================
     4. WEBGL HELPERS
     ============================================================ */
  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('[LiquidBubbles] shader: ' + log);
    }
    return s;
  }

  function program(gl, vsSrc, fsSrc) {
    var p = gl.createProgram();
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('[LiquidBubbles] link: ' + gl.getProgramInfoLog(p));
    }
    // cache every uniform and attribute location up front
    var i, n, info, u = {}, a = {};
    n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (i = 0; i < n; i++) {
      info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (i = 0; i < n; i++) {
      info = gl.getActiveAttrib(p, i);
      a[info.name] = gl.getAttribLocation(p, info.name);
    }
    return { p: p, u: u, a: a };
  }

  /* ============================================================
     5. A BUBBLE
     Plain data + the respawn rule. All units are CSS px, and y points
     UP (y = 0 is the floor of the tank) so "rise" is simply a
     positive vy.
     ============================================================ */
  function Bubble() {
    this.x = 0; this.y = 0; this.r = 0;
    this.vx = 0; this.vy = 0;
    this.phase = 0; this.wobbleSpeed = 0; this.wobbleAmp = 0;
    this.tau = 1; this.targetVy = 0;
    this.alpha = 0; this.fadingOut = false;
    this.seed = 0; this.depth = 0;
  }

  /* ============================================================
     6. MAIN CLASS
     ============================================================ */
  function LB(target, options) {
    this.el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!this.el) throw new Error('[LiquidBubbles] target not found: ' + target);

    this.cfg = merge(DEFAULTS, options || {});
    this.bubbles = [];
    this.pools = [];
    this.poolData = new Float32Array(36);   // 12 * vec3
    this.spawnQueue = null;      // pending cluster, see _respawn()
    this.w = 0; this.h = 0; this.dpr = 1; this.radius = 0;
    this.time = 0; this.raf = 0; this.last = 0;
    this.running = false; this.visible = true; this.destroyed = false;
    this.seed = Math.random() * 100;
    this.tier = 0;               // adaptive quality tier, 0 = best
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.vertCount = 0;

    this.pointer = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, on: false, has: false };
    this.parallax = { x: 0, y: 0, tx: 0, ty: 0 };

    this._build();
  }

  LB.prototype._build = function () {
    var self = this, el = this.el;

    if (!el.classList.contains('lb')) el.classList.add('lb');
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lb__canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    el.insertBefore(this.canvas, el.firstChild);

    // decorative glass overlay (pure CSS - see liquid-bubbles.css)
    this.glass = document.createElement('div');
    this.glass.className = 'lb__glass';
    this.glass.setAttribute('aria-hidden', 'true');
    el.insertBefore(this.glass, this.canvas.nextSibling);

    this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
    this._onMotion = function () { self._applyMotion(); };
    if (this.motionQuery.addEventListener) this.motionQuery.addEventListener('change', this._onMotion);
    else this.motionQuery.addListener(this._onMotion);

    if (!this._initGL()) { this._fallback(); return; }

    this._resize();
    this._spawn(true);

    // Observers: resize with the element, sleep when off screen or hidden.
    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(function () { self._resize(); });
      this.ro.observe(el);
    } else {
      this._onWinResize = function () { self._resize(); };
      addEventListener('resize', this._onWinResize);
    }
    if (window.IntersectionObserver) {
      this.io = new IntersectionObserver(function (entries) {
        self.visible = entries[0].isIntersecting;
        if (self.visible) self.resume(); else self.pause();
      }, { threshold: 0 });
      this.io.observe(el);
    }
    this._onVis = function () { if (document.hidden) self.pause(); else self.resume(); };
    document.addEventListener('visibilitychange', this._onVis);

    this._bindPointer();

    this._onLost = function (e) { e.preventDefault(); self.pause(); };
    this._onRestored = function () {
      if (self._initGL()) { self._resize(); self._spawn(true); self.resume(); }
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost);
    this.canvas.addEventListener('webglcontextrestored', this._onRestored);

    this._applyStyle();
    this._applyMotion();
  };

  /** CSS-level config that does not belong in the shader. */
  LB.prototype._applyStyle = function () {
    if (this.canvas) this.canvas.style.opacity = String(clamp(this.cfg.liquid.opacity, 0, 1));
  };

  /* --- WebGL init ------------------------------------------------- */
  LB.prototype._initGL = function () {
    var opts = {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
      powerPreference: 'low-power', failIfMajorPerformanceCaveat: false
    };
    var gl = this.canvas.getContext('webgl', opts) ||
             this.canvas.getContext('experimental-webgl', opts);
    if (!gl) return false;
    this.gl = gl;

    try {
      this.progLiquid    = program(gl, VS_FULLSCREEN, FS_LIQUID);
      this.progComposite = program(gl, VS_FULLSCREEN, FS_COMPOSITE);
      this.progBubble    = program(gl, VS_BUBBLE,     FS_BUBBLE);
    } catch (err) {
      if (window.console) console.warn(err.message);
      return false;
    }

    // fullscreen triangle
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.bubbleBuf = gl.createBuffer();
    this.fbo = gl.createFramebuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied alpha
    this.texSize = [0, 0];
    return true;
  };

  /* --- sizing ------------------------------------------------------ */
  LB.prototype._resize = function () {
    if (this.destroyed || !this.gl) return;
    var rect = this.el.getBoundingClientRect();

    // A collapsed box is almost always temporary - a hidden ancestor, a
    // panel being dragged shut, a tab that is not laid out yet. Rebuilding
    // the whole field at 1x1 and then again on the way back reshapes every
    // bubble for nothing, so keep the last good size and wait it out.
    if ((rect.width < 2 || rect.height < 2) && this.w > 1) return;

    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));

    var dprCap = this.cfg.performance.dprMax * (this.tier >= 2 ? 0.5 : this.tier === 1 ? 0.75 : 1);
    var dpr = clamp(window.devicePixelRatio || 1, 1, Math.max(1, dprCap));

    var changed = (w !== this.w || h !== this.h || dpr !== this.dpr);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);

    // The radius is read from CSS, so the shape has exactly one definition.
    var cr = this.cfg.container.radius;
    if (cr === 'auto') {
      var css = getComputedStyle(this.el).borderTopLeftRadius || '0';
      cr = css.indexOf('%') > -1 ? parseFloat(css) / 100 * Math.min(w, h) : parseFloat(css) || 0;
    }
    this.radius = clamp(cr || 0, 0, Math.min(w, h) / 2);

    // liquid FBO, rendered smaller than the screen and filtered back up
    var ls = this.cfg.performance.liquidScale * (this.tier >= 2 ? 0.7 : 1);
    var tw = Math.max(2, Math.round(this.canvas.width  * clamp(ls, 0.25, 1)));
    var th = Math.max(2, Math.round(this.canvas.height * clamp(ls, 0.25, 1)));
    if (tw !== this.texSize[0] || th !== this.texSize[1]) {
      var gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.texSize = [tw, th];
    }

    if (changed) this._seedPools();
    if (changed && this.bubbles.length) this._spawn(false);
    // Resizing a canvas clears it, so always repaint here rather than
    // waiting for the next animation frame - otherwise a throttled or
    // merely late rAF leaves a black panel on screen.
    this._draw();
  };

  /* --- how big and how many ---------------------------------------- */
  LB.prototype._metrics = function () {
    var b = this.cfg.bubbles;
    // One scale factor tied to the short side, so a 320px card and a 4K hero
    // get proportionally similar bubbles instead of identical ones.
    var s = clamp(Math.min(this.w, this.h) / 700, 0.5, 1.5);
    var minR = Math.max(1.2, b.minRadius * s);
    var maxR = Math.min(b.maxRadius * s, Math.min(this.w, this.h) * 0.12);
    maxR = Math.max(maxR, minR * 1.8);

    var n = b.count;
    if (n === 'auto') n = Math.round(b.density * (this.w * this.h) / 100000);
    n = Math.round(clamp(n, b.minCount, b.maxCount));
    if (this.tier === 1) n = Math.round(n * 0.7);
    if (this.tier >= 2) n = Math.round(n * 0.45);
    return { minR: minR, maxR: maxR, n: Math.max(4, n), scale: s };
  };

  /* --- the pigment blobs -------------------------------------------- */

  /* Positions live in a space normalised by the vessel's HEIGHT - x runs
     0..aspect, y runs 0..1 - so the space is isotropic and a blob stays round
     instead of being stretched into an oval by a wide viewport. y counts up
     from the bottom, matching the shader's uv rather than CSS pixels. */
  LB.prototype._seedPools = function () {
    var c = (this.cfg.liquid && this.cfg.liquid.pools) || {};
    var n = Math.round(clamp(c.count || 0, 0, 12));
    if (!this.pools) this.pools = [];
    if (!n || !this.w || !this.h) { this.pools.length = 0; return; }
    var asp = this.w / Math.max(this.h, 1), i, a;
    this.pools.length = Math.min(this.pools.length, n);
    for (i = 0; i < n; i++) {
      if (this.pools[i]) continue;
      a = Math.random() * Math.PI * 2;
      this.pools[i] = {
        r: c.minRadius + Math.random() * Math.max(0, c.maxRadius - c.minRadius),
        x: Math.random() * asp,
        y: Math.random(),
        // speed spread a little per blob, or they all cross together
        vx: Math.cos(a) * c.speed * (0.6 + Math.random() * 0.8),
        vy: Math.sin(a) * c.speed * (0.6 + Math.random() * 0.8)
      };
    }
  };

  /* Move them and bounce them. A wall reverses the component normal to it and
     leaves the tangential one alone, which is what sends a blob back the way
     it came; the position is mirrored back inside in the same step so a large
     dt can never leave one stranded outside the glass. */
  LB.prototype._stepPools = function (dt) {
    // _headless() assembles an instance for the tests without the WebGL half,
    // so this cannot assume the array exists.
    var n = this.pools ? this.pools.length : 0;
    if (!n) return;
    var asp = this.w / Math.max(this.h, 1), i, b, lo, hi;
    for (i = 0; i < n; i++) {
      b = this.pools[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // the blob is contained by its own edge, not its centre
      lo = b.r * 0.45; hi = asp - b.r * 0.45;
      if (b.x < lo) { b.x = lo + (lo - b.x); b.vx = Math.abs(b.vx); }
      else if (b.x > hi) { b.x = hi - (b.x - hi); b.vx = -Math.abs(b.vx); }
      lo = b.r * 0.45; hi = 1 - b.r * 0.45;
      if (b.y < lo) { b.y = lo + (lo - b.y); b.vy = Math.abs(b.vy); }
      else if (b.y > hi) { b.y = hi - (b.y - hi); b.vy = -Math.abs(b.vy); }
      // a very wide blob in a short vessel can overshoot both walls at once
      b.x = clamp(b.x, 0, asp); b.y = clamp(b.y, 0, 1);
    }
  };

  /* --- (re)populate the tank ---------------------------------------- */
  LB.prototype._spawn = function (fresh) {
    var m = this._metrics(), i;
    this.metrics = m;
    this._seedPools();

    if (this.bubbles.length > m.n) this.bubbles.length = m.n;
    while (this.bubbles.length < m.n) this.bubbles.push(new Bubble());

    for (i = 0; i < this.bubbles.length; i++) {
      if (fresh || this.bubbles[i].r === 0) this._respawn(this.bubbles[i], true);
      else this.bubbles[i].r = clamp(this.bubbles[i].r, m.minR, m.maxR);
    }

    if (fresh) {
      // Warm the simulation up so the tank starts full, instead of every
      // bubble climbing from the floor on load.
      var steps = 260, dt = 1 / 30, save = this.cfg.interaction.enabled;
      this.cfg.interaction.enabled = false;
      for (i = 0; i < steps; i++) this._step(dt);
      this.cfg.interaction.enabled = save;
    }

    // resize the vertex buffer to the new worst case
    var gl = this.gl;
    this.vertData = new Float32Array(this.bubbles.length * 6 * 7);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertData.byteLength, gl.DYNAMIC_DRAW);
  };

  /**
   * Put a bubble back at the floor with a new size.
   * Sizes are biased toward the small end (pow with sizeBias), because a
   * field of mostly-small bubbles with a few big ones reads as liquid,
   * while a uniform distribution reads as a particle system.
   */
  LB.prototype._respawn = function (b, initial) {
    var m = this.metrics || this._metrics(), c = this.cfg.bubbles;
    var minR = m.minR, maxR = m.maxR;

    b.r = minR + Math.pow(Math.random(), c.sizeBias) * (maxR - minR);
    b.seed = Math.random();
    b.depth = (b.r - minR) / Math.max(maxR - minR, 0.001);   // bigger = nearer

    // clusters: a respawn can open a "vent" that the next few bubbles use
    var x;
    if (this.spawnQueue && this.spawnQueue.left > 0) {
      x = this.spawnQueue.x + rand(-1, 1) * this.spawnQueue.spread;
      this.spawnQueue.left--;
    } else {
      x = rand(0, this.w);
      if (Math.random() < c.cluster) {
        this.spawnQueue = {
          x: x, spread: rand(14, 46) * m.scale,
          left: 1 + Math.floor(Math.random() * 3)
        };
      }
    }

    // Start inside the shape, not below it: the wall push would only snap
    // an outside bubble onto the floor anyway, and doing that to every
    // respawn lines them all up on the same row.
    var pad = b.r + c.wallMargin;
    b.x = clamp(x, pad, Math.max(pad, this.w - pad));
    b.y = initial ? rand(pad, Math.max(pad, this.h)) : pad + rand(0, this.h * 0.05);

    // Rise speed. sizeSpeed > 0 makes SMALL bubbles faster - a deliberate
    // stylisation (calmer, and it keeps the big shapes feeling heavy).
    // Set sizeSpeed negative for real Stokes behaviour.
    var ref = 10 * m.scale;
    b.targetVy = c.rise * Math.pow(ref / Math.max(b.r, 0.5), c.sizeSpeed) * rand(0.82, 1.18);

    // inertia scales with size: a big bubble takes longer to change course
    b.tau = Math.max(0.08, c.inertia * Math.pow(b.r / ref, 0.8));

    b.wobbleSpeed = 6.2832 * c.wobble * Math.pow(ref / Math.max(b.r, 0.5), 0.3) * rand(0.7, 1.35);
    b.wobbleAmp   = c.drift * Math.pow(ref / Math.max(b.r, 0.5), 0.35) * rand(0.6, 1.4);
    b.phase = Math.random() * 6.2832;
    b.vx = 0; b.vy = b.targetVy;
    b.alpha = initial ? 1 : 0;
    b.fadingOut = false;

    // The spawn point above assumes a rectangle. For a heavily rounded
    // shape it can land outside, so pull it in before anyone sees it.
    this._confine(b, false);
  };

  /**
   * Move a bubble back inside the shape if it overlaps the wall, and
   * optionally eat the inward component of its velocity so it slides
   * along the wall instead of bouncing off it.
   *
   * The SDF is a true distance function, so one step along its gradient
   * is already exact for a straight wall; the loop is there for curved
   * ones, where the normal turns as the point moves.
   *
   * Both the simulation and _respawn() go through here, which is what
   * guarantees a bubble is never placed outside its container - not even
   * for a shape whose radius makes it a full circle.
   */
  LB.prototype._confine = function (b, damp) {
    var w = this.w, h = this.h, r = this.radius;
    var need = b.r + this.cfg.bubbles.wallMargin;

    // a container too small to hold this bubble at all: centre it
    if (need >= Math.min(w, h) / 2) { b.x = w / 2; b.y = h / 2; return; }

    for (var it = 0; it < 3; it++) {
      var pen = sdRoundRect(b.x, b.y, w, h, r) + need;
      if (pen <= 0) return;
      // gradient of the SDF = outward normal, by central difference
      var e = 0.75;
      var gx = sdRoundRect(b.x + e, b.y, w, h, r) - sdRoundRect(b.x - e, b.y, w, h, r);
      var gy = sdRoundRect(b.x, b.y + e, w, h, r) - sdRoundRect(b.x, b.y - e, w, h, r);
      var gn = Math.sqrt(gx * gx + gy * gy);
      if (!gn) { b.x = w / 2; b.y = h / 2; return; }
      gx /= gn; gy /= gn;
      b.x -= gx * pen; b.y -= gy * pen;
      if (damp) {
        var vn = b.vx * gx + b.vy * gy;          // kill only the normal part
        if (vn > 0) { b.vx -= gx * vn * 1.6; b.vy -= gy * vn * 1.6; }
      }
    }
  };

  /* ============================================================
     7. SIMULATION
     Per bubble, per frame:
       buoyancy -> a constant target rise velocity derived from size
       drag     -> exponential approach to that target; the time
                   constant tau IS the viscosity / inertia model
       sway     -> two sines (slow sway + faster flutter)
       walls    -> the rounded-rect SDF pushes it back in and eats the
                   normal component of its velocity, so it slides
       ceiling  -> heavy braking + sideways release + fade, then the
                   bubble is recycled at the floor
     ============================================================ */
  LB.prototype._step = function (dt) {
    this._stepPools(dt);
    var c = this.cfg.bubbles, inter = this.cfg.interaction;
    var w = this.w, h = this.h, r = this.radius;
    var p = this.pointer;
    var ceilY = h * (1 - c.ceiling);
    var i, b;

    for (i = 0; i < this.bubbles.length; i++) {
      b = this.bubbles[i];

      /* --- lateral target: slow sway + micro flutter --- */
      b.phase += b.wobbleSpeed * dt;
      var sway = Math.sin(b.phase) + c.jitter * 0.34 * Math.sin(b.phase * 2.7 + b.seed * 6.2832);
      var targetVx = sway * b.wobbleAmp;
      var targetVy = b.targetVy;

      /* --- pointer flow field --- */
      if (inter.enabled && p.on && inter.strength > 0) {
        var dx = b.x - p.x, dy = b.y - p.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var R = inter.radius * (this.metrics ? this.metrics.scale : 1);
        if (dist < R) {
          var f = 1 - dist / R; f *= f;
          var inv = 1 / Math.max(dist, 1e-3);
          var nx = dx * inv, ny = dy * inv;
          var k = f * inter.strength;
          targetVx += (p.vx * 0.30 - ny * p.speed * inter.swirl * 0.22 + nx * p.speed * 0.10) * k;
          targetVy += (p.vy * 0.30 + nx * p.speed * inter.swirl * 0.22 + ny * p.speed * 0.10) * k;
        }
      }

      /* --- ceiling: squeeze-film braking, then release sideways --- */
      if (b.y + b.r > ceilY) {
        var t = clamp((b.y + b.r - ceilY) / Math.max(h - ceilY, 1), 0, 1);
        targetVy *= Math.max(0, 1 - t * c.ceilingDrag);
        targetVx *= 1 + t * 1.6;                 // it slides along the surface
        if (t > 0.40) b.fadingOut = true;
      }

      /* --- drag: exponential approach; tau is the inertia --- */
      var kk = 1 - Math.exp(-dt / b.tau);
      b.vx += (targetVx - b.vx) * kk;
      b.vy += (targetVy - b.vy) * kk;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      /* --- walls: the rounded rectangle is a hard boundary --- */
      this._confine(b, true);

      /* --- fade in at the bottom, out at the top, then recycle --- */
      if (b.fadingOut) {
        b.alpha -= dt / c.fade;
        if (b.alpha <= 0) this._respawn(b, false);
      } else if (b.alpha < 1) {
        b.alpha = Math.min(1, b.alpha + dt / c.fade);
      }
    }

    /* --- pointer bookkeeping: its velocity decays when it stops --- */
    if (p.on) {
      var decay = Math.exp(-dt * 2.4);
      p.vx *= decay; p.vy *= decay;
      p.speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    }

    /* --- parallax easing --- */
    var pe = 1 - Math.exp(-dt * 3.0);
    this.parallax.x += (this.parallax.tx - this.parallax.x) * pe;
    this.parallax.y += (this.parallax.ty - this.parallax.y) * pe;
  };

  /* ============================================================
     8. RENDERING
     ============================================================ */
  var CX = [-1, 1, -1, -1, 1, 1];
  var CY = [-1, -1, 1, 1, -1, 1];

  LB.prototype._uploadBubbles = function () {
    var gl = this.gl, data = this.vertData, dpr = this.dpr;
    var px = this.parallax.x, py = this.parallax.y, v = 0, i, k, b;

    for (i = 0; i < this.bubbles.length; i++) {
      b = this.bubbles[i];
      if (b.alpha <= 0.002) continue;
      // depth parallax: near (big) bubbles travel further than far ones
      var cx = (b.x + px * (0.35 + b.depth)) * dpr;
      var cy = (b.y + py * (0.35 + b.depth)) * dpr;
      var rr = b.r * dpr;
      for (k = 0; k < 6; k++) {
        data[v++] = CX[k]; data[v++] = CY[k];
        data[v++] = cx;    data[v++] = cy;
        data[v++] = rr;    data[v++] = b.seed; data[v++] = b.alpha;
      }
    }
    this.vertCount = v / 7;
    if (v === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, v));
  };

  LB.prototype._draw = function () {
    if (!this.gl || this.destroyed) return;
    var gl = this.gl, cfg = this.cfg;
    var W = this.canvas.width, H = this.canvas.height;
    if (W < 2 || H < 2) return;

    var palKey = JSON.stringify(cfg.palette);
    if (this._palKey !== palKey) {
      this._palKey = palKey;
      var pal = cfg.palette;
      this._palCache = new Float32Array([].concat(
        hex2rgb(pal.abyss), hex2rgb(pal.deep), hex2rgb(pal.violet),
        hex2rgb(pal.orchid), hex2rgb(pal.blush), hex2rgb(pal.sun), hex2rgb(pal.aqua)));
    }

    /* ---- pass 1: liquid -> texture ---- */
    var pr = this.progLiquid;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.texSize[0], this.texSize[1]);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(pr.a.aPos);
    gl.vertexAttribPointer(pr.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(pr.u.uRes, this.texSize[0], this.texSize[1]);
    gl.uniform1f(pr.u.uTime, this.time);
    gl.uniform1f(pr.u.uScale, cfg.liquid.scale);
    gl.uniform1f(pr.u.uFlow, cfg.liquid.flow);
    gl.uniform1f(pr.u.uVeil, cfg.liquid.veil);
    gl.uniform1f(pr.u.uCaustics, cfg.liquid.caustics);
    gl.uniform1f(pr.u.uDepth, cfg.liquid.depth);
    gl.uniform1f(pr.u.uWall, cfg.liquid.wall);
    /* Twelve vec3s whether or not all are in use: the unused tail stays at
       r = 0, which the shader multiplies out. Rebuilt every frame rather than
       cached, because the blobs have moved by definition. */
    var pd = this.poolData, pn = Math.min(this.pools.length, 12), pi;
    for (pi = 0; pi < 12; pi++) {
      if (pi < pn) { pd[pi * 3] = this.pools[pi].x; pd[pi * 3 + 1] = this.pools[pi].y; pd[pi * 3 + 2] = this.pools[pi].r; }
      else { pd[pi * 3] = pd[pi * 3 + 1] = pd[pi * 3 + 2] = 0; }
    }
    gl.uniform3fv(pr.u.uPools, pd);
    gl.uniform1f(pr.u.uPoolWobble, cfg.liquid.pools.wobble);
    gl.uniform1f(pr.u.uPoolMix, pn ? 1 : 0);
    gl.uniform1f(pr.u.uSeed, this.seed);
    gl.uniform2f(pr.u.uParallax, this.parallax.x * 0.0016, this.parallax.y * 0.0016);
    gl.uniform3fv(pr.u.uColors, this._palCache);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---- pass 2: composite -> screen ---- */
    pr = this.progComposite;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(pr.a.aPos);
    gl.vertexAttribPointer(pr.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(pr.u.uTex, 0);
    gl.uniform2f(pr.u.uRes, W, H);
    gl.uniform1f(pr.u.uRadius, this.radius * this.dpr);
    gl.uniform1f(pr.u.uEdge, cfg.liquid.edge);
    gl.uniform1f(pr.u.uVignette, cfg.liquid.vignette);
    gl.uniform1f(pr.u.uGrain, cfg.liquid.grain);
    gl.uniform1f(pr.u.uDither, cfg.liquid.dither);
    gl.uniform1f(pr.u.uSoften, cfg.liquid.soften * this.dpr);
    gl.uniform1f(pr.u.uTime, this.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---- pass 3: bubbles -> screen, refracting pass 1 ---- */
    // Fully transparent bubbles still cost a buffer upload and a draw call
    // whose every fragment would discard, so skip the pass outright.
    if (cfg.bubbles.opacity <= 0.001) { this.vertCount = 0; return; }
    this._uploadBubbles();
    if (!this.vertCount) return;
    pr = this.progBubble;
    gl.enable(gl.BLEND);
    gl.useProgram(pr.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bubbleBuf);
    var S = 7 * 4;   // stride in bytes
    var bind = function (name, size, offset) {
      var l = pr.a[name];
      if (l === undefined || l < 0) return;
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, S, offset);
    };
    bind('aCorner', 2, 0);
    bind('aCenter', 2, 8);
    bind('aRadius', 1, 16);
    bind('aSeed',   1, 20);
    bind('aAlpha',  1, 24);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(pr.u.uTex, 0);
    gl.uniform2f(pr.u.uRes, W, H);
    gl.uniform1f(pr.u.uPad, 1.45);
    gl.uniform1f(pr.u.uRefract, cfg.bubbles.refraction);
    gl.uniform1f(pr.u.uHighlight, cfg.bubbles.highlight);
    gl.uniform1f(pr.u.uRim, cfg.bubbles.rim);
    gl.uniform1f(pr.u.uGlow, cfg.bubbles.glow);
    gl.uniform1f(pr.u.uOpacity, cfg.bubbles.opacity);
    gl.uniform1f(pr.u.uTime, this.time);
    var aqua = hex2rgb(cfg.palette.aqua);
    gl.uniform3f(pr.u.uSpec, 1.0, 0.97, 0.96);
    gl.uniform3f(pr.u.uTint, aqua[0], aqua[1], aqua[2]);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertCount);
  };

  /* ============================================================
     9. LOOP + ADAPTIVE QUALITY
     ============================================================ */
  LB.prototype._frame = function (now) {
    if (!this.running || this.destroyed) return;
    var self = this;
    this.raf = requestAnimationFrame(function (t) { self._frame(t); });

    var dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) return;
    dt = Math.min(dt, 1 / 20);        // a long stall must not teleport bubbles

    this.time += dt;
    this._step(dt);
    this._draw();

    if (this.cfg.performance.adaptive) this._adapt(dt);
  };

  /**
   * Watch a two-second window of frame times. If we are consistently under
   * the target, drop a quality tier. We never climb back up: oscillating
   * between tiers looks worse than simply running one notch lower.
   */
  LB.prototype._adapt = function (dt) {
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc < 2) return;
    var fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0; this.fpsFrames = 0;
    if (fps >= this.cfg.performance.minFps || this.tier >= 3) return;

    this.tier++;
    if (this.tier >= 3) { this._fallback(); return; }
    this._resize();
    this._spawn(false);
  };

  LB.prototype._applyMotion = function () {
    var wants = this.cfg.motion === 'auto' ? !this.motionQuery.matches : !!this.cfg.motion;
    this.el.classList.toggle('lb--still', !wants);
    if (wants) this.resume();
    else { this.pause(); this._draw(); }   // one static, fully-composed frame
  };

  LB.prototype.resume = function () {
    if (this.running || this.destroyed || !this.gl || !this.visible || document.hidden) return;
    var wants = this.cfg.motion === 'auto' ? !this.motionQuery.matches : !!this.cfg.motion;
    if (!wants) return;
    this.running = true;
    this.last = performance.now();
    var self = this;
    this.raf = requestAnimationFrame(function (t) { self._frame(t); });
  };

  LB.prototype.pause = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  /* ============================================================
     10. POINTER
     Listened on window, not on the element, so content layered on top
     of the effect never blocks the interaction.
     ============================================================ */
  LB.prototype._bindPointer = function () {
    var self = this;
    this._onMove = function (e) {
      if (!self.cfg.interaction.enabled || self.destroyed) return;
      var rect = self.el.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = rect.height - (e.clientY - rect.top);   // flip to y-up
      var inside = x >= -60 && y >= -60 && x <= rect.width + 60 && y <= rect.height + 60;
      var p = self.pointer;
      if (p.has && inside) {
        // px/s, smoothed - raw deltas are far too jumpy to drive a flow field
        p.vx += ((x - p.x) * 12 - p.vx) * 0.25;
        p.vy += ((y - p.y) * 12 - p.vy) * 0.25;
        p.speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      }
      p.x = x; p.y = y; p.on = inside; p.has = true;

      var par = self.cfg.interaction.parallax;
      self.parallax.tx = clamp(x / Math.max(rect.width, 1)  - 0.5, -0.5, 0.5) * -2 * par;
      self.parallax.ty = clamp(y / Math.max(rect.height, 1) - 0.5, -0.5, 0.5) * -2 * par;
    };
    this._onLeave = function () {
      self.pointer.on = false; self.pointer.has = false;
      self.parallax.tx = 0; self.parallax.ty = 0;
    };
    addEventListener('pointermove', this._onMove, { passive: true });
    document.addEventListener('pointerleave', this._onLeave);
    addEventListener('blur', this._onLeave);
  };

  /* ============================================================
     11. FALLBACK
     No WebGL, a shader that would not compile, or a device that could
     not keep up: hand the panel over to CSS. The gradients in
     liquid-bubbles.css are built from the same palette, so the page
     still looks intentional rather than broken.
     ============================================================ */
  LB.prototype._fallback = function () {
    this.pause();
    this.el.classList.add('lb--fallback');
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    if (!this.el.querySelector('.lb__fb')) {
      var fb = document.createElement('div');
      fb.className = 'lb__fb';
      fb.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < 7; i++) fb.appendChild(document.createElement('i'));
      this.el.insertBefore(fb, this.el.firstChild);
    }
  };

  /* ============================================================
     12. PUBLIC API
     ============================================================ */
  /** Change any config at runtime: fx.update({ bubbles: { rise: 40 } }) */
  LB.prototype.update = function (options) {
    var needsRespawn = !!(options && (options.bubbles || options.container));
    /* Sizes are handed out at seed time, so changing them has to throw the
       current blobs away - re-seeding alone would only ever top the set up. */
    var repool = !!(options && options.liquid && options.liquid.pools);
    this.cfg = merge(this.cfg, options || {});
    if (this.destroyed || !this.gl) return this;
    if (repool) { this.pools.length = 0; this._seedPools(); }
    this._applyStyle();
    if (needsRespawn) { this._resize(); this._spawn(false); }
    if (options && 'motion' in options) this._applyMotion();
    if (!this.running) this._draw();
    return this;
  };

  /** Re-roll the liquid pattern and the bubble field. */
  LB.prototype.reseed = function () {
    this.seed = Math.random() * 100;
    if (this.gl) { this._spawn(true); if (!this.running) this._draw(); }
    return this;
  };

  LB.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pause();
    if (this.ro) this.ro.disconnect();
    if (this.io) this.io.disconnect();
    if (this._onWinResize) removeEventListener('resize', this._onWinResize);
    document.removeEventListener('visibilitychange', this._onVis);
    removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerleave', this._onLeave);
    removeEventListener('blur', this._onLeave);
    if (this.motionQuery.removeEventListener) this.motionQuery.removeEventListener('change', this._onMotion);
    else this.motionQuery.removeListener(this._onMotion);
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
      var ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    }
    if (this.glass && this.glass.parentNode) this.glass.parentNode.removeChild(this.glass);
    var fb = this.el.querySelector('.lb__fb');
    if (fb) fb.parentNode.removeChild(fb);
    this.el.classList.remove('lb--fallback', 'lb--still');
    this.gl = null; this.bubbles = [];
  };

  /* --- module surface ----------------------------------------------- */
  return {
    defaults: DEFAULTS,
    create: function (target, options) { return new LB(target, options); },

    /** Boot every [data-liquid-bubbles] element; the attribute may hold JSON. */
    autoInit: function (scope) {
      var nodes = (scope || document).querySelectorAll('[data-liquid-bubbles]');
      var made = [], i, raw, opts;
      for (i = 0; i < nodes.length; i++) {
        raw = nodes[i].getAttribute('data-liquid-bubbles'); opts = {};
        if (raw && raw.trim()) {
          try { opts = JSON.parse(raw); }
          catch (e) { if (window.console) console.warn('[LiquidBubbles] bad JSON on', nodes[i]); }
        }
        made.push(new LB(nodes[i], opts));
      }
      return made;
    },

    /* --- test harness -------------------------------------------------
       The simulation touches no DOM and no WebGL, so it can be driven
       headlessly. This builds a populated tank of the given size and
       returns it; call ._step(dt) on it and inspect .bubbles.
       See liquid-bubbles.test.mjs.                                    */
    _headless: function (w, h, radius, options) {
      var s = Object.create(LB.prototype);
      s.cfg = merge(DEFAULTS, options || {});
      s.cfg.interaction.enabled = false;
      s.bubbles = []; s.spawnQueue = null;
      s.w = w; s.h = h; s.radius = Math.min(radius || 0, Math.min(w, h) / 2);
      s.dpr = 1; s.time = 0;
      s.pointer = { x: 0, y: 0, vx: 0, vy: 0, speed: 0, on: false, has: false };
      s.parallax = { x: 0, y: 0, tx: 0, ty: 0 };
      s.metrics = s._metrics();
      for (var i = 0; i < s.metrics.n; i++) {
        var b = new Bubble();
        s._respawn(b, true);
        s.bubbles.push(b);
      }
      return s;
    },

    /* exported so the geometry can be verified without a browser */
    _sdRoundRect: sdRoundRect
  };
}));
