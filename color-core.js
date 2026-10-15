/* =========================================================
   Image Palette Studio · 色彩算法核心（与 UI / DOM 无关的纯函数）
   ---------------------------------------------------------
   · RGB / HEX / HSL / HSV 互转     · WCAG 亮度 / 对比度 / 等级
   · sRGB ↔ OKLab（感知均匀空间）   · 取色：中位切分 + K-means + 近似色合并
   · 可读性适配：饱和度可信带 + 整组分档调和
   · 智能文字配色：区域分析 → 候选生成 → 评分 → 三套方案
   双端加载：浏览器挂 window.ColorCore（须在 app.js 之前引入）；
             Node 走 module.exports（供 tests/ 单元测试 require）。
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColorCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 基础工具 ---------- */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }
  function hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) { const v = l * 255; return [v, v, v]; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
  }

  /* ---------- WCAG ---------- */
  /* WCAG 相对亮度 */
  function relLum([r, g, b]) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  /* WCAG 对比度 */
  function contrast(a, b) {
    const la = relLum(a), lb = relLum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function levelOf(ratio) {
    if (ratio >= 7)   return { cls: 'is-ok',   label: 'AAA · 优异' };
    if (ratio >= 4.5) return { cls: 'is-ok',   label: 'AA · 可读' };
    if (ratio >= 3)   return { cls: 'is-warn', label: 'AA · 仅大字' };
    return { cls: 'is-bad', label: '不可读' };
  }

  /* ---------- 命名 ---------- */
  /* 常用色名（用于给色卡命名，非精确科学命名） */
  const NAMED = [
    ['纯黑', '#000000'], ['墨黑', '#1E293B'], ['铅灰', '#475569'], ['银灰', '#CBD5E1'],
    ['纯白', '#FFFFFF'], ['象牙白', '#FAF7F0'], ['米白', '#F5F0E6'], ['沙色', '#D6C3A5'],
    ['棕褐', '#78350F'], ['陶土', '#B45309'], ['落日橙', '#E67E22'], ['琥珀金', '#FBBF24'],
    ['柠檬黄', '#D8FF3E'], ['黄绿', '#A3E635'], ['草绿', '#22C55E'], ['翡翠绿', '#10B981'],
    ['青碧', '#14B8A6'], ['天青', '#06B6D4'], ['湖蓝', '#0EA5E9'], ['群青', '#3B82F6'],
    ['靛蓝', '#4F46E5'], ['紫罗兰', '#8B5CF6'], ['藕荷', '#C9A7E0'], ['品红', '#D946EF'],
    ['玫瑰粉', '#EC4899'], ['藕粉', '#F9A8D4'], ['珊瑚红', '#FF6B5B'], ['绯红', '#E74C3C'],
    ['朱砂', '#C0392B'],
  ];
  function nameOf(rgb) {
    let best = NAMED[0][0], bestD = Infinity;
    for (let i = 0; i < NAMED.length; i++) {
      const c = hexToRgb(NAMED[i][1]);
      const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
      if (d < bestD) { bestD = d; best = NAMED[i][0]; }
    }
    return best;
  }

  /* ---------- OKLab ----------
     取色算法：① 转到感知均匀的 OKLab；② 中位切分给出初始聚类；
     ③ K-means 在 OKLab 中收敛到画面真实主色；④ 合并过于接近的色；⑤ 按占比排序。
     这样每种颜色都对应画面中一片真实区域，整体更贴合图片风格。 */

  /* sRGB ↔ OKLab（Björn Ottosson 公式），感知均匀，避免 RGB 均值失真 */
  function srgbToLinear(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function linearToSrgb(v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
  function rgbToOklab(rgb) {
    const lr = srgbToLinear(rgb[0]), lg = srgbToLinear(rgb[1]), lb = srgbToLinear(rgb[2]);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }
  function oklabToRgb(lab) {
    const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
    const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
    const s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2];
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [
      linearToSrgb( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) * 255,
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) * 255,
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) * 255,
    ].map((v) => clamp(Math.round(v), 0, 255));
  }
  /* OKLab 感知距离（用平方，省去开方） */
  function distLab(a, b) {
    const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
    return dl * dl + da * da + db * db;
  }

  /* ---------- OKLCH（OKLab 的极坐标）----------
     L（感知明度，0–1）  C（感知色度 ≥ 0）  H（色相角 0–360°）
     在 OKLCH 里独立调 L 和 C 完全不互相污染，且能把超出 sRGB 色域的颜色
     用「逐步降 C 直到通道落回 [0,1]」的方式柔和映射，不会像直接裁 RGB 那样偏色。 */
  function oklabToOklch(lab) {
    const L = lab[0];
    const C = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
    let H = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
    if (H < 0) H += 360;
    return [L, C, H];
  }
  function oklchToOklab([L, C, H]) {
    const h = H * Math.PI / 180;
    return [L, C * Math.cos(h), C * Math.sin(h)];
  }
  /* gamutMap：从 OKLCH 回 sRGB 时，若超出 [0,255] 就逐步降 C，
     让颜色以最短路径落回色域，保持色相稳定（远好于直接 clamp RGB）。
     同时把 L 夹紧到 [0.02, 0.98]，避免产生几乎纯黑/纯白的极端值。 */
  function gamutMap(l, c, h) {
    l = clamp(l, 0.02, 0.98);
    if (c < 0.0001) return oklabToRgb(oklchToOklab([l, 0, h]));
    let step = c;
    for (let k = 0; k < 16; k++) {
      const rgb = oklabToRgb(oklchToOklab([l, c, h]));
      if (rgb.every((v) => v >= -2 && v <= 257)) {
        if (rgb.every((v) => v >= 0 && v <= 255)) return rgb.map((v) => clamp(Math.round(v), 0, 255));
      }
      c -= step;
      step *= 0.5;
      if (c < 0.0005) break;
    }
    return oklabToRgb(oklchToOklab([l, 0, h])).map((v) => clamp(Math.round(v), 0, 255));
  }
  /* enhanceColor：在 OKLCH 里独立调 L / C / H，再经 gamutMap 回 RGB。
     ΔL、ΔC 是绝对增量（0–1 感知尺度），hueShift 是度。 */
  function enhanceColor(rgb, dL, dC, hueShift) {
    const [L, C, H] = oklabToOklch(rgbToOklab(rgb));
    return gamutMap(L + (dL || 0), C + (dC || 0), (((H + (hueShift || 0)) % 360) + 360) % 360);
  }
  /* enhancementDegree：返回增强色相对于原色的感知差异（ΔL / ΔC / ΔH / 总感知距离）。
     把「色彩增强程度」量化出来，方便 UI 上与「可读性」并列显示。 */
  function enhancementDegree(origRgb, newRgb) {
    const o = oklabToOklch(rgbToOklab(origRgb));
    const n = oklabToOklch(rgbToOklab(newRgb));
    let dh = n[2] - o[2];
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const per = rgbToOklab(origRgb);
    const pne = rgbToOklab(newRgb);
    return {
      dL: +(n[0] - o[0]).toFixed(3),
      dC: +(n[1] - o[1]).toFixed(3),
      dH: +dh.toFixed(1),
      dist: +Math.sqrt(distLab(per, pne)).toFixed(3),
    };
  }
  /* generateVariants：从一个原色生成 8 种连续变体 + 4 种横跨变体。
     正向变体保留原色的大致亮度区间（适合装饰/协调）；
     横跨变体把 L 直接拉到对端（亮原色→暗侧，暗原色→亮侧），
     保留色相与色度方向，用来做背景的互补文字色（方案一/二的主力）。 */
  const VARIANT_DEFS = [
    { key: 'original',  label: '原始色',   dL: 0.00, dC: 0.00, h: 0 },
    { key: 'slightly',  label: '微亮色',   dL: 0.08, dC: 0.02, h: 0 },
    { key: 'translucent', label: '清透色', dL: 0.14, dC: 0.10, h: 0 },
    { key: 'vivid',     label: '鲜亮色',   dL: 0.10, dC: 0.18, h: 0 },
    { key: 'highlight', label: '高亮色',   dL: 0.22, dC: 0.05, h: 0 },
    { key: 'highchroma', label: '高色度色', dL: 0.02, dC: 0.24, h: 0 },
    { key: 'brightvivid', label: '明亮高色度', dL: 0.18, dC: 0.18, h: 0 },
    { key: 'light',     label: '浅色变体', dL: 0.28, dC: 0.02, h: 0 },
  ];
  const CROSS_DEFS_LIGHT = [ /* 亮原色 → 往暗侧拉，保留色相 */
    { key: 'cross-mid',  label: '同色系中间调', targetL: 0.48, dC: 0.12 },
    { key: 'cross-dark', label: '同色系深调',   targetL: 0.28, dC: 0.08 },
  ];
  const CROSS_DEFS_DARK = [ /* 暗原色 → 往亮侧拉，保留色相 */
    { key: 'cross-mid',  label: '同色系中间调', targetL: 0.55, dC: 0.08 },
    { key: 'cross-light', label: '同色系亮调',   targetL: 0.82, dC: 0.04 },
  ];
  function generateVariants(rgb, opts) {
    opts = opts || {};
    const dLScale = opts.dLScale != null ? opts.dLScale : 1;
    const dCScale = opts.dCScale != null ? opts.dCScale : 1;
    const satMax = opts.satMax != null ? opts.satMax : 100;
    const [oL, oC, oH] = oklabToOklch(rgbToOklab(rgb));
    const out = [];
    const clampSat = (rgb) => {
      if (satMax >= 100) return rgb;
      const hsl = rgbToHsl(rgb);
      if (hsl.s <= satMax) return rgb;
      return hslToRgb(hsl.h, satMax, hsl.l).map((v) => clamp(Math.round(v), 0, 255));
    };
    const push = (def, kind) => {
      let dL, dC;
      if (kind === 'cross') {
        dL = def.targetL - oL;        /* 直接拉到对端目标明度 */
        dC = def.dC * dCScale;
      } else {
        /* 正向：原色本身已亮/已艳时自动收缩增强幅度 */
        let dLfac = 1;
        if (oL > 0.70) dLfac = Math.max(0.12, 1 - (oL - 0.70) / 0.30);
        if (oL > 0.88) dLfac *= 0.5;
        let dCfac = 1;
        if (oC > 0.18) dCfac = Math.max(0.12, 1 - (oC - 0.18) / 0.22);
        if (oC < 0.04) dCfac *= 0.55;
        dL = def.dL * dLfac * dLScale;
        dC = def.dC * dCfac * dCScale;
      }
      let newRgb = enhanceColor(rgb, dL, dC, 0);
      newRgb = clampSat(newRgb);
      out.push({
        key: (kind === 'cross' ? 'cross-' : '') + def.key, label: def.label,
        rgb: newRgb, hex: rgbToHex(newRgb),
        hsl: rgbToHsl(newRgb),
        degree: enhancementDegree(rgb, newRgb),
      });
    };
    VARIANT_DEFS.forEach((def) => push(def, 'forward'));
    const crossDefs = oL >= 0.5 ? CROSS_DEFS_LIGHT : CROSS_DEFS_DARK;
    crossDefs.forEach((def) => push(def, 'cross'));
    return out;
  }

  /* 盒内感知跨度最大的通道：明度天然占主导，色度加权以保留色彩层次 */
  const CH_W = [1, 1.6, 1.6];
  /* 饱和度加权强度：OKLab 色度越高的像素，在质心计算中权重越大 */
  const SAT_W = 3.0;
  function chromaOf(p) { return Math.sqrt(p[1] * p[1] + p[2] * p[2]); }
  function widestChannel(box) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < box.length; i++) {
      const p = box[i];
      for (let c = 0; c < 3; c++) { if (p[c] < mn[c]) mn[c] = p[c]; if (p[c] > mx[c]) mx[c] = p[c]; }
    }
    let max = 0, ch = 0;
    for (let c = 0; c < 3; c++) { const r = (mx[c] - mn[c]) * CH_W[c]; if (r > max) { max = r; ch = c; } }
    return { max, ch };
  }
  /* 中位切分：给出 k 个初始聚类盒 */
  function medianCutLab(pixels, k) {
    let boxes = [pixels];
    while (boxes.length < k) {
      let idx = -1, bestRange = 0, bestCh = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const r = widestChannel(boxes[i]);
        if (r.max > bestRange) { bestRange = r.max; idx = i; bestCh = r.ch; }
      }
      if (idx < 0 || bestRange <= 1e-4) break;
      const sorted = boxes[idx].slice().sort((a, b) => a[bestCh] - b[bestCh]);
      const mid = sorted.length >> 1;
      boxes.splice(idx, 1, sorted.slice(0, mid), sorted.slice(mid));
    }
    return boxes;
  }
  function meanLab(box) {
    if (!box.length) return null;
    let l = 0, a = 0, b = 0, wsum = 0;
    for (let i = 0; i < box.length; i++) {
      const w = 1 + SAT_W * chromaOf(box[i]);
      l += box[i][0] * w; a += box[i][1] * w; b += box[i][2] * w; wsum += w;
    }
    return [l / wsum, a / wsum, b / wsum];
  }
  /* K-means（Lloyd）：中位切分作初值；质心按饱和度加权，
     避免大片低饱和背景把代表色拉灰；收敛后若簇数不足 k，
     把内部跨度最大的簇一分为二补足名额，尽量给满 k 色 */
  function kmeansLab(pixels, k, iters, mergeThr) {
    const mergeSq = (mergeThr || 0.04) * (mergeThr || 0.04);
    let centroids = medianCutLab(pixels, k).map(meanLab).filter(Boolean);
    if (!centroids.length) return [];
    const assign = new Int32Array(pixels.length).fill(-1);

    function lloyd(rounds) {
      for (let it = 0; it < rounds; it++) {
        let changed = false;
        for (let i = 0; i < pixels.length; i++) {
          const p = pixels[i];
          let best = 0, bestD = Infinity;
          for (let c = 0; c < centroids.length; c++) {
            const d = distLab(p, centroids[c]);
            if (d < bestD) { bestD = d; best = c; }
          }
          if (assign[i] !== best) { assign[i] = best; changed = true; }
        }
        const sum = centroids.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < pixels.length; i++) {
          const p = pixels[i], w = 1 + SAT_W * chromaOf(p), s = sum[assign[i]];
          s[0] += p[0] * w; s[1] += p[1] * w; s[2] += p[2] * w; s[3] += w;
        }
        for (let c = 0; c < centroids.length; c++) {
          if (sum[c][3]) centroids[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
        }
        if (!changed) break;
      }
    }
    lloyd(iters || 8);

    /* 补足名额：候选 = 像素多且内部跨度足够的簇；切分后两质心需彼此可区分 */
    while (centroids.length < k) {
      const groups = centroids.map(() => []);
      for (let i = 0; i < pixels.length; i++) groups[assign[i]].push(pixels[i]);
      const cands = [];
      for (let c = 0; c < groups.length; c++) {
        const g = groups[c];
        if (g.length >= 4) {
          const r = widestChannel(g);
          if (r.max > 0.05) cands.push({ g, ch: r.ch, c });
        }
      }
      cands.sort((x, y) => y.g.length - x.g.length);
      let split = false;
      for (const cand of cands) {
        const sorted = cand.g.slice().sort((a, b) => a[cand.ch] - b[cand.ch]);
        const mid = sorted.length >> 1;
        const qa = meanLab(sorted.slice(0, mid)), qb = meanLab(sorted.slice(mid));
        if (!qa || !qb || distLab(qa, qb) < mergeSq) continue;
        centroids[cand.c] = qa;
        centroids.push(qb);
        lloyd(2);
        split = true;
        break;
      }
      if (!split) break;
    }

    const count = centroids.map(() => 0);
    for (let i = 0; i < pixels.length; i++) count[assign[i]]++;
    return centroids.map((c, i) => ({ lab: c, n: count[i] })).filter((c) => c.n > 0);
  }
  /* 合并感知上过于接近的色，避免把取色名额浪费在近似色上 */
  function mergeClose(clusters, thr) {
    const out = [];
    clusters.sort((a, b) => b.n - a.n);
    clusters.forEach((cl) => {
      for (let i = 0; i < out.length; i++) {
        if (distLab(cl.lab, out[i].lab) < thr * thr) {
          const o = out[i];
          const n = o.n + cl.n;
          o.lab = o.lab.map((v, j) => (v * o.n + cl.lab[j] * cl.n) / n);
          o.n = n;
          return;
        }
      }
      out.push({ lab: cl.lab.slice(), n: cl.n });
    });
    return out;
  }

  /* ---------- 可读性适配 ---------- */
  /* 单色适配：保色相，先把饱和度拉回"可信带"，再解出达标的明度（规律取自真实图文海报）：
     ① 低饱和源色（s<20）没有有效的色相信息，归一为干净的染色中性 → 淡而不脏；
     ② 中高饱和源色按方向收拢：暗底提亮轻降饱和（亮而不艳），亮底压深略提饱和（深而不灰）；
     ③ 高明度端继续减饱和，趋近同色相染色白。 */
  function satBand(s, lighten) {
    if (s < 20) return lighten ? 8 + s * 0.4 : 10 + s * 0.5;
    return lighten ? clamp(s, 28, 60) : clamp(s * 1.1, 30, 68);
  }
  function adaptForContrast(rgb, bgRgb, target) {
    const t = target || 4.5;
    const hsl = rgbToHsl(rgb);
    const band = (l) => {
      let s = satBand(hsl.s, l >= hsl.l);
      if (l > hsl.l && l > 85) s *= 1 - ((l - 85) / 13) * 0.6; // 染色白：越高越淡
      return clamp(s, 0, 100);
    };
    let bestRgb = rgb, bestDist = Infinity, found = false;
    for (let l = 2; l <= 98; l += 2) {
      const cand = hslToRgb(hsl.h, band(l), l);
      if (contrast(cand, bgRgb) >= t) {
        const dist = Math.abs(l - hsl.l);
        if (dist < bestDist) { bestDist = dist; bestRgb = cand; found = true; }
      }
    }
    if (!found) { // 无法达标时取对比度最大的明度
      let maxRatio = -1;
      for (let l = 0; l <= 100; l += 2) {
        const cand = hslToRgb(hsl.h, band(l), l);
        const ratio = contrast(cand, bgRgb);
        if (ratio > maxRatio) { maxRatio = ratio; bestRgb = cand; }
      }
    }
    return bestRgb;
  }

  /* ---------- 整组调和 ---------- */
  /* 把所有色卡铺进同一句话时，单色达标还不够，整组也要好看：
     ① 按画面占比分档（色卡顺序即占比顺序）：占比大的更素更亮（稳重），
        占比小的更艳（跳跃），与真实海报"大面积素、小面积点缀"的习惯一致；
     ② 本身足够鲜艳（s≥50）的颜色保留个性，只确保可读；
     ③ 组内两两感知距离过近时逐级推开（提饱和 → 挪明度 → 微调色相），
        保证同屏每段文字的颜色都能被分辨。 */
  const SEPARATE_SQ = 0.055 * 0.055; // 两两最小感知距离（OKLab，平方）
  function harmonizePalette(rgbs, bgRgb, target) {
    const t = target || 4.5;
    const n = rgbs.length;
    if (!n) return [];
    const bgLight = relLum(bgRgb) >= 0.30;
    const out = rgbs.map((rgb, i) => {
      const base = adaptForContrast(rgb, bgRgb, t);
      if (rgbToHsl(rgb).s >= 50) return base;            // 强调色保持自我
      const u = n > 1 ? i / (n - 1) : 0.5;
      const sSlot = bgLight ? 12 + u * 40 : 8 + u * 44;  // 素 → 艳 的档位
      const lSlot = bgLight ? 34 - u * 10 : 92 - u * 12; // 亮 → 深 的明度
      const hsl = rgbToHsl(base);
      const s = Math.max(hsl.s, sSlot);
      let l = bgLight ? Math.min(hsl.l, lSlot) : Math.max(hsl.l, lSlot);
      const step = bgLight ? -2 : 2;                     // 从档位明度出发找第一个达标的
      for (; l >= 2 && l <= 98; l += step) {
        const cand = hslToRgb(hsl.h, s, l);
        if (contrast(cand, bgRgb) >= t) return cand;
      }
      return base;
    });
    for (let guard = 0; guard < 40; guard++) {           // 两两推开，保证段与段可辨
      let worst = null;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = distLab(out[i], out[j]);
          if (d < SEPARATE_SQ && (!worst || d < worst.d)) worst = { i, j, d };
        }
      }
      if (!worst) break;
      const h = rgbToHsl(out[worst.j]);
      const s2 = Math.min(h.s + 6, 68);
      let cand = hslToRgb(h.h, s2, h.l);
      if (distLab(out[worst.i], cand) < SEPARATE_SQ) {
        const l2 = bgLight ? Math.max(h.l - 3, 4) : Math.min(h.l + 3, 96);
        cand = hslToRgb(h.h, s2, l2);
      }
      if (distLab(out[worst.i], cand) < SEPARATE_SQ) {
        cand = hslToRgb((h.h + 14) % 360, s2, h.l);      // 同色系分不开就偏移色相
      }
      if (contrast(cand, bgRgb) < t) break;              // 推不开时以可读性优先
      out[worst.j] = cand;
    }
    return out;
  }

  /* =========================================================
     智能文字配色：区域分析 → 候选生成 → 评分过滤 → 三套方案
     ========================================================= */

  /* ---------- HSV ---------- */
  function rgbToHsv([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h: h * 360, s: (max ? d / max : 0) * 100, v: max * 100 };
  }

  const hueShift = (h, d) => (((h + d) % 360) + 360) % 360;
  function hueName(h) {
    h = ((h % 360) + 360) % 360;
    if (h < 15 || h >= 345) return '红';
    if (h < 40) return '橙';
    if (h < 65) return '黄';
    if (h < 95) return '黄绿';
    if (h < 150) return '绿';
    if (h < 185) return '青';
    if (h < 250) return '蓝';
    if (h < 295) return '紫';
    return '品红';
  }

  /* ---------- 区域分析 ----------
     输入：区域内像素的 WCAG 亮度数组 lums 与 RGB 数组 rgbs（3/n）。
     输出：明暗分布（分位数/极差/方差/高光阴影占比）、平均色与主色、
           最亮/最暗 10% 代表色（用于最不利对比度）、冷暖、复杂度。 */
  function meanRgbSlice(rgbs, order, from, to) {
    let r = 0, g = 0, b = 0;
    const n = to - from;
    for (let i = from; i < to; i++) {
      const p = order[i] * 3;
      r += rgbs[p]; g += rgbs[p + 1]; b += rgbs[p + 2];
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128];
  }
  function analyzeRegion(lums, rgbs) {
    const n = lums.length;
    if (!n) return null;
    let sumL = 0, sr = 0, sg = 0, sb = 0, hi = 0, sh = 0, warm = 0, satSum = 0;
    let minL = 1, maxL = 0;
    for (let i = 0; i < n; i++) {
      const l = lums[i];
      sumL += l;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      if (l >= 0.55) hi++;
      if (l <= 0.12) sh++;
      const r = rgbs[i * 3], g = rgbs[i * 3 + 1], b = rgbs[i * 3 + 2];
      sr += r; sg += g; sb += b;
      warm += r - b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      satSum += mx ? (mx - mn) / mx : 0;
    }
    const meanL = sumL / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) { const d = lums[i] - meanL; varSum += d * d; }
    const std = Math.sqrt(varSum / n);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lums[a] - lums[b]);
    const k = Math.max(1, Math.round(n * 0.1));
    /* 主色：RGB 各 4bit 量化桶计数，取最大桶的桶内均值 */
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const key = ((rgbs[i * 3] >> 4) << 8) | ((rgbs[i * 3 + 1] >> 4) << 4) | (rgbs[i * 3 + 2] >> 4);
      const e = buckets.get(key) || [0, 0, 0, 0];
      e[0] += rgbs[i * 3]; e[1] += rgbs[i * 3 + 1]; e[2] += rgbs[i * 3 + 2]; e[3]++;
      buckets.set(key, e);
    }
    let domB = null;
    buckets.forEach((e) => { if (!domB || e[3] > domB[3]) domB = e; });
    const range = maxL - minL;
    const complexity = clamp(0.5 * range + 0.5 * Math.min(1, std * 4.2), 0, 1);
    return {
      n,
      meanLum: meanL, lumMin: minL, lumMax: maxL, lumStd: std,
      lumP50: lums[order[Math.floor(n / 2)]],
      highlightRatio: hi / n, shadowRatio: sh / n,
      meanRgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
      dominantRgb: [Math.round(domB[0] / domB[3]), Math.round(domB[1] / domB[3]), Math.round(domB[2] / domB[3])],
      brightRgb: meanRgbSlice(rgbs, order, n - k, n),
      darkRgb: meanRgbSlice(rgbs, order, 0, k),
      warmCool: clamp((warm / n) / 60, -1, 1),
      satMean: (satSum / n) * 100,
      complexity,
      isComplex: complexity > 0.42,
    };
  }

  /* ---------- 底衬合成与对比度评估 ---------- */
  function scrimComposite(rgb, dark, alpha) {
    const c = dark ? 0 : 255;
    return rgb.map((v) => Math.round(v * (1 - alpha) + c * alpha));
  }
  /* 最不利对比：浅字怕最亮处、深字怕最暗处 → 取两端的最小值 */
  function evaluateOnRegion(fgRgb, region, scrim) {
    let meanRgb = region.meanRgb, brightRgb = region.brightRgb, darkRgb = region.darkRgb;
    if (scrim) {
      meanRgb = scrimComposite(meanRgb, scrim.dark, scrim.alpha);
      brightRgb = scrimComposite(brightRgb, scrim.dark, scrim.alpha);
      darkRgb = scrimComposite(darkRgb, scrim.dark, scrim.alpha);
    }
    return {
      avg: contrast(fgRgb, meanRgb),
      worst: Math.min(contrast(fgRgb, brightRgb), contrast(fgRgb, darkRgb)),
    };
  }
  /* 可读性状态（按「最不利处」判级：照片背景必须考虑最坏情况） */
  function contrastStatus(worst) {
    if (worst >= 4.5) return { key: 'read', label: '推荐阅读', cls: 'is-ok' };
    if (worst >= 3) return { key: 'head', label: '适合大标题', cls: 'is-head' };
    if (worst >= 2) return { key: 'art', label: '艺术装饰', cls: 'is-art' };
    return { key: 'bad', label: '对比度不足', cls: 'is-bad' };
  }

  /* ---------- 候选生成 ----------
     来源：背景主色 / 辅助色明度变体、邻近、互补、分裂互补、
           中性色、低饱和强调色，以及画面原色。 */
  function pickCandidates(bgRgb, region, palRgbs, opts) {
    opts = opts || {};
    const out = [];
    const seen = [];
    const push = (rgb, kind, source) => {
      rgb = rgb.map((v) => clamp(Math.round(v), 0, 255));
      const lab = rgbToOklab(rgb);
      for (const s of seen) if (distLab(s, lab) < 0.025 * 0.025) return;
      seen.push(lab);
      out.push({ rgb, hex: rgbToHex(rgb), hsl: rgbToHsl(rgb), kind, source });
    };
    /* 明度方向：深区给浅字、浅区给深字、中间区两者都给 */
    const p50 = region ? region.lumP50 : relLum(bgRgb);
    const dirs = p50 < 0.2 ? ['light', 'mid'] : p50 > 0.55 ? ['dark', 'mid'] : ['light', 'dark', 'mid'];
    const wantLight = dirs.includes('light');
    const wantDark = dirs.includes('dark');
    /* ① 原色变体链：palRgbs 每个原色产 8 种变体全部进候选，
       方向对不对由评分系统决定（ROLE_MIN 硬线 + 可读性权重）。
       这样原色本身在端点（极亮/极深）时，变体仍能跨越到对端。 */
    (palRgbs || []).forEach((rgb, i) => {
      generateVariants(rgb, opts).forEach((v) => push(v.rgb, 'bg-src-' + v.key, i + ':source'));
      push(rgb, 'bg-src', i + ':source');
    });
    /* ② 旧方向推导保留为「对比补充色」——当原图颜色太单一/太靠近背景时兜底 */
    const bgHsl = rgbToHsl(bgRgb);
    const h = bgHsl.h;
    const sL = bgHsl.s < 15 ? 14 : clamp(bgHsl.s * 0.9, 10, 46);
    const sD = bgHsl.s < 15 ? 24 : clamp(bgHsl.s * 1.1, 22, 62);
    const sM = clamp(bgHsl.s, 18, 45);
    const fams = [
      ['bg', h], ['analogous', hueShift(h, 30)], ['analogous2', hueShift(h, -30)],
      ['complement', hueShift(h, 180)], ['split', hueShift(h, 150)], ['split2', hueShift(h, 210)],
    ];
    for (const [kind, fh] of fams) {
      if (wantLight) push(hslToRgb(fh, sL, 94), kind, 'derived');
      if (wantDark)  push(hslToRgb(fh, sD, 20), kind, 'derived');
    }
    if (dirs.includes('mid')) {
      for (const [kind, fh] of fams.slice(0, 4)) push(hslToRgb(fh, sM, 60), kind + '-mid', 'derived');
    }
    if (wantLight) { push(hslToRgb(h, 8, 96), 'neutral', 'derived'); push(hslToRgb(h, 14, 90), 'neutral', 'derived'); }
    if (wantDark)  { push(hslToRgb(h, 12, 14), 'neutral', 'derived'); push(hslToRgb(h, 18, 24), 'neutral', 'derived'); }
    const accH = hueShift(h, bgHsl.s < 35 ? 165 : 180);
    if (wantLight) push(hslToRgb(accH, 58, 86), 'accent', 'derived');
    if (wantDark)  push(hslToRgb(accH, 55, 30), 'accent', 'derived');
    return out;
  }

  /* ---------- 评分 ----------
     维度：可读性（最不利对比，最高优先）× 与背景协调 × 观感舒适 × 与已选色的区分度；
     权重按文字角色调整：正文重可读，艺术角色重协调。 */
  const ROLE_W = {
    '正文': { read: 0.60, harmony: 0.16, comfort: 0.14, distinct: 0.10 },
    '辅助信息': { read: 0.55, harmony: 0.24, comfort: 0.13, distinct: 0.08 },
    '主标题': { read: 0.42, harmony: 0.28, comfort: 0.16, distinct: 0.14 },
    '副标题': { read: 0.50, harmony: 0.26, comfort: 0.14, distinct: 0.10 },
    '强调': { read: 0.28, harmony: 0.30, comfort: 0.16, distinct: 0.26 },
    '装饰': { read: 0.12, harmony: 0.40, comfort: 0.22, distinct: 0.26 },
  };
  const ROLE_MIN = { '正文': 5.5, '辅助信息': 5.0, '主标题': 4.0, '副标题': 4.0, '强调': 3.0, '装饰': 2.0 };
  const ROLE_PREFER = {
    '正文': ['neutral', 'bg'], '辅助信息': ['neutral', 'bg'],
    '主标题': ['bg', 'analogous', 'neutral'], '副标题': ['bg', 'analogous', 'neutral'],
    '强调': ['accent', 'complement', 'split'], '装饰': ['accent', 'bg-src', 'split', 'complement'],
  };
  const DISTINCT_SQ = 0.07 * 0.07; // 已选色之间的最小 OKLab 距离（平方）

  function scoreCand(c, region, usedRgbs, use) {
    const ev = evaluateOnRegion(c.rgb, region);
    const read = Math.min(1, ev.worst / 8);
    const bgH = rgbToHsl(region.meanRgb).h;
    const hd = Math.abs(((c.hsl.h - bgH) % 360 + 540) % 360 - 180);
    const harmony = 1 - hd / 180;
    const comfort = 1 - Math.max(0, c.hsl.s - 62) / 38;
    let distinct = 1;
    for (const u of usedRgbs) distinct = Math.min(distinct, Math.min(1, distLab(c.rgb, u) / DISTINCT_SQ));
    const w = ROLE_W[use];
    const short = ev.worst < ROLE_MIN[use];
    const readAdj = short ? read * 0.3 : read;
    let score = readAdj * w.read + harmony * w.harmony + comfort * w.comfort + distinct * w.distinct;
    /* 来源奖励：原色变体（source 以数字开头）比方向推导色更受偏好，
       符合「从原图取色 → 保留色相特征 → 增强」的用户核心需求 */
    if (c.source && /^\d+/.test(c.source)) score += 0.18;
    else if (c.source === 'derived') score -= 0.06;
    /* 角色偏好：跨原色变体加分；neutral 色仅兜底 */
    if (c.kind && c.kind.startsWith('bg-src')) score += 0.08;
    if (ROLE_PREFER[use] && ROLE_PREFER[use].includes(c.kind)) score += 0.08;
    return { ev, score, short };
  }

  /* ---------- 推荐理由 ---------- */
  function reasonOf(rgb, kind, ev, region) {
    const hsl = rgbToHsl(rgb);
    const bhn = hueName(rgbToHsl(region.meanRgb).h);
    const hn = hueName(hsl.h);
    const avg = ev.avg.toFixed(1), worst = ev.worst.toFixed(1);
    let s;
    switch (kind) {
      case 'bg': s = '延续画面' + bhn + '色系，' + (hsl.l >= 55 ? '提亮' : '压深') + '后与文字区域平均对比 ' + avg + ':1'; break;
      case 'bg-src': s = '取自画面本身，再按文字区域校准明度，平均对比 ' + avg + ':1'; break;
      case 'neutral': s = '带' + bhn + '倾向的中性色，不与画面争色，最不利处对比 ' + worst + ':1'; break;
      case 'complement': s = '画面' + bhn + '的互补' + hn + '，色相差异拉开层次，平均对比 ' + avg + ':1'; break;
      case 'split': case 'split2': s = '分裂互补的' + hn + '，比互补更柔和，平均对比 ' + avg + ':1'; break;
      case 'analogous': case 'analogous2': s = '邻近' + hn + '与画面同调，平均对比 ' + avg + ':1'; break;
      case 'accent': s = '低饱和背景下的表现色，适合点缀，最不利处对比 ' + worst + ':1'; break;
      case 'art-white': s = hn + '染色白，站在画面明度的上限，平均对比 ' + avg + ':1'; break;
      case 'art-deep': s = '同色系深调，压住画面重心，平均对比 ' + avg + ':1'; break;
      case 'art-mid': s = '中间调过渡色，适合大号短句，平均对比 ' + avg + ':1'; break;
      case 'art-glow': s = '氛围点缀色，适合装饰性文字，最不利处对比 ' + worst + ':1'; break;
      default: s = '平均对比 ' + avg + ':1';
    }
    if (region.isComplex && ev.worst < 4.5) s += '；区域明暗跨度大，建议加底衬或描边';
    else if (ev.avg - ev.worst > 1.5) s += '；最不利处 ' + worst + ':1，小字号慎用';
    return s;
  }

  /* ---------- 颜色条目 ---------- */
  function colorEntry(rgb, kind, ev, region) {
    const hsl = rgbToHsl(rgb);
    const st = contrastStatus(ev.worst);
    return {
      hex: rgbToHex(rgb), rgb: rgb.map(Math.round), hsl: { h: Math.round(hsl.h), s: Math.round(hsl.s), l: Math.round(hsl.l) },
      okL: Math.round(rgbToOklab(rgb)[0] * 100), sat: Math.round(hsl.s),
      kind,
      avgC: Math.round(ev.avg * 10) / 10, worstC: Math.round(ev.worst * 10) / 10,
      status: st.label, statusKey: st.key, statusCls: st.cls,
      safe: ev.worst >= 4.5,
      use: '', reason: '',
    };
  }
  function finalizeScheme(scheme, region) {
    scheme.colors.forEach((c) => {
      c.reason = reasonOf(c.rgb, c.kind, { avg: c.avgC, worst: c.worstC }, region);
    });
    return scheme;
  }
  const schemeBase = (id, name, tag, desc) => ({ id, name, tag, desc, colors: [] });

  /* 已选色去重 */
  const isUsed = (used, rgb) => used.some((u) => distLab(u, rgb) < DISTINCT_SQ);

  /* 方案一：背景协调色 —— 画面取色 → 整组调和到区域可读 */
  function schemeHarmony(paletteEntries, region, bgType, enhanceOpts) {
    const tag = bgType && bgType.label ? (bgType.label + ' · 克制协调') : '与画面同一气质';
    const desc = '从画面主色与辅助色出发，保持色相与冷暖关系，只把明度与饱和调到「能被读到」的区间。';
    const s = schemeBase('harmony', '背景协调色', tag, desc);
    const rgbs = [];
    const add = (rgb) => { if (rgb && rgb.length === 3 && !isUsed(rgbs, rgb)) rgbs.push(rgb); };
    paletteEntries.slice(0, 8).forEach((e) => add(e.rgb));
    /* 画面取色不足 5 个时，从主色派生变体补足成套（受 satMax 约束） */
    for (const e of paletteEntries.slice(0, 3)) {
      if (rgbs.length >= 8) break;
      const { h, s: ss, l } = rgbToHsl(e.rgb);
      const sat = Math.min(ss, (enhanceOpts && enhanceOpts.satMax) || 100);
      add(hslToRgb(h, sat, clamp(l + 22, 8, 92)));
      add(hslToRgb(h, sat, clamp(l - 24, 8, 92)));
      add(hslToRgb((h + 30) % 360, sat, l));
      add(hslToRgb((h + 180) % 360, sat, l));
    }
    const finals = harmonizePalette(rgbs.slice(0, 8), region.meanRgb, 4.5);
    const kinds = ['bg', 'bg-src', 'analogous', 'complement', 'bg', 'analogous2', 'split', 'bg'];
    s.colors = finals.map((rgb, i) => {
      const ev = evaluateOnRegion(rgb, region);
      const c = colorEntry(rgb, kinds[i] || 'bg', ev, region);
      if (bgType && bgType.mode === 'B') c.kind = 'design';
      c.use = '';
      return c;
    });
    assignRoles(s.colors);
    return finalizeScheme(s, region);
  }

  /* 方案二：高对比文字色 —— 六个角色成套，逐级拉开层次 */
  function schemeRoles(paletteEntries, region, bgType, enhanceOpts) {
    const tag = bgType && bgType.label ? (bgType.label + ' · 清晰专业') : '标题到正文的成套系统';
    const desc = '按主标题 → 副标题 → 正文 → 辅助信息成套设计：同一色系、逐级拉开明度层次，强调与装饰负责点睛。';
    const s = schemeBase('roles', '高对比文字色', tag, desc);
    const bgRgb = region.meanRgb;
    const cands = pickCandidates(bgRgb, region, paletteEntries.slice(0, 4).map((e) => e.rgb), enhanceOpts);
    const used = [];
    const order = ['正文', '辅助信息', '主标题', '副标题', '强调', '装饰'];
    for (const use of order) {
      let best = null;
      for (const c of cands) {
        if (isUsed(used, c.rgb)) continue;
        const sc = scoreCand(c, region, used, use);
        if (sc.ev.worst < ROLE_MIN[use]) continue;
        if (!best || sc.score > best.sc.score) best = { c, sc };
      }
      if (!best) { // 放宽硬线：取对区域平均对比最高者（极端背景无纯色可达标时最实用）
        let bestAvg = -1;
        for (const c of cands) {
          if (isUsed(used, c.rgb)) continue;
          const ev = evaluateOnRegion(c.rgb, region);
          if (ev.avg > bestAvg) { bestAvg = ev.avg; best = { c, sc: { ev, score: 0, short: true } }; }
        }
      }
      if (!best) break;
      used.push(best.c.rgb);
      const c = colorEntry(best.c.rgb, best.c.kind, best.sc.ev, region);
      c.use = use;
      s.colors.push(c);
    }
    return finalizeScheme(s, region);
  }

  /* 方案三：氛围艺术色 —— 由背景冷暖推导的艺术化用色 */
  function schemeArt(paletteEntries, region, global) {
    const s = schemeBase('art', '氛围艺术色', '海报 · 封面 · 艺术排版',
      '面向大标题、短句与艺术化排版的用色：染色白、暖金、冰调与深调都由背景冷暖推导，逐一通过对比度检测。');
    const bgRgb = region.meanRgb;
    const h0 = rgbToHsl(bgRgb).h;
    const warm = global ? global.warmCool : 0;
    const recipes = [
      ['art-white', h0, 12, 95],
      ['art-deep', h0, 34, 20],
      ['art-mid', hueShift(h0, warm >= 0 ? 30 : -30), clamp(rgbToHsl(bgRgb).s + 8, 20, 42), 58],
      ['art-glow', hueShift(h0, warm >= 0 ? 25 : 160), 55, warm >= 0 ? 66 : 58],
      ['art-white', hueShift(h0, warm >= 0 ? 160 : -20), 26, 80],
      ['art-mid', hueShift(h0, 210), 30, 44],
      ['art-glow', hueShift(h0, 90), 44, 50],
    ];
    const used = [];
    for (const [kind, h, ss, l] of recipes) {
      const rgb = hslToRgb(h, ss, l).map((v) => clamp(Math.round(v), 0, 255));
      if (isUsed(used, rgb)) continue;
      used.push(rgb);
      const ev = evaluateOnRegion(rgb, region);
      const c = colorEntry(rgb, kind, ev, region);
      c.use = '';
      s.colors.push(c);
    }
    if (s.colors.length < 5 && paletteEntries.length) { // 极端背景补画面原色
      for (const e of paletteEntries.slice(0, 3)) {
        if (s.colors.length >= 7) break;
        if (isUsed(used, e.rgb)) continue;
        used.push(e.rgb);
        const ev = evaluateOnRegion(e.rgb, region);
        s.colors.push(colorEntry(e.rgb, 'bg-src', ev, region));
      }
    }
    assignRoles(s.colors);
    return finalizeScheme(s, region);
  }

  /* 角色分配（方案一/三）：正文与辅助优先最稳的，强调给最鲜艳的，装饰给最艺术的 */
  function assignRoles(colors) {
    const order = ['正文', '辅助信息', '主标题', '副标题', '强调', '装饰'];
    const used = new Set();
    for (const use of order) {
      let best = -1, bestScore = -Infinity;
      for (let i = 0; i < colors.length; i++) {
        if (used.has(i)) continue;
        const c = colors[i];
        const min = ROLE_MIN[use];
        const read = Math.min(1, c.worstC / 6);
        const comfort = 1 - Math.max(0, c.sat - 62) / 38;
        let sc = read * ROLE_W[use].read + comfort * ROLE_W[use].comfort;
        if (c.worstC >= min) sc += 0.4;
        if (use === '强调') sc += c.sat / 100;
        if (use === '正文' || use === '辅助信息') sc += (1 - Math.min(1, c.sat / 70)) * 0.25;
        if (use === '装饰') sc -= Math.min(1, c.worstC / 6) * 0.2; // 装饰允许更艺术
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best >= 0) { colors[best].use = use; used.add(best); }
    }
  }

  /* ---------- 背景风格识别与自适应配色 ---------- */

  /* classifyBg：根据调色板与全图分析判断背景类型
     返回 { type, label, mode: 'A'|'B', satStrategy, hint } */
  function classifyBg(paletteEntries, global) {
    if (!global) return { type: 'normal', label: '通用背景', mode: 'A', satStrategy: 'standard', hint: '' };

    const meanLum = relLum(global.meanRgb);
    const complexity = global.complexity || 0;

    /* 调色板饱和度与 OKLCH 色度统计 */
    let satSum = 0, chromaSum = 0, maxChroma = 0, count = 0;
    for (const e of (paletteEntries || [])) {
      const hsl = rgbToHsl(e.rgb);
      satSum += hsl.s;
      const [, c] = oklabToOklch(rgbToOklab(e.rgb));
      chromaSum += c;
      if (c > maxChroma) maxChroma = c;
      count++;
    }
    const satMean = count ? satSum / count : 0;
    const avgChroma = count ? chromaSum / count : 0;

    /* 纯白背景：大面积近白、几乎无彩色像素 */
    if (meanLum > 0.88 && satMean < 8 && avgChroma < 0.02) {
      return { type: 'pure-white', label: '纯白背景 · 主动设计模式', mode: 'B', satStrategy: 'design', hint: '原图几乎无彩色，进入主动设计模式' };
    }
    /* 纯黑背景：大面积近黑、几乎无彩色像素 */
    if (meanLum < 0.08 && satMean < 8 && avgChroma < 0.02) {
      return { type: 'pure-black', label: '纯黑背景 · 主动设计模式', mode: 'B', satStrategy: 'design', hint: '原图几乎无彩色，进入主动设计模式' };
    }
    /* 极浅低饱和 */
    if (meanLum > 0.65 && satMean < 25) {
      return { type: 'very-light-low-sat', label: '极浅低饱和背景', mode: 'A', satStrategy: 'low-to-mid', hint: '保持克制，生成低至中等饱和度配色' };
    }
    /* 深色低饱和 */
    if (meanLum < 0.18 && satMean < 25) {
      return { type: 'dark-low-sat', label: '深色低饱和背景', mode: 'A', satStrategy: 'low-to-mid', hint: '保持克制，生成低至中等饱和度配色' };
    }
    /* 低饱和摄影 / 柔和插画 */
    if (satMean < 30 && complexity > 0.12) {
      return { type: 'low-sat-photo', label: '低饱和度摄影 / 柔和插画', mode: 'A', satStrategy: 'preserve', hint: '保留原图气质，适度提亮不增艳' };
    }
    /* 高饱和度、色彩丰富 */
    if (satMean > 50 || maxChroma > 0.18) {
      return { type: 'high-sat', label: '高饱和度背景', mode: 'A', satStrategy: 'reduce', hint: '降低候选色度，优先中性色平衡' };
    }
    return { type: 'normal', label: '通用背景', mode: 'A', satStrategy: 'standard', hint: '' };
  }

  /* adaptiveEnhanceParams：根据背景类型返回增强幅度缩放与饱和度上限 */
  function adaptiveEnhanceParams(bgType) {
    const map = {
      'pure-white':         { dLScale: 1.0, dCScale: 0.35, satMax: 38 },
      'pure-black':         { dLScale: 1.0, dCScale: 0.35, satMax: 38 },
      'very-light-low-sat': { dLScale: 1.0, dCScale: 0.55, satMax: 48 },
      'dark-low-sat':       { dLScale: 1.0, dCScale: 0.55, satMax: 48 },
      'low-sat-photo':      { dLScale: 1.0, dCScale: 0.70, satMax: 55 },
      'high-sat':           { dLScale: 0.9, dCScale: 0.40, satMax: 52 },
      'normal':             { dLScale: 1.0, dCScale: 1.00, satMax: 72 },
    };
    return map[bgType] || map['normal'];
  }

  /* DESIGN_PALETTES：纯白/纯黑背景的预定义专业配色关系（source='design'） */
  const DESIGN_PALETTES = {
    'pure-white': [
      [42, 55, 71, '主标题', '深灰蓝'],
      [90, 105, 125, '副标题', '雾蓝'],
      [55, 68, 82, '正文', '深青灰'],
      [120, 130, 145, '辅助信息', '银灰蓝'],
      [130, 70, 55, '强调', '柔和砖红'],
      [100, 115, 85, '次级强调', '鼠尾草绿'],
      [210, 215, 225, '背景辅助', '浅雾灰'],
    ],
    'pure-black': [
      [232, 230, 222, '主标题', '暖白'],
      [200, 205, 215, '副标题', '银灰'],
      [218, 216, 210, '正文', '柔白'],
      [160, 170, 185, '辅助信息', '冰蓝灰'],
      [180, 155, 90, '强调', '暖金'],
      [140, 180, 175, '次级强调', '低饱和薄荷'],
      [50, 56, 68, '背景辅助', '深炭灰'],
    ],
  };

  /* designPalette：为纯白/纯黑背景生成设计补色条目 */
  function designPalette(bgType) {
    const defs = DESIGN_PALETTES[bgType];
    if (!defs) return [];
    return defs.map(([r, g, b, role, name]) => {
      const rgb = [r, g, b];
      return { rgb, hex: rgbToHex(rgb), hsl: rgbToHsl(rgb), kind: 'design', source: 'design', use: role, name };
    });
  }

  /* ---------- 总入口：三套方案 ---------- */
  function buildSchemes(paletteEntries, region, global, opts) {
    opts = opts || {};
    const bgType = opts.bgType || classifyBg(paletteEntries, global);
    const params = adaptiveEnhanceParams(bgType.type);
    const enhanceOpts = { dLScale: params.dLScale, dCScale: params.dCScale, satMax: params.satMax };

    /* 模式 B：主动设计 —— 用设计补色替代原色 */
    let effectivePalette = paletteEntries;
    if (bgType.mode === 'B') {
      const designColors = designPalette(bgType.type);
      if (designColors.length) effectivePalette = designColors;
    }

    return [
      schemeHarmony(effectivePalette, region, bgType, enhanceOpts),
      schemeRoles(effectivePalette, region, bgType, enhanceOpts),
      schemeArt(effectivePalette, region, global, bgType, enhanceOpts),
    ];
  }

  return {
    clamp, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToHsv,
    relLum, contrast, levelOf, nameOf, hueName, hueShift,
    srgbToLinear, linearToSrgb, rgbToOklab, oklabToRgb, distLab,
    /* OKLCH 连续增强层（新增） */
    oklabToOklch, oklchToOklab, gamutMap, enhanceColor, enhancementDegree, generateVariants,
    medianCutLab, kmeansLab, mergeClose, adaptForContrast, harmonizePalette,
    analyzeRegion, scrimComposite, evaluateOnRegion, contrastStatus,
    pickCandidates, scoreCand, reasonOf, buildSchemes,
  };
});
