/*
 * Math Blitz problem generator.
 * Shared by the server (ranked games) and the browser (practice).
 *
 * Every problem gets a normalized key, so "7 x 48" and "48 x 7" count as the
 * same problem. A generator never hands out a key twice, and it can also be
 * given a list of keys to avoid (the server passes each player's history).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlitzGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

  // Commutative problems store their operands sorted so a+b and b+a match.
  function comm(sym, a, b) { return sym + '|' + Math.min(a, b) + '|' + Math.max(a, b); }

  function add(aMin, aMax, bMin, bMax) {
    return function () {
      const a = rint(aMin, aMax), b = rint(bMin, bMax);
      return { op: '+', text: a + ' + ' + b, answer: a + b, key: comm('+', a, b) };
    };
  }
  // a - b with b <= a - 1, so answers are always positive.
  function sub(aMin, aMax, bMin, bMax) {
    return function () {
      const a = rint(aMin, aMax);
      const b = rint(bMin, Math.min(bMax, a - 1));
      return { op: '-', text: a + ' − ' + b, answer: a - b, key: '-|' + a + '|' + b };
    };
  }
  function mul(aMin, aMax, bMin, bMax) {
    return function () {
      const a = rint(aMin, aMax), b = rint(bMin, bMax);
      return { op: '×', text: a + ' × ' + b, answer: a * b, key: comm('x', a, b) };
    };
  }
  // Division is built from a product so it always comes out whole.
  function div(dMin, dMax, qMin, qMax) {
    return function () {
      const d = rint(dMin, dMax), q = rint(qMin, qMax), n = d * q;
      return { op: '÷', text: n + ' ÷ ' + d, answer: q, key: '/|' + n + '|' + d };
    };
  }
  // a × b + c: multiplication first, then add.
  function mulAdd(aMin, aMax, bMin, bMax, cMin, cMax) {
    return function () {
      const a = rint(aMin, aMax), b = rint(bMin, bMax), c = rint(cMin, cMax);
      return {
        op: '×', text: a + ' × ' + b + ' + ' + c, answer: a * b + c,
        key: 'xa|' + Math.min(a, b) + '|' + Math.max(a, b) + '|' + c
      };
    };
  }

  // Ranked tiers. A player moves up a tier after enough correct answers.
  // Each tier's problem space is thousands of problems wide, so a player's
  // history can grow large before anything needs to repeat.
  const TIERS = [
    { tier: 1, points: 1, from: 0, makers: [
      add(11, 99, 11, 99),
      sub(21, 99, 11, 98)
    ] },
    { tier: 2, points: 2, from: 8, makers: [
      add(101, 999, 11, 99),
      sub(101, 999, 11, 99),
      mul(3, 9, 11, 49),
      div(3, 9, 11, 39)
    ] },
    { tier: 3, points: 3, from: 20, makers: [
      add(101, 999, 101, 999),
      sub(201, 999, 101, 998),
      mul(3, 9, 51, 99),
      div(6, 12, 12, 49)
    ] },
    { tier: 4, points: 4, from: 35, makers: [
      add(1001, 9999, 101, 999),
      sub(1001, 9999, 101, 999),
      mul(11, 25, 11, 99),
      div(11, 19, 11, 49),
      mulAdd(3, 9, 11, 49, 11, 99)
    ] }
  ];

  function tierForSolved(solved) {
    let t = TIERS[0];
    for (const x of TIERS) if (solved >= x.from) t = x;
    return t;
  }

  /*
   * Draw one fresh problem from a list of makers.
   * `used` is a Set of keys already handed out (updated in place);
   * `avoid` is an optional Set of keys from earlier games.
   * If a maker's space is crowded it moves on to another maker, and only as
   * a last resort accepts a problem from `avoid` (never one from `used`).
   * Returns null if every maker is exhausted.
   */
  function draw(makers, used, avoid) {
    const order = makers.slice().sort(function () { return Math.random() - 0.5; });
    let fallback = null;
    for (let round = 0; round < 4; round++) {
      for (const make of order) {
        for (let i = 0; i < 60; i++) {
          const p = make();
          if (used.has(p.key)) continue;
          if (avoid && avoid.has(p.key)) { if (!fallback) fallback = p; continue; }
          used.add(p.key);
          return p;
        }
      }
    }
    if (fallback) { used.add(fallback.key); return fallback; }
    return null;
  }

  const ALL_MAKERS = [];
  for (const t of TIERS) for (const m of t.makers) ALL_MAKERS.push(m);

  // Build the pools for one ranked game: a separate queue per tier.
  function buildRankedPools(avoidKeys, sizes) {
    sizes = sizes || { 1: 45, 2: 50, 3: 55, 4: 160 };
    const used = new Set();
    const avoid = avoidKeys ? new Set(avoidKeys) : null;
    const pools = {};
    for (const t of TIERS) {
      pools[t.tier] = [];
      for (let i = 0; i < sizes[t.tier]; i++) {
        const p = draw(t.makers, used, avoid) || draw(ALL_MAKERS, used, null);
        if (!p) break;
        pools[t.tier].push({ text: p.text, answer: p.answer, key: p.key });
      }
    }
    return pools;
  }

  // Practice: pick operations and a level; problems never repeat in a session.
  const LEVELS = { easy: [1, 2], medium: [2, 3], hard: [3, 4] };
  function practiceSource(ops, level) {
    const tiers = LEVELS[level] || LEVELS.medium;
    function makersFor(tierList) {
      const out = [];
      for (const t of TIERS) {
        if (tierList.indexOf(t.tier) === -1) continue;
        for (const m of t.makers) {
          const sample = m();
          if (ops.indexOf(sample.op) !== -1) out.push(m);
        }
      }
      return out;
    }
    let makers = makersFor(tiers);
    if (!makers.length) makers = makersFor([1, 2, 3, 4]);
    const used = new Set();
    let widened = false;
    return { next: function () {
      let p = draw(makers, used, null);
      // A narrow choice (say, easy division only) can run dry in a long
      // session: first widen to the same operations at every level, and only
      // after that let old problems come back.
      if (!p && !widened) { widened = true; makers = makersFor([1, 2, 3, 4]); p = draw(makers, used, null); }
      if (!p) { used.clear(); p = draw(makers, used, null); }
      return p;
    } };
  }

  return { TIERS: TIERS, tierForSolved: tierForSolved, buildRankedPools: buildRankedPools, practiceSource: practiceSource };
});
