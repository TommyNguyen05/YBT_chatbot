/* =============================================================================
   Balloon — motion state system (prototype)

   One balloon, continuously transforming between AI states.

   The avatar is ONE physical balloon: a spine of N points plus a thickness
   profile. Every state is only a different *target shape* for that spine, so
   the character never swaps artwork — it leans, stretches, curls, twists into
   loops and re-inflates, always as the same piece of rubber.

   Frame pipeline
     1. MOTIONS[state].pose()   target spine for every active state layer
     2. Mixer                   blends layers after setState(): linear, or
                                polar (= winding / unwinding around the head),
                                staggered along the balloon so it twists
                                progressively instead of morphing all at once
     3. Rig                     reactive secondary motion: squash & stretch,
                                wobble, hop, air pressure
     4. Body                    damped spring per spine point (inertia,
                                overshoot, follow-through) + conserved air:
                                a stretched balloon gets thinner, a retracted
                                one re-inflates
     5. Renderer                round-capped SVG strokes, knot, eyes, accents

   Public API (window.balloon)
     balloon.setState('idle' | 'listening' | 'thinking' | 'working' | 'complete')
     balloon.play([{ state, hold }, …])    timed sequence on the animation clock
     balloon.on('statechange', fn)
   ============================================================================= */

(() => {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Tunables
  // ───────────────────────────────────────────────────────────────────────────

  const N = 86; // spine points, head (0) → knot (N - 1)
  const HEAD_N = 14; // points bunched together into the head bulb
  const TUBE_N = N - HEAD_N; // points forming the neck / stretchable tube
  const SEGS = N - 1;
  const TAU = Math.PI * 2;

  // The round balloon (proportions measured from the character reference):
  // a soft egg, a short pinch and a flared knot right underneath — no taper.
  const R_IDLE = 100; // half-width of the round balloon (SVG units)
  const IDLE_CY = -18; // body centre of the round balloon
  const ASPECT_TOP = 1.02; // top half: nearly a circle…
  const ASPECT_BOTTOM = 1.08; // …bottom half a touch longer (egg)
  const NECK_R = 15.6; // half-width of the pinch between body and knot
  const NECK_OUT = 4; // how far the pinch reaches below the body
  const HEAD_FACE = 6; // the head point that sits at the body centre (eyes anchor here)
  const NECK_ANGLE = Math.PI / 2 + 0.35; // where the tube leaves the head once coiled
  const PETAL_W = Math.PI / 4; // half-angle of a flower loop: 4 × 90° = one full turn
  const PETAL_LEN = 118; // how far a flower loop reaches from the head

  // Flat, single-colour character: one balloon colour and white eyes.
  const COLOR = {
    base: '#FEBE2C',
    eye: '#FFFFFF',
  };

  // Material coordinate: 0 at the head, 1 at the knot. It is "painted on the
  // rubber" — it never changes — and drives stagger order, stiffness, profiles.
  const S = new Float32Array(N);
  for (let i = 0; i < N; i++) S[i] = i < HEAD_N ? 0 : (i - HEAD_N + 1) / TUBE_N;

  // Per-point springs: the head leads (stiff), the tail follows (soft). This one
  // gradient produces inertia, drag and follow-through in every state.
  const ZETA = 0.58;
  const K = new Float32Array(N);
  const C = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    K[i] = 330 - 185 * Math.pow(S[i], 0.9);
    C[i] = 2 * ZETA * Math.sqrt(K[i]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Math helpers
  // ───────────────────────────────────────────────────────────────────────────

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const f1 = (v) => Math.round(v * 10) / 10;

  const EASE = {
    linear: (t) => t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    // overshoot at the end, settling like a spring
    outBack: (t) => {
      const s = 1.6;
      const u = t - 1;
      return 1 + (s + 1) * u * u * u + s * u * u;
    },
    // anticipation at the start + overshoot at the end
    inOutBack: (t) => {
      const s = 0.9 * 1.525;
      return t < 0.5
        ? (Math.pow(2 * t, 2) * ((s + 1) * 2 * t - s)) / 2
        : (Math.pow(2 * t - 2, 2) * ((s + 1) * (t * 2 - 2) + s) + 2) / 2;
    },
  };

  /** Damped 1-D spring (zeta < 1 overshoots). */
  class Spring {
    constructor(value, stiffness, zeta) {
      this.x = value;
      this.v = 0;
      this.a = 0;
      this.target = value;
      this.k = stiffness;
      this.c = 2 * zeta * Math.sqrt(stiffness);
    }
    step(h) {
      this.a = this.k * (this.target - this.x) - this.c * this.v;
      this.v += this.a * h;
      this.x += this.v * h;
    }
    kick(dv) {
      this.v += dv;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Pose model — the target shape of the balloon
  // ───────────────────────────────────────────────────────────────────────────

  const FACE_KEYS = ['ox', 'oy', 'tilt', 'lookX', 'lookY', 'track', 'happy', 'focus', 'wide', 'attention'];

  function makePose() {
    const face = {};
    for (const k of FACE_KEYS) face[k] = 0;
    return {
      x: new Float32Array(N),
      y: new Float32Array(N),
      p: new Float32Array(N), // thickness profile (× base radius)
      cx: 0, // head centre: pivot for polar blending and for the rig
      cy: 0,
      air: 1, // air volume (1 = round balloon)
      coiled: 0, // 0: one round body · 1: head bulb + long tube (moves the rig pivot)
      stiff: 1, // spring stiffness multiplier
      face,
    };
  }

  function copyPose(dst, src) {
    dst.x.set(src.x);
    dst.y.set(src.y);
    dst.p.set(src.p);
    dst.cx = src.cx;
    dst.cy = src.cy;
    dst.air = src.air;
    dst.coiled = src.coiled;
    dst.stiff = src.stiff;
    for (const k of FACE_KEYS) dst.face[k] = src.face[k];
  }

  function clearFace(f) {
    for (const k of FACE_KEYS) f[k] = 0;
  }

  /** Head bulb: HEAD_N points, top of the head first, with point HEAD_FACE
   *  exactly at the centre. The bottom half runs along (ax, ay), the top half
   *  along (tx, ty) — different axes bend the body like a leaning balloon.
   *  Circle radii follow an ellipse's inscribed circles, so the union is a
   *  smooth egg: width 2b, reaching b·aspTop above the centre and b·aspBot
   *  below it (never a flat-sided pill). Returns how far down the points reach. */
  function layHead(P, cx, cy, ax, ay, profile, b, aspTop, aspBot, tx = -ax, ty = -ay) {
    const eT = aspTop * aspTop - 1;
    const eB = aspBot * aspBot - 1;
    const hT = eT > 0 ? (b * eT) / aspTop : 0;
    const hB = eB > 0 ? (b * eB) / aspBot : 0;
    for (let i = 0; i < HEAD_N; i++) {
      const d = i <= HEAD_FACE ? -hT * (1 - i / HEAD_FACE) : (hB * (i - HEAD_FACE)) / (HEAD_N - 1 - HEAD_FACE);
      const e = d < 0 ? eT : eB;
      if (d < 0) {
        // the top axis bends smoothly away from the bottom one (no kink at the centre)
        const k = hT > 0 ? -d / hT : 0;
        let ux = -ax + (tx + ax) * k;
        let uy = -ay + (ty + ay) * k;
        const ul = Math.hypot(ux, uy) || 1;
        ux /= ul;
        uy /= ul;
        P.x[i] = cx - ux * d;
        P.y[i] = cy - uy * d;
      } else {
        P.x[i] = cx + ax * d;
        P.y[i] = cy + ay * d;
      }
      P.p[i] = e > 0 ? profile * Math.sqrt(Math.max(0, 1 - (d * d) / (b * b * e))) : profile;
    }
    return hB;
  }

  /** Round balloon neck: hidden inside the body, then a short pinch just below
   *  it where the knot attaches. `tip` is the bottom of the body. */
  function neckProfile(d, tip) {
    const inside = 0.92 * Math.max(0, tip - d);
    const pinch = NECK_R + 5 * (1 - smoothstep(tip - 12, tip, d));
    return lerp(inside, pinch, smoothstep(tip - 28, tip - 10, d)) / R_IDLE;
  }

  /** The round balloon: an egg-shaped body + the pinch to the knot, hanging at `neckTilt`. */
  function roundBalloon(P, cx, cy, neckTilt, ax, ay, aspTop, aspBot, tx, ty) {
    const d0 = layHead(P, cx, cy, ax, ay, 1, R_IDLE, aspTop, aspBot, tx, ty);
    const tip = R_IDLE * aspBot;
    const d1 = tip + NECK_OUT;
    const a = Math.PI / 2 + neckTilt;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    for (let j = 0; j < TUBE_N; j++) {
      const d = d0 + (d1 - d0) * ((j + 1) / TUBE_N);
      const i = HEAD_N + j;
      P.x[i] = cx + ux * d;
      P.y[i] = cy + uy * d;
      P.p[i] = neckProfile(d, tip);
    }
    P.cx = cx;
    P.cy = cy;
  }

  // Arc-length resampling, so the rubber is spread evenly along any curve.
  const RS = 200;
  const rsX = new Float32Array(RS + 1);
  const rsY = new Float32Array(RS + 1);
  const rsL = new Float32Array(RS + 1);
  const pt = [0, 0];

  /** Lays the tube points evenly (by arc length) along curve(u, out), u ∈ [0, 1]. */
  function layTube(P, curve) {
    let L = 0;
    for (let j = 0; j <= RS; j++) {
      curve(j / RS, pt);
      rsX[j] = pt[0];
      rsY[j] = pt[1];
      if (j > 0) L += Math.hypot(rsX[j] - rsX[j - 1], rsY[j] - rsY[j - 1]);
      rsL[j] = L;
    }
    let seg = 0;
    for (let i = 0; i < TUBE_N; i++) {
      const want = (L * i) / (TUBE_N - 1);
      while (seg < RS - 1 && rsL[seg + 1] < want) seg++;
      const span = rsL[seg + 1] - rsL[seg];
      const f = span > 1e-6 ? clamp((want - rsL[seg]) / span, 0, 1) : 0;
      P.x[HEAD_N + i] = rsX[seg] + (rsX[seg + 1] - rsX[seg]) * f;
      P.y[HEAD_N + i] = rsY[seg] + (rsY[seg + 1] - rsY[seg]) * f;
    }
    return L;
  }

  function scaleAbout(P, cx, cy, sx, sy) {
    for (let i = 0; i < N; i++) {
      P.x[i] = cx + (P.x[i] - cx) * sx;
      P.y[i] = cy + (P.y[i] - cy) * sy;
    }
  }

  // Air volume of the round balloon, in the units Body.computeRadius() uses.
  const AREA0 = (() => {
    const P = makePose();
    roundBalloon(P, 0, 0, 0, 0, 1, ASPECT_TOP, ASPECT_BOTTOM);
    let W = 0;
    for (let k = 0; k < SEGS; k++) {
      W += 0.5 * (P.p[k] + P.p[k + 1]) * Math.hypot(P.x[k + 1] - P.x[k], P.y[k + 1] - P.y[k]);
    }
    return Math.PI * R_IDLE * R_IDLE + 2 * R_IDLE * W;
  })();

  // ───────────────────────────────────────────────────────────────────────────
  // 4. State motions — one self-contained animation function per state
  //
  //    pose(P, t, env, layer)  writes the target spine for local time t
  //                            (seconds since the state began)
  //    enter(layer, avatar)    optional one-off behaviour when entering
  //    spin                    rotation speed (rad/s, number or fn of t),
  //                            shared by the coiled states for continuity
  // ───────────────────────────────────────────────────────────────────────────

  const MOTIONS = {
    idle: {
      label: 'Idle',
      caption: 'Calm, ready for input.',
      pose(P, t, env) {
        const m = env.motion;
        // Float inside a small radius (two sines per axis, so it never loops visibly).
        const fx = m * (7 * Math.sin(0.55 * t + 0.3) + 3 * Math.sin(1.31 * t + 1.7));
        const fy = m * (8 * Math.sin(0.83 * t) + 2.5 * Math.sin(1.9 * t + 0.4));
        const vx = m * (3.85 * Math.cos(0.55 * t + 0.3) + 3.93 * Math.cos(1.31 * t + 1.7));
        const vy = m * (6.64 * Math.cos(0.83 * t) + 4.75 * Math.cos(1.9 * t + 0.4));
        // The knot trails the drift like a pendulum.
        const sway = 0.012 * vx + 0.03 * m * Math.sin(0.47 * t + 2);
        const cx = fx;
        const cy = IDLE_CY + fy;
        roundBalloon(P, cx, cy, sway, 0, 1, ASPECT_TOP, ASPECT_BOTTOM);
        // Soft squash & stretch with vertical speed.
        const st = 1 + 0.0025 * Math.abs(vy);
        scaleAbout(P, cx, cy + 4, 1 / st, st);
        P.air = 1 + 0.012 * m * Math.sin(1.25 * t); // breathing
        P.coiled = 0;
        P.stiff = 1;
        const f = P.face;
        clearFace(f);
        f.oy = 5.5;
        f.tilt = -sway * 0.6;
        f.lookX = 0.3 + clamp(vx / 10, -1, 1) * 0.45; // a slight glance right + lead the drift
        f.lookY = clamp(vy / 10, -1, 1) * 0.3;
        f.attention = 0.55; // glance at the pointer
      },
    },

    listening: {
      label: 'Listening',
      caption: 'Input detected.',
      enter(layer, av, opts) {
        layer.data.side = opts.side === -1 ? -1 : 1;
        av.fx.perkSide = layer.data.side;
      },
      pose(P, t, env, layer) {
        const m = env.motion;
        const side = layer.data.side || 1;
        // Perk up toward the speaker: the body stretches a little taller and its
        // top tips toward the side while the knot stays put underneath…
        const nod = 0.028 * m * Math.sin(4.6 * t) + 0.012 * m * Math.sin(1.7 * t);
        const tip = side * (0.2 + nod);
        const lower = tip * 0.4;
        const cx = side * 5;
        const cy = IDLE_CY - 6 + 2 * m * Math.sin(1.1 * t);
        roundBalloon(P, cx, cy, lower, -Math.sin(lower), Math.cos(lower), 1.19, 1.13, Math.sin(tip), -Math.cos(tip));
        P.air = 1.15; // perked up: a touch more pressure keeps it as wide as idle
        P.coiled = 0;
        P.stiff = 1;
        // …while the head tilts the other way, eyes up toward the sound: the
        // curious head tilt.
        const f = P.face;
        clearFace(f);
        f.ox = 16 * side;
        f.oy = -2;
        f.tilt = -side * 0.22 - nod * 0.8;
        f.lookX = 0.8 * side;
        f.lookY = -0.3;
        f.wide = 1;
        f.attention = 0.25;
      },
    },

    thinking: {
      label: 'Thinking',
      caption: 'Processing and reasoning.',
      spins: true,
      // Form the coil first, then start spinning (like a loader spinning up).
      spin: (t) => 2.4 * smoothstep(0.55, 1.3, t),
      enter(layer, av) {
        av.blink();
      },
      pose(P, t, env) {
        const m = env.motion;
        const psi = env.spin;
        const cx = 0;
        const cy = -6 + 4 * m * Math.sin(2.2 * t);
        layHead(P, cx, cy, 0, 1, 2.15, 45, 1.04, 1.04);
        // The tail chases the head around a coil — the balloon is the loader.
        // The coil stretches longer / shorter (elastic), its tip curls in and a
        // ripple runs along the body.
        const chase = Math.sin(3.9 * t);
        const span = 5.25 + 0.5 * chase * m;
        const ring = 97 + 4 * m * Math.sin(2.2 * t + 1);
        const curl = 0.5 + 0.5 * Math.sin(3.9 * t - 1.2);
        const th0 = psi + NECK_ANGLE;
        layTube(P, (u, out) => {
          let rho = ring * (1 - Math.exp(-u / 0.075)) * (1 + 0.13 * u);
          rho += 5 * m * Math.sin(13 * u - 6.5 * t) * smoothstep(0.12, 0.35, u);
          const tip = smoothstep(0.8, 1, u);
          rho -= 28 * curl * tip;
          const th = th0 + span * u + 0.3 * curl * tip;
          out[0] = cx + rho * Math.cos(th);
          out[1] = cy + rho * Math.sin(th);
        });
        for (let i = HEAD_N; i < N; i++) P.p[i] = 1 - 0.4 * smoothstep(0.84, 1, S[i]);
        P.cx = cx;
        P.cy = cy;
        P.air = 0.74;
        P.coiled = 1;
        P.stiff = 1.3;
        const f = P.face;
        clearFace(f);
        f.oy = 0;
        f.track = 0.85; // watching its own tail go round
        f.focus = 0.2;
      },
    },

    working: {
      label: 'Working',
      caption: 'Actively working on your request.',
      spins: true,
      // A ratcheting turn: steady rotation plus a surge on every beat.
      spin: (t) => 1.0 + 1.4 * Math.pow(Math.max(0, Math.sin(5.2 * t)), 3),
      pose(P, t, env) {
        const m = env.motion;
        const psi = env.spin;
        const cx = 0;
        const cy = -4 + 2 * m * Math.sin(5.2 * t);
        layHead(P, cx, cy, 0, 1, 3.1, 40, 1.04, 1.04);
        // Four loops around the head. Each loop breathes; the pulse travels
        // around the flower, and the loops sweep back like a spinning pinwheel.
        const base = psi + NECK_ANGLE + PETAL_W;
        const beatT = 3.6 * t;
        layTube(P, (u, out) => {
          const uu = u * 4;
          const k = Math.min(3, Math.floor(uu));
          const v = uu - k;
          const beat = m * Math.sin(beatT - k * (Math.PI / 2));
          const A = PETAL_LEN * (1 + 0.085 * beat);
          const W = PETAL_W * (1 + 0.06 * beat);
          const rho = A * Math.pow(Math.sin(Math.PI * v), 0.62);
          const a = base + k * (Math.PI / 2) + W * (2 * v - 1) - 0.3 * (rho / PETAL_LEN);
          out[0] = cx + rho * Math.cos(a);
          out[1] = cy + rho * Math.sin(a);
        });
        for (let i = HEAD_N; i < N; i++) P.p[i] = 1;
        P.cx = cx;
        P.cy = cy;
        P.air = 0.8;
        P.coiled = 1;
        P.stiff = 1.5;
        const f = P.face;
        clearFace(f);
        f.oy = 0;
        f.track = 0.3;
        f.focus = 0.4; // determined
      },
    },

    complete: {
      label: 'Complete',
      caption: 'Finished and ready.',
      enter(layer, av) {
        // Celebrate once the balloon has re-inflated, then settle back to idle.
        const tc = layer.spec.mode === 'polar' ? layer.spec.dur * 0.88 : 0.18;
        layer.data.tc = tc;
        av.at(layer, tc, () => av.celebrate());
        av.at(layer, tc + 1.55, () => av._go('idle', { source: 'auto' }));
      },
      pose(P, t, env, layer) {
        const tc = layer.data.tc || 0;
        roundBalloon(P, 0, IDLE_CY, 0, 0, 1, ASPECT_TOP, ASPECT_BOTTOM);
        P.air = 1;
        P.coiled = 0;
        P.stiff = 1;
        const f = P.face;
        clearFace(f);
        const happy = smoothstep(tc - 0.25, tc + 0.05, t) * (1 - smoothstep(tc + 1.2, tc + 1.5, t));
        f.oy = 5.5;
        f.happy = happy;
        f.lookY = -0.3 * happy;
        f.attention = 0.3;
      },
    },
  };

  // Used when many state changes overlap: holds a snapshot of what was on screen.
  const FROZEN = {
    pose(P, t, env, layer) {
      copyPose(P, layer.data.snap);
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Transitions
  //
  //    mode     'linear'  every point slides to its new place
  //             'polar'   points travel around the head (angle + radius), so
  //                       the balloon visibly winds up / unwinds
  //    stagger  fraction of the duration spread along the balloon
  //    order    'head'  the change starts at the head and runs to the knot
  //             'tail'  it starts at the knot (untwisting from the free end)
  //    kick     optional rig impulse at the start (anticipation, twist, perk)
  // ───────────────────────────────────────────────────────────────────────────

  const INSTANT = { mode: 'linear', dur: 0, stagger: 0, order: 'head', ease: 'linear' };

  const TRANSITIONS = {
    'idle>listening': { mode: 'linear', dur: 0.55, stagger: 0.2, order: 'head', ease: 'outBack', kick: 'perk' },
    'listening>idle': { mode: 'linear', dur: 0.8, stagger: 0.15, order: 'head', ease: 'inOutCubic' },
    'complete>idle': { mode: 'linear', dur: 0.9, stagger: 0.1, order: 'head', ease: 'inOutCubic' },
    'thinking>working': { mode: 'polar', dur: 1.3, stagger: 0.55, order: 'head', ease: 'inOutCubic', kick: 'twist' },
    // untwist (the loops unwind first) → retract → inflate back into the round balloon
    'working>complete': { mode: 'polar', dur: 1.15, stagger: 0.4, order: 'tail', lead: -0.35, ease: 'inOutCubic', kick: 'release' },
    'thinking>*': { mode: 'polar', dur: 1.0, stagger: 0.42, order: 'tail', ease: 'inOutCubic', kick: 'release' },
    'working>*': { mode: 'polar', dur: 1.15, stagger: 0.45, order: 'tail', ease: 'inOutCubic', kick: 'release' },
    // stretch (the bottom pulls into a peanut) → bend → curl into the coil
    '*>thinking': { mode: 'polar', dur: 1.05, stagger: 0.35, order: 'tail', lead: 0.35, headAt: 0.25, ease: 'inOutCubic', kick: 'anticipate' },
    // stretch → twist the whole length into loops → unfurl into the flower
    '*>working': { mode: 'polar', dur: 1.35, stagger: 0.4, order: 'tail', lead: 0.35, headAt: 0.25, ease: 'inOutCubic', kick: 'anticipate' },
    '*>listening': { mode: 'linear', dur: 0.6, stagger: 0.2, order: 'head', ease: 'outBack', kick: 'perk' },
    '*>*': { mode: 'linear', dur: 0.75, stagger: 0.12, order: 'head', ease: 'inOutCubic' },
  };

  function resolveTransition(from, to) {
    return (
      TRANSITIONS[from + '>' + to] ||
      TRANSITIONS[from + '>*'] ||
      TRANSITIONS['*>' + to] ||
      TRANSITIONS['*>*']
    );
  }

  const KICKS = {
    perk(av) {
      av.rig.hop.kick(-70); // a little "oh!"
      av.rig.squash.kick(0.8);
      av.fx.perk.kick(3.2); // dashes pop out
    },
    anticipate(av) {
      av.rig.squash.kick(-1.5); // crouch before the stretch
      av.rig.hop.kick(40);
    },
    twist(av) {
      av.env.spinVel += 2.4; // wind-up spin as the loops are twisted in
      av.rig.squash.kick(-0.7);
    },
    release(av) {
      av.rig.squash.kick(0.6);
    },
  };

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Mixer — blends state layers into one target pose
  // ───────────────────────────────────────────────────────────────────────────

  /** Polar coordinates of the tube points around the pose centre, with the
   *  angle unwrapped along the balloon (so winding is continuous). */
  function polarize(P, th, rh) {
    const cx = P.cx;
    const cy = P.cy;
    let prev = NaN;
    let first = -1;
    for (let i = HEAD_N; i < N; i++) {
      const dx = P.x[i] - cx;
      const dy = P.y[i] - cy;
      const r = Math.hypot(dx, dy);
      rh[i] = r;
      if (r > 6) {
        let a = Math.atan2(dy, dx);
        if (prev === prev) a += TAU * Math.round((prev - a) / TAU);
        th[i] = a;
        prev = a;
        if (first < 0) first = i;
      } else {
        th[i] = NaN;
      }
    }
    if (first < 0) {
      th.fill(Math.PI / 2);
      return;
    }
    for (let i = HEAD_N; i < first; i++) th[i] = th[first];
    for (let i = first + 1; i < N; i++) if (th[i] !== th[i]) th[i] = th[i - 1];
  }

  class Mixer {
    constructor() {
      this.layers = [];
      this.last = makePose();
      this.thA = new Float32Array(N);
      this.rhA = new Float32Array(N);
      this.thB = new Float32Array(N);
      this.rhB = new Float32Array(N);
    }

    get top() {
      return this.layers[this.layers.length - 1];
    }

    push(state, now, spec, data) {
      if (this.layers.length >= 3) {
        // Several changes are already in flight: freeze what is on screen and
        // blend from that, so rapid clicking never pops.
        const snap = makePose();
        copyPose(snap, this.last);
        this.layers = [
          { state: this.top.state, motion: FROZEN, t0: now, spec: INSTANT, data: { snap }, pose: makePose(), w: new Float32Array(N).fill(1), c: new Float32Array(N).fill(1), done: true },
        ];
      }
      const layer = { state, motion: MOTIONS[state], t0: now, spec, data: data || {}, pose: makePose(), w: new Float32Array(N), c: new Float32Array(N), done: false };
      this.layers.push(layer);
      return layer;
    }

    evaluate(now, env, out) {
      const L = this.layers;
      for (const layer of L) layer.motion.pose(layer.pose, now - layer.t0, env, layer);
      copyPose(out, L[0].pose);
      for (let j = 1; j < L.length; j++) {
        const layer = L[j];
        layer.done = this.weights(layer, now);
        this.blend(out, out, layer.pose, layer);
      }
      // Once a layer has fully taken over, everything beneath it is invisible.
      for (let j = L.length - 1; j > 0; j--) {
        if (L[j].done) {
          L.splice(0, j);
          break;
        }
      }
      copyPose(this.last, out);
      return out;
    }

    /** Per-point progress, staggered along the balloon, and its eased weight. */
    weights(layer, now) {
      const sp = layer.spec;
      const w = layer.w;
      const c = layer.c;
      if (sp.dur <= 0) {
        w.fill(1);
        c.fill(1);
        return true;
      }
      const ease = EASE[sp.ease] || EASE.inOutCubic;
      const el = now - layer.t0;
      const lead = sp.stagger * sp.dur;
      const span = sp.dur - lead;
      let done = true;
      for (let i = 0; i < N; i++) {
        let o = sp.order === 'tail' ? 1 - S[i] : S[i];
        // `headAt` lets the head take its new shape early, whatever the order,
        // so it keeps its share of the air and the face stays readable.
        if (i < HEAD_N && sp.headAt != null) o = sp.headAt;
        c[i] = clamp((el - lead * o) / span, 0, 1);
        if (c[i] < 1) done = false;
        w[i] = ease(c[i]);
      }
      return done;
    }

    /** out = A → B for a layer (its weights, progress and transition spec).
     *  `out` may alias A. */
    blend(out, A, B, layer) {
      const w = layer.w;
      const mode = layer.spec.mode;
      const acx = A.cx;
      const acy = A.cy;
      // The head bulb is compact; it always slides linearly.
      for (let i = 0; i < HEAD_N; i++) {
        out.x[i] = A.x[i] + (B.x[i] - A.x[i]) * w[i];
        out.y[i] = A.y[i] + (B.y[i] - A.y[i]) * w[i];
      }
      if (mode === 'polar') {
        const { thA, rhA, thB, rhB } = this;
        polarize(A, thA, rhA);
        polarize(B, thB, rhB);
        // Whole-turn offset so the neck takes the short way round; the rest of
        // the tube then winds (or unwinds) relative to it.
        let num = 0;
        let den = 0;
        for (let i = HEAD_N; i < HEAD_N + 24; i++) {
          const wt = Math.min(rhA[i], rhB[i]) + 1e-3;
          num += (thB[i] - thA[i]) * wt;
          den += wt;
        }
        const off = -TAU * Math.round(num / den / TAU);
        // `lead` splits each point's move in two beats: > 0 the radius leads
        // (stretch out, then curl round) · < 0 the angle leads (unwind, then
        // retract). It is what makes a change read as a physical twist.
        const lead = layer.spec.lead || 0;
        const ease = EASE[layer.spec.ease] || EASE.inOutCubic;
        const l = Math.abs(lead);
        const c = layer.c;
        for (let i = HEAD_N; i < N; i++) {
          const t = w[i];
          let wr = t;
          let wt = t;
          if (l > 0) {
            const early = ease(clamp(c[i] / (1 - l), 0, 1));
            const late = ease(clamp((c[i] - l) / (1 - l), 0, 1));
            wr = lead > 0 ? early : late;
            wt = lead > 0 ? late : early;
          }
          const cx = acx + (B.cx - acx) * t;
          const cy = acy + (B.cy - acy) * t;
          const th = thA[i] + (thB[i] + off - thA[i]) * wt;
          const rh = Math.max(0, rhA[i] + (rhB[i] - rhA[i]) * wr);
          out.x[i] = cx + rh * Math.cos(th);
          out.y[i] = cy + rh * Math.sin(th);
        }
      } else {
        for (let i = HEAD_N; i < N; i++) {
          out.x[i] = A.x[i] + (B.x[i] - A.x[i]) * w[i];
          out.y[i] = A.y[i] + (B.y[i] - A.y[i]) * w[i];
        }
      }
      let wSum = 0;
      for (let i = 0; i < N; i++) {
        out.p[i] = Math.max(0.05, A.p[i] + (B.p[i] - A.p[i]) * w[i]);
        wSum += w[i];
      }
      const wm = wSum / N;
      const wh = w[0];
      const wn = w[HEAD_N];
      out.cx = acx + (B.cx - acx) * wh;
      out.cy = acy + (B.cy - acy) * wh;
      out.air = lerp(A.air, B.air, wm);
      out.stiff = lerp(A.stiff, B.stiff, wm);
      out.coiled = clamp(lerp(A.coiled, B.coiled, wn), 0, 1);
      const wf = clamp(wh, 0, 1);
      for (const k of FACE_KEYS) out.face[k] = lerp(A.face[k], B.face[k], wf);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Body — spring physics + conserved air
  // ───────────────────────────────────────────────────────────────────────────

  class Body {
    constructor() {
      this.x = new Float32Array(N);
      this.y = new Float32Array(N);
      this.vx = new Float32Array(N);
      this.vy = new Float32Array(N);
      this.r = new Float32Array(N);
      this.rb = R_IDLE;
      this.rHead = R_IDLE;
    }

    reset(P) {
      this.x.set(P.x);
      this.y.set(P.y);
      this.vx.fill(0);
      this.vy.fill(0);
    }

    step(tx, ty, stiff, h) {
      const sq = Math.sqrt(stiff);
      const { x, y, vx, vy } = this;
      for (let i = 0; i < N; i++) {
        const k = K[i] * stiff;
        const c = C[i] * sq;
        vx[i] += (k * (tx[i] - x[i]) - c * vx[i]) * h;
        vy[i] += (k * (ty[i] - y[i]) - c * vy[i]) * h;
        x[i] += vx[i] * h;
        y[i] += vy[i] * h;
      }
    }

    /** Thickness from the current (physical) length: area = head cap + tube,
     *  so stretching makes the rubber thinner and retracting re-inflates it. */
    computeRadius(p, air) {
      let W = 0;
      let pc = 0.05;
      for (let i = 0; i < HEAD_N; i++) if (p[i] > pc) pc = p[i];
      const { x, y } = this;
      for (let k = 0; k < SEGS; k++) {
        W += 0.5 * (p[k] + p[k + 1]) * Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k]);
      }
      const a = Math.PI * pc * pc;
      const rb = (-W + Math.sqrt(W * W + a * AREA0 * air)) / a;
      this.rb = rb;
      this.rHead = rb * pc;
      for (let i = 0; i < N; i++) this.r[i] = rb * p[i];
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Renderer — flat, one colour
  //
  //  Every spine point owns one "piece": a quadratic curve from the midpoint
  //  before it to the midpoint after it, stroked with round caps at twice the
  //  point's radius. Together the pieces form one smooth, flat silhouette in
  //  whatever shape the spine takes (egg, coil, loops). Knot and eyes on top.
  // ───────────────────────────────────────────────────────────────────────────

  const SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /** Smooth path through pieces a…b of the spine (midpoint quadratics). */
  function smoothD(X, Y, a, b) {
    const sx = a === 0 ? X[0] : 0.5 * (X[a - 1] + X[a]);
    const sy = a === 0 ? Y[0] : 0.5 * (Y[a - 1] + Y[a]);
    let d = 'M' + f1(sx) + ' ' + f1(sy);
    for (let i = a; i <= b; i++) {
      const ex = i === N - 1 ? X[i] : 0.5 * (X[i] + X[i + 1]);
      const ey = i === N - 1 ? Y[i] : 0.5 * (Y[i] + Y[i + 1]);
      d += 'Q' + f1(X[i]) + ' ' + f1(Y[i]) + ' ' + f1(ex) + ' ' + f1(ey);
    }
    return d;
  }

  function polyD(X, Y, a, b) {
    let d = 'M' + f1(X[a]) + ' ' + f1(Y[a]);
    for (let i = a + 1; i <= b; i++) d += 'L' + f1(X[i]) + ' ' + f1(Y[i]);
    return d;
  }

  // Eye shapes, in units of the eye radii: two cubic arcs (top, bottom) that
  // morph between a tall open oval, a focused squint, a happy "∩" and a blink.
  const EYE = {
    open: { w: 1.0, yc: 0.0, tt: -1.333, bb: 1.333, kt: 0, kb: 0 },
    focus: { w: 1.06, yc: 0.16, tt: -0.9, bb: 1.24, kt: 0.05, kb: 0 },
    happy: { w: 1.32, yc: 0.26, tt: -1.05, bb: -0.5, kt: 0, kb: 0.22 },
    shut: { w: 1.14, yc: 0.2, tt: -0.1, bb: 0.1, kt: 0, kb: 0 },
  };

  function mixEye(out, a, b, t) {
    for (const k in a) out[k] = a[k] + (b[k] - a[k]) * t;
  }

  function eyePath(cx, cy, rx, ry, sh, ca, sa) {
    const w = sh.w * rx;
    const yc = sh.yc * ry;
    const tt = sh.tt * ry;
    const bb = sh.bb * ry;
    const kt = sh.kt * w;
    const kb = sh.kb * w;
    const P = (x, y) => f1(cx + x * ca - y * sa) + ' ' + f1(cy + x * sa + y * ca);
    return (
      'M' + P(-w, yc) +
      'C' + P(-w + kt, yc + tt) + ' ' + P(w - kt, yc + tt) + ' ' + P(w, yc) +
      'C' + P(w - kb, yc + bb) + ' ' + P(-w + kb, yc + bb) + ' ' + P(-w, yc) + 'Z'
    );
  }

  function blinkCurve(t) {
    if (t < 0 || t > 0.2) return 0;
    if (t < 0.06) return smoothstep(0, 0.06, t);
    if (t < 0.09) return 1;
    return 1 - smoothstep(0.09, 0.2, t);
  }

  // The knot: a short pinch flaring into a rounded cup. Local units at full
  // size (R_IDLE = 100): x across, y along the tail, 0 = the pinch.
  const KNOT = [
    ['M', -NECK_R, -8], ['L', NECK_R, -8], ['L', NECK_R, 0],
    ['C', 17.5, 4.5, 22.4, 7, 22.4, 11.5],
    ['C', 22.4, 17.5, 16, 22, 0, 22],
    ['C', -16, 22, -22.4, 17.5, -22.4, 11.5],
    ['C', -22.4, 7, -17.5, 4.5, -NECK_R, 0], ['Z'],
  ];

  // Accent strokes (from the character sheet): short rounded dashes that fan
  // out from a focal point inside the balloon. Angles are in the balloon's own
  // frame; `rays` are offsets from the middle ray, `len` in units of R.
  const BURSTS = {
    // listening "perk" — upper left of a balloon leaning right (mirrored for left)
    perk: { mid: -2.64, focal: 0.69, dist: 0.64, rays: [0.434, 0, -0.434], len: [0.27, 0.3, 0.24], width: 0.105 },
    // complete — two strokes to the upper right
    cheer: { mid: -0.74, focal: 0.76, dist: 0.61, rays: [-0.286, 0.286], len: [0.32, 0.29], width: 0.12 },
  };

  class Renderer {
    constructor(svg) {
      const root = el('g', { class: 'balloon' }, svg);
      const accent = { fill: 'none', stroke: COLOR.base, 'stroke-linecap': 'round' };
      this.arcs = [0, 1].map(() => el('path', accent, root));

      const body = el('g', { class: 'balloon-body' }, root);
      const pieces = el('g', { fill: 'none', stroke: COLOR.base, 'stroke-linecap': 'round' }, body);
      this.pieces = [];
      for (let i = 0; i < N; i++) this.pieces.push(el('path', null, pieces));
      this.knot = el('path', { fill: COLOR.base }, body);
      const eyes = el('g', { fill: COLOR.eye, stroke: COLOR.eye, 'stroke-linejoin': 'round' }, body);
      this.eyes = [el('path', null, eyes), el('path', null, eyes)];

      this.perk = BURSTS.perk.rays.map(() => el('path', accent, root));
      this.cheer = BURSTS.cheer.rays.map(() => el('path', accent, root));

      this.debug = el('g', { display: 'none', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, root);
      this.dbgTarget = el('path', { stroke: '#111845', 'stroke-opacity': 0.35, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' }, this.debug);
      this.dbgSpine = el('path', { stroke: '#111845', 'stroke-width': 1.6 }, this.debug);
      this.dbgDots = el('path', { stroke: '#111845', 'stroke-width': 5 }, this.debug);
      this.dbgHead = el('circle', { r: 4, fill: '#3b5bdb' }, this.debug);
      this.showDebug = false;

      this.kdx = 0;
      this.kdy = 1;
    }

    setDebug(on) {
      this.showDebug = on;
      this.debug.setAttribute('display', on ? 'inline' : 'none');
    }

    /** Draws a burst of dashes around (hx, hy); p = 0 hidden … 1 fully out. */
    burst(els, spec, hx, hy, rh, p, mirror, rot) {
      const s = rh / R_IDLE;
      const mid = (mirror ? Math.PI - spec.mid : spec.mid) + rot;
      const fx = hx + Math.cos(mid) * spec.focal * R_IDLE * s;
      const fy = hy + Math.sin(mid) * spec.focal * R_IDLE * s;
      for (let j = 0; j < els.length; j++) {
        const e = els[j];
        if (p < 0.02) {
          e.setAttribute('display', 'none');
          continue;
        }
        const a = mid + (mirror ? -spec.rays[j] : spec.rays[j]);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const half = 0.5 * spec.len[j] * R_IDLE * s * Math.min(1, p);
        const d = spec.dist * R_IDLE * s * (0.78 + 0.22 * p);
        e.setAttribute('display', 'inline');
        e.setAttribute('d', 'M' + f1(fx + ca * (d - half)) + ' ' + f1(fy + sa * (d - half)) + 'L' + f1(fx + ca * (d + half)) + ' ' + f1(fy + sa * (d + half)));
        e.setAttribute('stroke-width', f1(spec.width * R_IDLE * s * Math.min(1, 0.4 + p)));
      }
    }

    render(av) {
      const b = av.body;
      const X = b.x;
      const Y = b.y;
      const R = b.r;

      for (let i = 0; i < N; i++) {
        const e = this.pieces[i];
        e.setAttribute('d', smoothD(X, Y, i, i));
        e.setAttribute('stroke-width', f1(2 * R[i]));
      }

      // Knot at the tail end, pointing along the tail.
      {
        let dx = X[N - 1] - X[N - 6];
        let dy = Y[N - 1] - Y[N - 6];
        const dl = Math.hypot(dx, dy);
        if (dl > 0.5) {
          dx /= dl;
          dy /= dl;
          this.kdx += (dx - this.kdx) * 0.35;
          this.kdy += (dy - this.kdy) * 0.35;
        }
        const kl = Math.hypot(this.kdx, this.kdy) || 1;
        const ux = this.kdx / kl;
        const uy = this.kdy / kl;
        const ks = clamp(R[N - 1] / NECK_R, 0.72, 1.12);
        const bx = X[N - 1];
        const by = Y[N - 1];
        let d = '';
        for (const seg of KNOT) {
          d += seg[0];
          for (let k = 1; k < seg.length; k += 2) {
            const lx = seg[k] * ks;
            const ly = seg[k + 1] * ks;
            d += f1(bx - uy * lx + ux * ly) + ' ' + f1(by + ux * lx + uy * ly) + ' ';
          }
        }
        this.knot.setAttribute('d', d);
      }

      // Eyes.
      const eg = av.eyeGeom;
      for (let j = 0; j < 2; j++) {
        const e = this.eyes[j];
        e.setAttribute('d', eyePath(eg.x[j], eg.y[j], eg.rx, eg.ry, eg.shape, eg.ca, eg.sa));
        e.setAttribute('stroke-width', f1(eg.stroke));
      }

      const hx = av.headX;
      const hy = av.headY;
      const rh = b.rHead;

      // Listening: dashes pop out on the far side of the lean.
      const side = av.fx.perkSide;
      this.burst(this.perk, BURSTS.perk, hx, hy, rh, av.fx.perk.x, side < 0, side * 0.17);

      // Complete: two dashes pop out to the upper right.
      const ct = av.env.now - av.fx.cheerT0;
      const cheer = ct < 0 ? 0 : ct < 0.2 ? EASE.outBack(ct / 0.2) : ct < 0.95 ? 1 : 1 - smoothstep(0.95, 1.25, ct);
      this.burst(this.cheer, BURSTS.cheer, hx, hy, rh, cheer, false, 0);

      // Working: motion arcs that ride along with the rotation.
      const wf = av.fx.work.x;
      for (let j = 0; j < 2; j++) {
        const arc = this.arcs[j];
        if (wf < 0.02) {
          arc.setAttribute('display', 'none');
          continue;
        }
        const mid = av.env.spin + NECK_ANGLE + 1.1 + j * Math.PI;
        const half = 0.32 * wf;
        const Ra = 176;
        const cy = -4;
        arc.setAttribute('display', 'inline');
        arc.setAttribute(
          'd',
          'M' + f1(Ra * Math.cos(mid - half)) + ' ' + f1(cy + Ra * Math.sin(mid - half)) +
            'A' + Ra + ' ' + Ra + ' 0 0 1 ' + f1(Ra * Math.cos(mid + half)) + ' ' + f1(cy + Ra * Math.sin(mid + half)),
        );
        arc.setAttribute('stroke-width', f1(7 * wf));
      }

      if (this.showDebug) {
        this.dbgTarget.setAttribute('d', polyD(av.tx, av.ty, 0, N - 1));
        this.dbgSpine.setAttribute('d', polyD(X, Y, 0, N - 1));
        let dots = '';
        for (let i = 0; i < N; i += 4) dots += 'M' + f1(X[i]) + ' ' + f1(Y[i]) + 'h0';
        this.dbgDots.setAttribute('d', dots);
        this.dbgHead.setAttribute('cx', f1(hx));
        this.dbgHead.setAttribute('cy', f1(hy));
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 9. BalloonAvatar — state machine, rig, face, public API
  // ───────────────────────────────────────────────────────────────────────────

  class BalloonAvatar {
    constructor(svg) {
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.env = { now: 0, motion: reduce ? 0.45 : 1, spin: 0, spinVel: 0 };
      this.mixer = new Mixer();
      this.body = new Body();
      this.renderer = new Renderer(svg);
      this.pose = makePose();
      this.tx = new Float32Array(N);
      this.ty = new Float32Array(N);

      // Reactive secondary motion.
      this.rig = {
        squash: new Spring(0, 220, 0.28), // + stretch tall / − squash wide
        wobble: new Spring(0, 140, 0.24), // rotation (rad)
        hop: new Spring(0, 70, 0.3), // vertical offset (px)
        air: new Spring(1, 120, 0.32), // air pressure (inflation overshoot)
        nudge: new Spring(0, 160, 0.4), // sideways nudge (listening)
      };
      this.fx = { work: new Spring(0, 40, 0.8), perk: new Spring(0, 120, 0.45), perkSide: 1, cheerT0: -10 };
      this.look = { x: new Spring(0, 90, 0.7), y: new Spring(0, 90, 0.7) };
      this.eyeShape = { ...EYE.open };
      this.eyeGeom = { x: [0, 0], y: [0, 0], rx: 10, ry: 16, shape: this.eyeShape, ca: 1, sa: 0, stroke: 2 };
      this.blinkT0 = -10;
      this.blinkDouble = false;
      this.nextBlink = 1.6 + Math.random() * 2;
      this.surprise = 0;
      this.lastNudge = -1;
      this.headX = 0;
      this.headY = IDLE_CY;
      this.headVX = 0;
      this.headVY = 0;
      this.pointer = null;

      this.state = 'idle';
      this.listeners = new Map();
      this.timers = []; // state-owned callbacks on the animation clock
      this.sequence = []; // queued { at, state } steps from play()
      this.timeScale = 1;
      this.paused = false;
      this.acc = 0;

      this.mixer.push('idle', 0, INSTANT, {});
      this.mixer.evaluate(0, this.env, this.pose);
      this.body.reset(this.pose);
      this.tx.set(this.pose.x);
      this.ty.set(this.pose.y);
      this.body.computeRadius(this.pose.p, 1);
      this.updateFace(0);
      this.renderer.render(this);

      this.lastTs = 0;
      this._frame = this._frame.bind(this);
      requestAnimationFrame(this._frame);
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /** Change state. Cancels a running sequence (use play() for sequences). */
    setState(name, opts = {}) {
      if (this.sequence.length) {
        this.sequence.length = 0;
        this.emit('sequence', { playing: false });
      }
      this._go(name, { ...opts, source: opts.source || 'user' });
    }

    /** Play timed steps: [{ state, hold }], on the animation clock. */
    play(steps) {
      this.sequence.length = 0;
      let at = this.env.now;
      const q = [];
      for (const s of steps) {
        q.push({ at, state: s.state, opts: s.opts || {} });
        at += s.hold || 0;
      }
      this.sequence = q;
      this._runSequence();
      this.emit('sequence', { playing: this.isPlaying });
    }

    get isPlaying() {
      return this.sequence.length > 0;
    }

    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(fn);
      return () => this.listeners.get(event).delete(fn);
    }

    /** Poke the balloon at (x, y) in SVG units: it dodges, squashes and wobbles. */
    poke(x, y) {
      const b = this.body;
      const rh = Math.max(30, b.rHead);
      const s2 = 2 * Math.pow(rh * 0.9, 2);
      for (let i = 0; i < N; i++) {
        const dx = b.x[i] - x;
        const dy = b.y[i] - y;
        const d = Math.hypot(dx, dy) || 1;
        const f = Math.exp(-(d * d) / s2) * 360;
        b.vx[i] += (dx / d) * f;
        b.vy[i] += (dy / d) * f;
      }
      this.rig.wobble.kick((x < this.headX ? 1 : -1) * 1.3);
      this.rig.squash.kick(-1.4);
      this.surprise = 1;
      this.blink();
      this.emit('poke', { x, y });
    }

    /** A tiny reaction, e.g. for each keystroke while listening. */
    nudge() {
      const now = this.env.now;
      if (now - this.lastNudge < 0.09) return;
      this.lastNudge = now;
      const side = this.state === 'listening' ? this.mixer.top.data.side || 1 : 1;
      this.rig.hop.kick(-40 - Math.random() * 25);
      this.rig.squash.kick(0.35);
      this.rig.nudge.kick(side * (30 + Math.random() * 30));
      if (this.state === 'listening') this.fx.perk.kick(1.6);
    }

    blink() {
      this.blinkT0 = this.env.now;
      this.blinkDouble = false;
    }

    /** Eyes glance toward a point (SVG units), or pass null to stop. */
    lookAt(x, y) {
      this.pointer = x == null ? null : { x, y };
    }

    hitTest(x, y) {
      const b = this.body;
      for (let k = 0; k < SEGS; k++) {
        const ax = b.x[k];
        const ay = b.y[k];
        const vx = b.x[k + 1] - ax;
        const vy = b.y[k + 1] - ay;
        const l2 = vx * vx + vy * vy;
        const t = l2 > 1e-6 ? clamp(((x - ax) * vx + (y - ay) * vy) / l2, 0, 1) : 0;
        const dx = ax + vx * t - x;
        const dy = ay + vy * t - y;
        const r = lerp(b.r[k], b.r[k + 1], t);
        if (dx * dx + dy * dy <= r * r) return true;
      }
      return false;
    }

    setDebug(on) {
      this.renderer.setDebug(on);
    }

    pause() {
      this.paused = true;
    }

    resume() {
      this.paused = false;
    }

    /** Step the simulation manually (handy for tests and frame captures). */
    advance(seconds, fps = 60) {
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) this.update(1 / fps);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    emit(event, data) {
      const set = this.listeners.get(event);
      if (set) for (const fn of set) fn(data);
    }

    at(layer, delay, fn) {
      this.timers.push({ at: layer.t0 + delay, layer, fn });
    }

    _go(name, opts = {}) {
      const motion = MOTIONS[name];
      if (!motion) {
        console.warn('[balloon] unknown state "' + name + '"; expected one of: ' + Object.keys(MOTIONS).join(', '));
        return;
      }
      const from = this.state;
      if (name === from && !opts.force) return;
      const spec = resolveTransition(from, name);
      if (motion.spins && !this.mixer.layers.some((l) => l.motion.spins)) {
        // Start the coil where the neck already hangs, so it winds instead of jumping.
        this.env.spin = Math.PI / 2 - NECK_ANGLE;
        this.env.spinVel = 0;
      }
      const layer = this.mixer.push(name, this.env.now, spec, {});
      this.state = name;
      if (motion.enter) motion.enter(layer, this, opts);
      if (spec.kick && KICKS[spec.kick]) KICKS[spec.kick](this);
      this.emit('statechange', {
        state: name,
        from,
        label: motion.label,
        caption: motion.caption,
        source: opts.source || 'user',
      });
    }

    _runSequence() {
      while (this.sequence.length && this.sequence[0].at <= this.env.now) {
        const step = this.sequence.shift();
        this._go(step.state, { ...step.opts, source: 'sequence' });
        if (!this.sequence.length) this.emit('sequence', { playing: false });
      }
    }

    celebrate() {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.rig.air.kick(1.5); // re-inflation pop
      this.rig.hop.kick(-420); // celebratory bounce
      this.rig.wobble.kick(side * 2.4); // wiggle…
      this.fx.cheerT0 = this.env.now + 0.02;
      const top = this.mixer.top;
      this.at(top, this.env.now - top.t0 + 0.36, () => this.rig.wobble.kick(-side * 1.8)); // …wiggle
    }

    _frame(ts) {
      const dt = this.lastTs ? Math.min(0.05, (ts - this.lastTs) / 1000) : 1 / 60;
      this.lastTs = ts;
      if (!this.paused) this.update(dt * this.timeScale);
      requestAnimationFrame(this._frame);
    }

    update(dt) {
      const env = this.env;
      env.now += dt;
      const now = env.now;

      this._runSequence();
      if (this.timers.length) {
        const due = this.timers.filter((t) => t.at <= now);
        if (due.length) {
          this.timers = this.timers.filter((t) => t.at > now);
          for (const t of due) if (t.layer === this.mixer.top) t.fn();
        }
      }

      // Shared rotation phase for the coiled states (thinking → working).
      const top = this.mixer.top;
      const sp = top.motion.spin || 0;
      const spinTarget = (typeof sp === 'function' ? sp(now - top.t0) : sp) * (0.5 + 0.5 * env.motion);
      env.spinVel += (spinTarget - env.spinVel) * (1 - Math.exp(-dt * 3.2));
      env.spin = (env.spin + env.spinVel * dt) % TAU;

      this.mixer.evaluate(now, env, this.pose);

      const h = 1 / 240;
      this.acc += dt;
      let n = 0;
      while (this.acc >= h && n < 30) {
        this.acc -= h;
        n++;
        this.substep(h);
      }
      if (n === 30) this.acc = 0;
      this.body.computeRadius(this.pose.p, this.rig.air.x);

      // Motion arcs appear once the flower has formed.
      this.fx.work.target = this.state === 'working' && now - this.mixer.top.t0 > 0.9 ? 1 : 0;
      this.fx.work.step(dt);
      this.fx.perk.target = this.state === 'listening' ? 1 : 0;
      this.fx.perk.step(dt);
      this.surprise = Math.max(0, this.surprise - dt * 2.2);

      this.updateFace(dt);
      this.renderer.render(this);
    }

    substep(h) {
      const rig = this.rig;
      // Squash & stretch follows the hop: stretch with speed, squash on the rebound.
      rig.squash.target = clamp(0.00012 * Math.abs(rig.hop.v) + 0.00005 * Math.min(rig.hop.a, 0), -0.14, 0.12);
      rig.air.target = this.pose.air;
      rig.squash.step(h);
      rig.wobble.step(h);
      rig.hop.step(h);
      rig.air.step(h);
      rig.nudge.step(h);

      const P = this.pose;
      const cx = P.cx;
      const cy = P.cy + 4 * (1 - P.coiled);
      const J = rig.squash.x;
      const sy = 1 + J;
      const sx = 1 / (1 + J);
      const ca = Math.cos(rig.wobble.x);
      const sa = Math.sin(rig.wobble.x);
      const ox = rig.nudge.x;
      const oy = rig.hop.x;
      for (let i = 0; i < N; i++) {
        const dx = (P.x[i] - cx) * sx;
        const dy = (P.y[i] - cy) * sy;
        this.tx[i] = cx + dx * ca - dy * sa + ox;
        this.ty[i] = cy + dx * sa + dy * ca + oy;
      }
      this.body.step(this.tx, this.ty, P.stiff, h);
    }

    updateFace(dt) {
      const b = this.body;
      const f = this.pose.face;
      const hx = b.x[HEAD_FACE]; // the body centre
      const hy = b.y[HEAD_FACE];
      if (dt > 0) {
        const k = 1 - Math.exp(-dt * 10);
        this.headVX += ((hx - this.headX) / dt - this.headVX) * k;
        this.headVY += ((hy - this.headY) / dt - this.headVY) * k;
      }
      this.headX = hx;
      this.headY = hy;

      // Where the eyes want to look (face space, about −1…1).
      let lx = f.lookX + clamp(this.headVX / 120, -0.6, 0.6);
      let ly = f.lookY + clamp(this.headVY / 120, -0.6, 0.6);
      if (f.track > 0) {
        const ex = b.x[N - 1] - hx;
        const ey = b.y[N - 1] - hy;
        const d = Math.hypot(ex, ey) || 1;
        lx += (f.track * ex) / d;
        ly += (f.track * ey) / d;
      }
      if (this.pointer && f.attention > 0) {
        const ex = this.pointer.x - hx;
        const ey = this.pointer.y - hy;
        const d = Math.hypot(ex, ey) || 1;
        const pull = f.attention * clamp(d / 120, 0, 1);
        lx += (pull * ex) / d;
        ly += (pull * ey) / d;
      }
      const lm = Math.hypot(lx, ly);
      if (lm > 1.1) {
        lx *= 1.1 / lm;
        ly *= 1.1 / lm;
      }
      this.look.x.target = lx;
      this.look.y.target = ly;
      if (dt > 0) {
        this.look.x.step(dt);
        this.look.y.step(dt);
      }

      // Blinks.
      const now = this.env.now;
      if (now >= this.nextBlink) {
        this.blinkT0 = now;
        this.blinkDouble = Math.random() < 0.22;
        this.nextBlink = now + 2.4 + Math.random() * 3.6;
      }
      let bl = blinkCurve(now - this.blinkT0);
      if (this.blinkDouble) bl = Math.max(bl, blinkCurve(now - this.blinkT0 - 0.24));
      bl *= 1 - f.happy;

      // Eye geometry, sized to the head so they shrink/grow with inflation.
      const es = 0.45 + 0.55 * clamp(b.rHead / R_IDLE, 0, 1.25);
      const tilt = f.tilt + this.rig.wobble.x * 0.5;
      const ca = Math.cos(tilt);
      const sa = Math.sin(tilt);
      const J = this.rig.squash.x;
      const wide = f.wide + this.surprise;
      const shape = this.eyeShape;
      mixEye(shape, EYE.open, EYE.focus, clamp(f.focus - this.surprise, 0, 1));
      mixEye(shape, shape, EYE.happy, f.happy);
      mixEye(shape, shape, EYE.shut, bl);
      const lookX = this.look.x.x;
      const lookY = this.look.y.x;
      const spacing = 47 * es * (1 + 0.1 * wide) * (1 - 0.08 * Math.abs(lookX));
      const lookPx = 6 * es;
      const fx = hx + (f.ox * ca - f.oy * sa) * es;
      const fy = hy + (f.ox * sa + f.oy * ca) * es;
      const g = this.eyeGeom;
      for (let j = 0; j < 2; j++) {
        const ex = (j === 0 ? -0.5 : 0.5) * spacing + lookX * lookPx;
        const ey = lookY * lookPx;
        g.x[j] = fx + ex * ca - ey * sa;
        g.y[j] = fy + ex * sa + ey * ca;
      }
      g.rx = (10.8 * es * (1 + 0.12 * wide)) / (1 + 0.5 * J);
      g.ry = 25.2 * es * (1 + 0.07 * wide) * (1 + 0.5 * J);
      g.shape = shape;
      g.ca = ca;
      g.sa = sa;
      g.stroke = 1.6 * es;
    }
  }

  // Exposed so motion can be tuned live from the console.
  BalloonAvatar.MOTIONS = MOTIONS;
  BalloonAvatar.TRANSITIONS = TRANSITIONS;
  window.BalloonAvatar = BalloonAvatar;

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Demo page wiring
  // ───────────────────────────────────────────────────────────────────────────

  const svg = document.getElementById('balloon-stage');
  if (!svg) return;

  const balloon = new BalloonAvatar(svg);
  window.balloon = balloon;

  const SEND_SEQUENCE = [
    { state: 'listening', hold: 0.9 },
    { state: 'thinking', hold: 2.4 },
    { state: 'working', hold: 2.8 },
    { state: 'complete' }, // returns to idle by itself
  ];

  const REPLIES = [
    'All done — here’s a tidy answer for you.',
    'Finished! I pulled that together for you.',
    'Done. Want me to go deeper on any part of it?',
    'Here you go. Ready for the next one whenever you are.',
  ];

  const nameEl = document.getElementById('state-name');
  const captionEl = document.getElementById('state-caption');
  const readout = document.querySelector('.readout');
  const stepButtons = Array.from(document.querySelectorAll('[data-state]'));
  const playBtn = document.getElementById('play-sequence');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('composer');
  const input = document.getElementById('composer-input');
  let pendingReply = null;
  let replyIndex = 0;
  let typingTimer = 0;

  balloon.on('statechange', ({ state, label, caption }) => {
    nameEl.textContent = label;
    captionEl.textContent = caption;
    readout.classList.remove('is-changing');
    void readout.offsetWidth; // restart the CSS animation
    readout.classList.add('is-changing');
    for (const btn of stepButtons) btn.setAttribute('aria-pressed', String(btn.dataset.state === state));
    if (state === 'complete' && pendingReply) {
      addMessage('bot', pendingReply);
      pendingReply = null;
    }
  });

  balloon.on('sequence', ({ playing }) => {
    playBtn.setAttribute('aria-busy', String(playing));
  });

  for (const btn of stepButtons) {
    btn.addEventListener('click', () => {
      pendingReply = null;
      balloon.setState(btn.dataset.state);
    });
  }

  playBtn.addEventListener('click', () => {
    pendingReply = null;
    const fromIdle = balloon.state === 'idle';
    balloon.play([{ state: 'idle', hold: fromIdle ? 0.5 : 1.0 }].concat(SEND_SEQUENCE.map((s) => ({ ...s, hold: s.hold && s.hold + 0.3 }))));
  });

  function addMessage(role, text) {
    const li = document.createElement('li');
    li.className = 'msg msg-' + role;
    li.textContent = text;
    log.appendChild(li);
    while (log.children.length > 6) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typingTimer);
    const text = input.value.trim() || 'Hello there!';
    addMessage('user', text);
    input.value = '';
    pendingReply = REPLIES[replyIndex++ % REPLIES.length];
    balloon.play(SEND_SEQUENCE);
  });

  // Typing is a real event the avatar can react to: lean in and listen.
  input.addEventListener('input', () => {
    if (balloon.isPlaying) return;
    const s = balloon.state;
    if (s !== 'idle' && s !== 'listening' && s !== 'complete') return;
    if (s !== 'listening') balloon.setState('listening');
    balloon.nudge();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      if (balloon.state === 'listening' && !balloon.isPlaying) balloon.setState('idle');
    }, 2600);
  });

  // Eyes follow the pointer a little when idle; poking the balloon squishes it.
  function toSvg(evt) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = svg.createSVGPoint();
    p.x = evt.clientX;
    p.y = evt.clientY;
    return p.matrixTransform(m.inverse());
  }

  window.addEventListener('pointermove', (e) => {
    const p = toSvg(e);
    if (p) balloon.lookAt(p.x, p.y);
  });
  document.documentElement.addEventListener('pointerleave', () => balloon.lookAt(null));
  svg.addEventListener('pointerdown', (e) => {
    const p = toSvg(e);
    if (p && balloon.hitTest(p.x, p.y)) balloon.poke(p.x, p.y);
  });

  // Inspect toggles.
  const slowmo = document.getElementById('toggle-slowmo');
  const rigToggle = document.getElementById('toggle-rig');
  slowmo.addEventListener('change', () => {
    balloon.timeScale = slowmo.checked ? 0.3 : 1;
  });
  rigToggle.addEventListener('change', () => balloon.setDebug(rigToggle.checked));

  // Keys 1–5 switch states (when not typing in the composer).
  const KEY_STATES = ['idle', 'listening', 'thinking', 'working', 'complete'];
  window.addEventListener('keydown', (e) => {
    if (e.target === input || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = Number(e.key) - 1;
    if (i >= 0 && i < KEY_STATES.length) balloon.setState(KEY_STATES[i]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Connecting real AI events
  //
  //  The avatar only needs to hear about lifecycle changes, e.g.:
  //    user starts typing          → BalloonAI.userTyping()
  //    request sent / reasoning    → BalloonAI.requestSent()
  //    tool calls / streaming      → BalloonAI.working()
  //    response finished           → BalloonAI.responseDone()  (returns to idle)
  // ───────────────────────────────────────────────────────────────────────────

  window.BalloonAI = {
    userTyping: () => balloon.setState('listening'),
    requestSent: () => balloon.setState('thinking'),
    working: () => balloon.setState('working'),
    responseDone: () => balloon.setState('complete'),
    reset: () => balloon.setState('idle'),
  };
})();
