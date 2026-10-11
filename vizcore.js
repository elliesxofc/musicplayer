/* moonlit · the visualizer's engine, shared by the app (the ring around the record) and the
   OBS overlay (music bars and the visualizer source), so both move exactly the same way.
   Options work like OBS's Spectralizer: filter (monstercat) + strength, detail (bars),
   gravity, automatic scaling, logarithmic frequency scale, stereo, round corners, bar sizes. */
(function (root) {
  const DEFAULTS = {
    style: 'bars', filter: 'none', strength: 1.5, bars: 72,
    speed: 1, inertia: 0, gravity: 0, spin: 0, size: 1,
    round: true, autoscale: false, log: false, stereo: false,
    color: 'theme', custom: '#ff7eb6', glow: true,
    barWidth: 6, barHeight: 100, barSpacing: 2,
  };

  // saved settings → full settings (older versions had the monstercat look as a style only)
  function options(saved) {
    const o = { ...DEFAULTS, ...(saved || {}) };
    if (saved && saved.style === 'monstercat' && saved.filter === undefined) o.filter = 'monstercat';
    o.bars = Math.max(8, Math.min(160, Math.round(o.bars)));
    return o;
  }

  // Which FFT bins each bar covers, bass to treble. Linear-ish (moonlit's usual curve) or
  // logarithmic (every octave gets the same room, like Spectralizer's log scale).
  const edgeCache = new Map();
  function edges(n, bins, log) {
    const key = `${n}|${bins}|${log}`;
    if (edgeCache.has(key)) return edgeCache.get(key);
    const lo = Math.max(1, Math.round(bins / 512)), hi = Math.floor(bins * 0.62);
    const at = x => (log ? lo * (hi / lo) ** x : lo + x ** 1.6 * (hi - lo));
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor(at(i / n));
      out.push([a, Math.max(a + 1, Math.floor(at((i + 1) / n)))]);
    }
    if (edgeCache.size > 40) edgeCache.clear();
    edgeCache.set(key, out);
    return out;
  }
  // n bar levels (0-255) from one channel's frequency data: each bar is the loudest bin it covers
  function bands(freq, n, log, out = new Array(n)) {
    const e = edges(n, freq.length, log);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let j = e[i][0]; j < e[i][1]; j++) if (freq[j] > peak) peak = freq[j];
      out[i] = peak;
    }
    return out;
  }

  // Monstercat filter: every loud bar lifts its neighbours, falling off by `strength` per
  // step, so the bars flow into smooth hills (lower strength = wider hills)
  function monstercat(v, strength = 1.5, from = 0, to = v.length) {
    const d = Math.max(1.05, strength);
    for (let z = from; z < to; z++) {
      let lift = v[z];
      for (let m = z - 1; m >= from && (lift /= d) > v[m]; m--) v[m] = lift;
      lift = v[z];
      for (let m = z + 1; m < to && (lift /= d) > v[m]; m++) v[m] = lift;
    }
    return v;
  }

  // Keeps the bars' state between frames: where they are, how fast they move, the recent peak.
  function shaper() {
    let levels = [], vel = [], peak = 0.3;
    return {
      levels: () => levels,
      // automatic scaling: quiet songs still fill the height (follows the loudest recent bar)
      scale(t, f) {
        let top = 0;
        for (const v of t) if (v > top) top = v;
        peak = Math.max(top, peak * 0.996 ** f, 0.08);
        const k = 1 / Math.max(peak, 0.2);
        for (let i = 0; i < t.length; i++) t[i] = Math.min(1, t[i] * k);
      },
      // moves the bars toward t. f = frames passed × speed (1 frame = 1/60 s)
      move(t, f, o) {
        const n = t.length;
        if (levels.length !== n) { levels = new Array(n).fill(0); vel = new Array(n).fill(0); }
        if (o.inertia > 0) {
          // inertia: a damped spring, so bars lag, swing past and settle
          const k = 0.42 - 0.36 * o.inertia, keep = 0.5 + 0.38 * o.inertia;
          const steps = Math.max(1, Math.ceil(f)), h = f / steps;
          for (let i = 0; i < n; i++) {
            let l = levels[i], v = vel[i];
            for (let s = 0; s < steps; s++) { v = (v + (t[i] - l) * k * h) * keep ** h; l += v * h; }
            if (l < 0) { l = 0; v = 0; }
            levels[i] = Math.min(1.25, l); vel[i] = v;
          }
        } else if (o.gravity > 0) {
          // gravity: bars jump up, then drop faster and faster (higher = heavier pull)
          const up = 1 - 0.4 ** f, g = o.gravity * 0.012;
          for (let i = 0; i < n; i++) {
            if (t[i] >= levels[i]) { levels[i] += (t[i] - levels[i]) * up; vel[i] = 0; continue; }
            vel[i] += g * f;
            levels[i] = Math.max(t[i], levels[i] - vel[i] * f);
          }
        } else {
          const up = 1 - 0.55 ** f, down = 1 - 0.88 ** f;
          for (let i = 0; i < n; i++) { levels[i] += (t[i] - levels[i]) * (t[i] > levels[i] ? up : down); vel[i] = 0; }
        }
        return levels;
      },
    };
  }

  root.VizCore = { DEFAULTS, options, edges, bands, monstercat, shaper };
})(typeof window !== 'undefined' ? window : globalThis);
