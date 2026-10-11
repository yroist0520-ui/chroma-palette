/* =========================================================
   CHROMA · 色彩算法核心（与 UI / DOM 无关的纯函数）
   ---------------------------------------------------------
   · RGB / HEX / HSL 互转          · WCAG 亮度 / 对比度 / 等级
   · sRGB ↔ OKLab（感知均匀空间）   · 取色：中位切分 + K-means + 近似色合并
   · 可读性适配：保色相、调明度
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

  /* 盒内感知跨度最大的通道：明度天然占主导，色度加权以保留色彩层次 */
  const CH_W = [1, 1.6, 1.6];
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
    let l = 0, a = 0, b = 0;
    for (let i = 0; i < box.length; i++) { l += box[i][0]; a += box[i][1]; b += box[i][2]; }
    const n = box.length;
    return [l / n, a / n, b / n];
  }
  /* K-means（Lloyd）：以中位切分结果作初值，在 OKLab 中迭代，质心即画面真实主色 */
  function kmeansLab(pixels, k, iters) {
    const init = medianCutLab(pixels, k).map(meanLab).filter(Boolean);
    if (!init.length) return [];
    let centroids = init;
    const assign = new Int32Array(pixels.length).fill(-1);
    for (let it = 0; it < (iters || 8); it++) {
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
        const p = pixels[i], s = sum[assign[i]];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
      }
      for (let c = 0; c < centroids.length; c++) {
        if (sum[c][3]) centroids[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
      }
      if (!changed) break;
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
  /* 保色相、调明度：在可达标的明度里选最接近原明度的那一档 */
  function adaptForContrast(rgb, bgRgb, target) {
    const t = target || 4.5;
    const hsl = rgbToHsl(rgb);
    let bestRgb = rgb, bestDist = Infinity, found = false;
    for (let l = 2; l <= 98; l += 2) {
      const cand = hslToRgb(hsl.h, hsl.s, l);
      if (contrast(cand, bgRgb) >= t) {
        const dist = Math.abs(l - hsl.l);
        if (dist < bestDist) { bestDist = dist; bestRgb = cand; found = true; }
      }
    }
    if (!found) { // 无法达标时取对比度最大的明度
      let maxRatio = -1;
      for (let l = 0; l <= 100; l += 2) {
        const cand = hslToRgb(hsl.h, hsl.s, l);
        const ratio = contrast(cand, bgRgb);
        if (ratio > maxRatio) { maxRatio = ratio; bestRgb = cand; }
      }
    }
    return bestRgb;
  }

  return {
    clamp, hexToRgb, rgbToHex, rgbToHsl, hslToRgb,
    relLum, contrast, levelOf, nameOf,
    srgbToLinear, linearToSrgb, rgbToOklab, oklabToRgb, distLab,
    medianCutLab, kmeansLab, mergeClose, adaptForContrast,
  };
});
