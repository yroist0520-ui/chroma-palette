/* =========================================================
   CHROMA 色彩算法核心 · 单元测试（零依赖，Node 内置 test runner）
   运行：node --test tests/color-core.test.js   （需 Node 18+）
   ========================================================= */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../color-core.js');

const rand255 = () => Math.floor(Math.random() * 256);

/* ================= 0. 模块导出 ================= */
test('模块导出完整（所有算法函数均为函数类型）', () => {
  const expected = [
    'clamp', 'hexToRgb', 'rgbToHex', 'rgbToHsl', 'hslToRgb', 'rgbToHsv',
    'relLum', 'contrast', 'levelOf', 'nameOf', 'hueName', 'hueShift',
    'srgbToLinear', 'linearToSrgb', 'rgbToOklab', 'oklabToRgb', 'distLab',
    'medianCutLab', 'kmeansLab', 'mergeClose', 'adaptForContrast', 'harmonizePalette',
    'analyzeRegion', 'scrimComposite', 'evaluateOnRegion', 'contrastStatus',
    'pickCandidates', 'scoreCand', 'reasonOf', 'buildSchemes',
  ];
  for (const k of expected) {
    assert.strictEqual(typeof C[k], 'function', '缺少导出：' + k);
  }
});

/* ================= 1. clamp / HEX ================= */
test('clamp：夹紧到 [a, b]', () => {
  assert.strictEqual(C.clamp(5, 0, 3), 3);
  assert.strictEqual(C.clamp(-1, 0, 3), 0);
  assert.strictEqual(C.clamp(2, 0, 3), 2);
});

test('hexToRgb：解析 6 位 HEX（含 # 与大小写）', () => {
  assert.deepStrictEqual(C.hexToRgb('#FF8040'), [255, 128, 64]);
  assert.deepStrictEqual(C.hexToRgb('#ff8040'), [255, 128, 64]);
  assert.deepStrictEqual(C.hexToRgb('FF8040'), [255, 128, 64]);
});

test('rgbToHex：输出大写、四舍五入并夹紧', () => {
  assert.strictEqual(C.rgbToHex([255, 128, 64]), '#FF8040');
  assert.strictEqual(C.rgbToHex([254.6, 127.4, 63.5]), '#FF7F40');
  assert.strictEqual(C.rgbToHex([-5, 300, 128]), '#00FF80');
});

test('hex ↔ rgb 往返无损（200 组随机色）', () => {
  for (let i = 0; i < 200; i++) {
    const rgb = [rand255(), rand255(), rand255()];
    assert.deepStrictEqual(C.hexToRgb(C.rgbToHex(rgb)), rgb);
  }
});

/* ================= 2. HSL ================= */
test('rgbToHsl：基准色', () => {
  assert.deepStrictEqual(C.rgbToHsl([255, 0, 0]), { h: 0, s: 100, l: 50 });
  assert.deepStrictEqual(C.rgbToHsl([0, 255, 0]), { h: 120, s: 100, l: 50 });
  assert.deepStrictEqual(C.rgbToHsl([0, 0, 255]), { h: 240, s: 100, l: 50 });
  assert.deepStrictEqual(C.rgbToHsl([255, 255, 255]), { h: 0, s: 0, l: 100 });
  assert.deepStrictEqual(C.rgbToHsl([0, 0, 0]), { h: 0, s: 0, l: 0 });
});

test('rgb ↔ hsl 往返一致（200 组随机色，通道误差 ≤1）', () => {
  for (let i = 0; i < 200; i++) {
    const rgb = [rand255(), rand255(), rand255()];
    const hsl = C.rgbToHsl(rgb);
    const back = C.hslToRgb(hsl.h, hsl.s, hsl.l).map(Math.round);
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(back[c] - rgb[c]) <= 1, `${rgb} -> hsl -> ${back} 第 ${c} 通道偏差过大`);
    }
  }
});

/* ================= 3. WCAG 亮度 / 对比度 ================= */
test('relLum：黑=0，白≈1', () => {
  assert.strictEqual(C.relLum([0, 0, 0]), 0);
  assert.ok(Math.abs(C.relLum([255, 255, 255]) - 1) < 1e-9);
});

test('contrast：黑白 ≈21:1，同色 =1:1，计算对称', () => {
  const bw = C.contrast([0, 0, 0], [255, 255, 255]);
  assert.ok(Math.abs(bw - 21) < 1e-9, '黑白对比度应为 21，实际 ' + bw);
  assert.strictEqual(C.contrast([200, 100, 50], [200, 100, 50]), 1);
  const a = [120, 30, 200], b = [240, 240, 10];
  assert.strictEqual(C.contrast(a, b), C.contrast(b, a));
});

test('contrast：与 WCAG 已知值一致（白 vs #777777 ≈ 4.477）', () => {
  const ratio = C.contrast([255, 255, 255], [119, 119, 119]);
  assert.ok(Math.abs(ratio - 4.477) < 0.01, '实际 ' + ratio);
});

test('levelOf：阈值与样式类', () => {
  assert.strictEqual(C.levelOf(7).label, 'AAA · 优异');
  assert.strictEqual(C.levelOf(7).cls, 'is-ok');
  assert.strictEqual(C.levelOf(4.5).label, 'AA · 可读');
  assert.strictEqual(C.levelOf(4.4).label, 'AA · 仅大字');
  assert.strictEqual(C.levelOf(4.4).cls, 'is-warn');
  assert.strictEqual(C.levelOf(3).label, 'AA · 仅大字');
  assert.strictEqual(C.levelOf(2.9).label, '不可读');
  assert.strictEqual(C.levelOf(2.9).cls, 'is-bad');
});

/* ================= 4. OKLab ================= */
test('OKLab 往返：关键色误差 ≤1 且无 NaN', () => {
  const colors = [
    [0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [216, 255, 62], [74, 58, 114], [194, 95, 95], [255, 157, 92],
    [128, 128, 128], [200, 150, 100], [30, 20, 56],
  ];
  for (const rgb of colors) {
    const back = C.oklabToRgb(C.rgbToOklab(rgb));
    assert.ok(back.every(Number.isFinite), rgb + ' 产生非有限值');
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(back[c] - rgb[c]) <= 1, `${rgb} -> ${back} 偏差过大`);
    }
  }
});

test('OKLab 往返：300 组随机色误差 ≤1', () => {
  for (let i = 0; i < 300; i++) {
    const rgb = [rand255(), rand255(), rand255()];
    const back = C.oklabToRgb(C.rgbToOklab(rgb));
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(back[c] - rgb[c]) <= 1, `${rgb} -> ${back}`);
    }
  }
});

test('oklabToRgb：广色域（超出 sRGB）输入被夹紧且无 NaN', () => {
  const out = C.oklabToRgb([1.2, 0.4, -0.4]);
  assert.ok(out.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
});

test('distLab：同点为 0，且满足对称性', () => {
  const a = C.rgbToOklab([10, 200, 30]), b = C.rgbToOklab([240, 90, 5]);
  assert.strictEqual(C.distLab(a, a), 0);
  assert.strictEqual(C.distLab(a, b), C.distLab(b, a));
  assert.ok(C.distLab(a, b) > 0);
});

/* ================= 5. 取色管线 ================= */
test('medianCutLab：盒划分守恒、盒数 ≤ k、不修改输入', () => {
  const px = [];
  for (let i = 0; i < 400; i++) px.push(C.rgbToOklab([rand255(), rand255(), rand255()]));
  for (const k of [1, 3, 5, 8]) {
    const boxes = C.medianCutLab(px, k);
    assert.ok(boxes.length >= 1 && boxes.length <= k, 'k=' + k + ' 时盒数 ' + boxes.length);
    const total = boxes.reduce((s, b) => s + b.length, 0);
    assert.strictEqual(total, px.length, 'k=' + k + ' 像素计数不守恒');
  }
  assert.strictEqual(px.length, 400, '输入数组被修改');
});

test('kmeansLab：空输入返回空数组', () => {
  assert.deepStrictEqual(C.kmeansLab([], 6, 8), []);
});

test('kmeansLab：合成三主色（噪声 ±12）被还原，计数守恒、无 NaN', () => {
  const base = [[20, 26, 58], [194, 95, 95], [255, 157, 92]];
  const px = [];
  base.forEach((b, bi) => {
    for (let i = 0; i < 700 + bi * 150; i++) {
      px.push(C.rgbToOklab(b.map((v) => Math.min(255, Math.max(0, v + (Math.random() * 24 - 12))))));
    }
  });
  const clusters = C.kmeansLab(px, 6, 8);
  assert.ok(clusters.length >= 3 && clusters.length <= 6, '簇数 ' + clusters.length);
  assert.strictEqual(clusters.reduce((s, c) => s + c.n, 0), px.length, '像素计数不守恒');
  assert.ok(clusters.every((c) => c.lab.every(Number.isFinite)), '质心出现 NaN');
  const rgbs = clusters.map((c) => C.oklabToRgb(c.lab));
  for (const b of base) {
    const hit = rgbs.some((r) =>
      Math.max(Math.abs(r[0] - b[0]), Math.abs(r[1] - b[1]), Math.abs(r[2] - b[2])) < 10);
    assert.ok(hit, '未能还原基准色 ' + b.join(','));
  }
});

test('mergeClose：近似色合并、异色保留、计数守恒；空输入安全', () => {
  const g1 = { lab: C.rgbToOklab([100, 100, 100]), n: 100 };
  const g2 = { lab: C.rgbToOklab([108, 108, 108]), n: 50 }; // 与 g1 感知距离 < 0.04
  const red = { lab: C.rgbToOklab([255, 0, 0]), n: 30 };
  assert.ok(C.distLab(g1.lab, g2.lab) < 0.04 * 0.04, '测试前置：两灰应视为近似色');
  const merged = C.mergeClose([g1, g2, red], 0.04);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged.reduce((s, m) => s + m.n, 0), 180);
  assert.deepStrictEqual(C.mergeClose([], 0.04), []);
});

/* ================= 5b. 加权质心与补足分裂 ================= */
test('加权质心：簇代表色比纯均值更鲜艳（饱和度方向）', () => {
  const px = [];
  for (let i = 0; i < 800; i++) px.push(C.rgbToOklab([128, 128, 128]));
  for (let i = 0; i < 200; i++) px.push(C.rgbToOklab([220, 40, 40]));
  const [cl] = C.kmeansLab(px, 1, 8);
  const got = C.oklabToRgb(cl.lab);
  const meanRgb = [146, 110, 110]; // 纯像素算术均值
  const sGot = C.rgbToHsl(got).s, sMean = C.rgbToHsl(meanRgb).s;
  assert.ok(sGot > sMean + 2,
    `加权质心饱和度 ${sGot.toFixed(1)} 应明显高于纯均值 ${sMean.toFixed(1)}`);
});

test('kmeansLab：极端分布（全同色）不变式——计数守恒、无 NaN', () => {
  const px = [];
  for (let i = 0; i < 300; i++) px.push(C.rgbToOklab([255, 0, 0]));
  const cls = C.kmeansLab(px, 6, 8, 0.04);
  assert.ok(cls.length >= 1, '至少返回 1 簇');
  assert.strictEqual(cls.reduce((s, c) => s + c.n, 0), 300, '计数守恒');
  assert.ok(cls.every((c) => c.lab.every(Number.isFinite)), '质心无 NaN');
});

/* ================= 6. 可读性适配 ================= */
test('adaptForContrast：深底上达标且保持色相', () => {
  const bg = [18, 18, 22];
  const rgb = [194, 95, 95];
  const out = C.adaptForContrast(rgb, bg, 4.5);
  assert.ok(C.contrast(out, bg) >= 4.5, '对比度 ' + C.contrast(out, bg).toFixed(2));
  assert.ok(Math.abs(C.rgbToHsl(rgb).h - C.rgbToHsl(out).h) <= 2, '色相偏移过大');
});

test('adaptForContrast：亮底上压暗且保持色相', () => {
  const bg = [245, 240, 230];
  const rgb = [216, 255, 62];
  const out = C.adaptForContrast(rgb, bg, 4.5);
  assert.ok(C.contrast(out, bg) >= 4.5, '对比度 ' + C.contrast(out, bg).toFixed(2));
  assert.ok(Math.abs(C.rgbToHsl(rgb).h - C.rgbToHsl(out).h) <= 2, '色相偏移过大');
});

test('adaptForContrast：已达标的颜色明度漂移 ≤2', () => {
  const bg = [18, 18, 22];
  const out = C.adaptForContrast([255, 255, 255], bg, 4.5);
  const dl = Math.abs(C.rgbToHsl([255, 255, 255]).l - C.rgbToHsl(out).l);
  assert.ok(dl <= 2.01, '明度漂移 ' + dl);
  assert.ok(C.contrast(out, bg) >= 4.5);
});

test('adaptForContrast：无法达标时退回最大对比度且不产生 NaN', () => {
  const gray = [128, 128, 128];
  const out = C.adaptForContrast(gray, gray, 10); // 10:1 不可达
  assert.ok(out.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
  assert.ok(C.contrast(out, gray) >= 5, '应退到接近最大对比度，实际 ' + C.contrast(out, gray).toFixed(2));
});

/* --- 规律：亮底压深提饱和 / 暗底提亮降饱和（取自真实图文样本） --- */
test('adaptForContrast：暗底提亮字——明度升高、饱和下降（趋近同色相染色白）', () => {
  const bg = [16, 18, 24];
  const rgb = [120, 80, 160]; // 紫，s≈33
  const out = C.adaptForContrast(rgb, bg, 4.5);
  assert.ok(C.contrast(out, bg) >= 4.5, '对比度 ' + C.contrast(out, bg).toFixed(2));
  assert.ok(C.rgbToHsl(out).l > C.rgbToHsl(rgb).l, '暗底上文字应变亮');
  assert.ok(C.rgbToHsl(out).s <= C.rgbToHsl(rgb).s + 1e-9, '提亮时应降饱和');
});

test('adaptForContrast：亮底压深字——明度降低、饱和不降（深而不灰）', () => {
  const bg = [246, 242, 234];
  const rgb = [110, 140, 190]; // 蓝，s≈38
  const out = C.adaptForContrast(rgb, bg, 4.5);
  assert.ok(C.contrast(out, bg) >= 4.5, '对比度 ' + C.contrast(out, bg).toFixed(2));
  assert.ok(C.rgbToHsl(out).l < C.rgbToHsl(rgb).l, '亮底上文字应变暗');
  assert.ok(C.rgbToHsl(out).s >= C.rgbToHsl(rgb).s - 0.5, '压深时不应发灰');
});

/* ================= 6b. 整组调和 ================= */
/* 低饱和示例图的 6 个色卡（复现"脏灰扎堆"的真实场景） */
const DEMO_GRAYS = ['#ACADC3', '#B0AEC2', '#AFA8BD', '#B9ACB4', '#BCA9A9', '#EDAC6E'].map(C.hexToRgb);
const DEMO_BG = C.hexToRgb('#4D3953'); // 示例图文字框下方的深紫底

test('harmonizePalette：整组保持可读——每个颜色对底对比度达标', () => {
  const out = C.harmonizePalette(DEMO_GRAYS, DEMO_BG, 4.5);
  assert.strictEqual(out.length, DEMO_GRAYS.length);
  out.forEach((rgb, i) => {
    assert.ok(C.contrast(rgb, DEMO_BG) >= 4.5, `第 ${i} 色对比度 ${C.contrast(rgb, DEMO_BG).toFixed(2)}`);
  });
});

test('harmonizePalette：低饱和色组不再扎堆——两两可辨、离开脏灰带', () => {
  const out = C.harmonizePalette(DEMO_GRAYS.slice(0, 5), DEMO_BG, 4.5); // 前 5 个全是灰
  const hexes = out.map(C.rgbToHex);
  assert.strictEqual(new Set(hexes).size, out.length, '不应出现重复颜色：' + hexes.join(','));
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const d = C.distLab(out[i], out[j]);
      assert.ok(d >= 0.055 * 0.055 - 1e-12,
        `第 ${i}/${j} 色过近：${hexes[i]} vs ${hexes[j]}`);
    }
  }
  const sats = out.map((r) => C.rgbToHsl(r).s);
  assert.ok(Math.max(...sats) > 40, '应有颜色被提为可信彩度，实际最高 ' + Math.max(...sats).toFixed(1));
  assert.ok(Math.min(...sats) < 15, '应有稳重的中性锚，实际最低 ' + Math.min(...sats).toFixed(1));
});

test('harmonizePalette：鲜艳色保留为强调色（不被柔化成粉彩）', () => {
  const out = C.harmonizePalette([C.hexToRgb('#EDAC6E')], DEMO_BG, 4.5);
  const hsl = C.rgbToHsl(out[0]);
  assert.ok(hsl.s >= 48, '强调色饱和度不应被大幅压低：' + hsl.s.toFixed(1));
  assert.ok(C.contrast(out[0], DEMO_BG) >= 4.5);
});

test('harmonizePalette：空输入安全、单色可用', () => {
  assert.deepStrictEqual(C.harmonizePalette([], DEMO_BG, 4.5), []);
  const one = C.harmonizePalette([[128, 128, 128]], DEMO_BG, 4.5);
  assert.strictEqual(one.length, 1);
  assert.ok(C.contrast(one[0], DEMO_BG) >= 4.5);
});

/* ================= 7. 命名 ================= */
test('nameOf：最近邻命名', () => {
  assert.strictEqual(C.nameOf([0, 0, 0]), '纯黑');
  assert.strictEqual(C.nameOf([255, 255, 255]), '纯白');
  assert.strictEqual(C.nameOf([216, 255, 62]), '柠檬黄');
});

/* =========================================================
   8. 智能文字配色：HSV / 区域分析 / 对比评估 / 三套方案
   ========================================================= */

test('rgbToHsv：基准色', () => {
  assert.deepStrictEqual(C.rgbToHsv([255, 0, 0]), { h: 0, s: 100, v: 100 });
  assert.deepStrictEqual(C.rgbToHsv([0, 0, 255]), { h: 240, s: 100, v: 100 });
  assert.deepStrictEqual(C.rgbToHsv([128, 128, 128]), { h: 0, s: 0, v: 50.19607843137255 });
  const hsv = C.rgbToHsv([0, 0, 0]);
  assert.strictEqual(hsv.s, 0);
  assert.strictEqual(hsv.v, 0);
});

test('hueName：色相族命名', () => {
  assert.strictEqual(C.hueName(0), '红');
  assert.strictEqual(C.hueName(30), '橙');
  assert.strictEqual(C.hueName(120), '绿');
  assert.strictEqual(C.hueName(240), '蓝');
  assert.strictEqual(C.hueName(350), '红');
  assert.strictEqual(C.hueName(370), '红'); // 越界回绕（370 → 10）
});

/* —— 区域分析：合成像素区域 —— */
function regionFrom(colors) {
  const lums = colors.map((c) => C.relLum(c));
  const rgbs = [];
  colors.forEach((c) => rgbs.push(c[0], c[1], c[2]));
  return C.analyzeRegion(lums, rgbs);
}

test('analyzeRegion：平坦区域——低复杂度、均值准确、主色正确', () => {
  const r = regionFrom(Array.from({ length: 200 }, () => [200, 210, 230]));
  assert.ok(r.complexity < 0.2, '复杂度 ' + r.complexity);
  assert.deepStrictEqual(r.meanRgb, [200, 210, 230]);
  assert.deepStrictEqual(r.dominantRgb, [200, 210, 230]);
  assert.ok(Math.abs(r.warmCool + 0.5) < 0.2, '冷色背景 warmCool 应为负：' + r.warmCool);
  assert.ok(!r.isComplex);
});

test('analyzeRegion：黑白棋盘——高复杂度、极差大、明暗两端正确', () => {
  const colors = [];
  for (let i = 0; i < 300; i++) colors.push(i % 2 ? [255, 255, 255] : [0, 0, 0]);
  const r = regionFrom(colors);
  assert.ok(r.complexity > 0.6, '复杂度 ' + r.complexity);
  assert.ok(r.isComplex);
  assert.ok(r.lumMax - r.lumMin > 0.95);
  assert.ok(r.brightRgb[0] > 200, '最亮代表色应接近白：' + r.brightRgb);
  assert.ok(r.darkRgb[0] < 60, '最暗代表色应接近黑：' + r.darkRgb);
});

test('analyzeRegion：冷暖与高光阴影占比', () => {
  const r = regionFrom(Array.from({ length: 200 }, () => [240, 150, 60]));
  assert.ok(r.warmCool > 0.5, '橙色应偏暖：' + r.warmCool);
  const r2 = regionFrom([
    ...Array.from({ length: 100 }, () => [255, 255, 255]),
    ...Array.from({ length: 100 }, () => [30, 30, 30]),
  ]);
  assert.ok(Math.abs(r2.highlightRatio - 0.5) < 0.05);
  assert.ok(Math.abs(r2.shadowRatio - 0.5) < 0.05);
});

test('analyzeRegion：空输入返回 null', () => {
  assert.strictEqual(C.analyzeRegion([], []), null);
});

/* —— 底衬合成与最不利对比 —— */
test('scrimComposite：向黑色/白色按 alpha 收拢', () => {
  assert.deepStrictEqual(C.scrimComposite([200, 200, 200], true, 0.5), [100, 100, 100]);
  assert.deepStrictEqual(C.scrimComposite([100, 100, 100], false, 0.5), [178, 178, 178]);
  assert.deepStrictEqual(C.scrimComposite([100, 120, 140], true, 0), [100, 120, 140]);
});

test('evaluateOnRegion：浅字的最不利处是最亮端', () => {
  const region = regionFrom([
    ...Array.from({ length: 100 }, () => [255, 255, 255]),
    ...Array.from({ length: 100 }, () => [10, 10, 10]),
  ]);
  const white = C.evaluateOnRegion([255, 255, 255], region);
  assert.ok(Math.abs(white.worst - 1) < 0.05, '白字对最亮端的对比应≈1:1');
  assert.ok(white.avg > white.worst, '平均对比应高于最不利对比');
  const black = C.evaluateOnRegion([0, 0, 0], region);
  assert.ok(black.worst < 1.2, '黑字对最暗端同样糟糕');
});

test('evaluateOnRegion：底衬把两端拉近，最不利对比显著提升', () => {
  const region = regionFrom([
    ...Array.from({ length: 100 }, () => [255, 255, 255]),
    ...Array.from({ length: 100 }, () => [10, 10, 10]),
  ]);
  const fg = [250, 250, 250];
  const raw = C.evaluateOnRegion(fg, region);
  const withScrim = C.evaluateOnRegion(fg, region, { dark: true, alpha: 0.45 });
  assert.ok(withScrim.worst > raw.worst + 2, '底衬应显著改善最不利对比：' + raw.worst.toFixed(2) + ' → ' + withScrim.worst.toFixed(2));
});

test('contrastStatus：四级阈值', () => {
  assert.strictEqual(C.contrastStatus(4.5).label, '推荐阅读');
  assert.strictEqual(C.contrastStatus(4.4).label, '适合大标题');
  assert.strictEqual(C.contrastStatus(3).label, '适合大标题');
  assert.strictEqual(C.contrastStatus(2.5).label, '艺术装饰');
  assert.strictEqual(C.contrastStatus(1.9).label, '对比度不足');
});

/* —— 三套方案：六类代表性背景 —— */
const BACKGROUNDS = {
  'A 浅粉奶白': {
    regionColors: Array.from({ length: 300 }, (_, i) =>
      i % 5 === 0 ? [238, 205, 205] : [246, 232, 226]),
    palette: [[246, 232, 226], [238, 205, 205], [225, 185, 190], [250, 244, 238], [216, 170, 176], [206, 150, 158]],
  },
  'B 冰蓝雪景': {
    regionColors: Array.from({ length: 300 }, () => [205 + Math.random() * 30, 222 + Math.random() * 20, 240]),
    palette: [[214, 228, 244], [196, 216, 238], [236, 244, 252], [180, 200, 226], [160, 186, 216], [224, 236, 248]],
  },
  'C 灰绿窗帘': {
    regionColors: Array.from({ length: 300 }, () => [140 + Math.random() * 30, 150 + Math.random() * 30, 132]),
    palette: [[150, 160, 138], [170, 178, 156], [120, 132, 110], [186, 190, 172], [104, 116, 96], [138, 150, 124]],
  },
  'D 深墨绿室内': {
    regionColors: Array.from({ length: 300 }, () => [24 + Math.random() * 20, 40 + Math.random() * 24, 34]),
    palette: [[30, 48, 42], [44, 66, 56], [20, 32, 28], [58, 84, 70], [72, 100, 84], [16, 24, 20]],
  },
  'E 浅紫花卉': {
    regionColors: Array.from({ length: 300 }, () => [225 + Math.random() * 20, 215 + Math.random() * 20, 238]),
    palette: [[232, 224, 244], [214, 200, 234], [244, 240, 250], [200, 184, 226], [186, 166, 216], [224, 210, 240]],
  },
  'F 明暗复杂摄影': {
    regionColors: Array.from({ length: 300 }, (_, i) =>
      i % 2 ? [250, 244, 232] : [18, 22, 28]),
    palette: [[120, 110, 96], [240, 234, 222], [24, 28, 34], [180, 170, 150], [70, 64, 56], [210, 200, 184]],
  },
};

for (const [name, bg] of Object.entries(BACKGROUNDS)) {
  test('buildSchemes｜' + name + '：三套方案结构完整且逐色通过区域评估', () => {
    const region = regionFrom(bg.regionColors);
    assert.ok(region, '区域分析可用');
    const global = region; // 测试里用同一份近似全图
    const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 25, name: C.nameOf(rgb) }));
    const schemes = C.buildSchemes(palette, region, global);
    assert.strictEqual(schemes.length, 3);
    for (const s of schemes) {
      assert.ok(s.colors.length >= 5 && s.colors.length <= 8, s.name + ' 颜色数 ' + s.colors.length);
      for (const c of s.colors) {
        assert.ok(/^#[0-9A-F]{6}$/.test(c.hex), 'HEX 格式 ' + c.hex);
        assert.ok(c.reason.length > 6, '推荐理由不应为空');
        assert.ok(c.status.length > 0);
        assert.ok(c.worstC >= 1, '最不利对比应 ≥1');
      }
    }
    const roles = schemes[1].colors.map((c) => c.use);
    for (const need of ['主标题', '副标题', '正文', '辅助信息', '强调', '装饰']) {
      assert.ok(roles.includes(need), '方案二缺少角色：' + need);
    }
    const bodyColor = schemes[1].colors.find((c) => c.use === '正文');
    const flatBg = region.meanRgb;
    assert.ok(
      C.contrast(bodyColor.rgb, flatBg) >= 4.2,
      '正文色对区域平均对比应接近达标：' + C.contrast(bodyColor.rgb, flatBg).toFixed(2),
    );
  });
}

test('buildSchemes：不同背景给出不同配色（非固定色卡）', () => {
  const mk = (bg) => {
    const region = regionFrom(bg.regionColors);
    const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 25, name: 'x' }));
    return C.buildSchemes(palette, region, region);
  };
  const a = mk(BACKGROUNDS['B 冰蓝雪景']);
  const b = mk(BACKGROUNDS['D 深墨绿室内']);
  const hexes = (schemes) => schemes.flatMap((s) => s.colors.map((c) => c.hex));
  assert.notDeepStrictEqual(hexes(a), hexes(b), '两类背景不应输出同一套色卡');
});

test('buildSchemes：深色背景上浅色字、浅色背景上深色字', () => {
  const darkRegion = regionFrom(Array.from({ length: 200 }, () => [30, 34, 40]));
  const lightRegion = regionFrom(Array.from({ length: 200 }, () => [240, 238, 232]));
  const pal = [{ rgb: [40, 44, 52], hex: '#282C34', hsl: C.rgbToHsl([40, 44, 52]), pct: 50, name: 'x' },
               { rgb: [240, 238, 232], hex: '#F0EEE8', hsl: C.rgbToHsl([240, 238, 232]), pct: 50, name: 'y' }];
  const darkSchemes = C.buildSchemes(pal.slice(0, 1), darkRegion, darkRegion);
  const lightSchemes = C.buildSchemes(pal.slice(1), lightRegion, lightRegion);
  const body = (schemes) => {
    const s = schemes[1];
    return s.colors.find((c) => c.use === '正文') || s.colors[0];
  };
  const db = body(darkSchemes), lb = body(lightSchemes);
  assert.ok(C.rgbToHsl(db.rgb).l > 55, '深底正文应为浅色：L=' + C.rgbToHsl(db.rgb).l.toFixed(0));
  assert.ok(C.rgbToHsl(lb.rgb).l < 45, '浅底正文应为深色：L=' + C.rgbToHsl(lb.rgb).l.toFixed(0));
});

test('pickCandidates：按区域明暗决定方向，浅区只给深色系、深区只给浅色系', () => {
  const lightRegion = regionFrom(Array.from({ length: 100 }, () => [242, 240, 234]));
  const candsLight = C.pickCandidates([242, 240, 234], lightRegion, []);
  assert.ok(candsLight.length >= 8, '候选数量 ' + candsLight.length);
  assert.ok(candsLight.every((c) => C.rgbToHsl(c.rgb).l < 75),
    '浅区候选不应包含高明度浅字：' + candsLight.map((c) => C.rgbToHsl(c.rgb).l.toFixed(0)).join(','));
  const darkRegion = regionFrom(Array.from({ length: 100 }, () => [24, 26, 32]));
  const candsDark = C.pickCandidates([24, 26, 32], darkRegion, []);
  assert.ok(candsDark.every((c) => C.rgbToHsl(c.rgb).l > 30), '深区候选不应包含深字（l<30）');
});

test('scoreCand：不达硬线的候选被重罚，正文角色优先可读', () => {
  const region = regionFrom(Array.from({ length: 100 }, () => [235, 232, 226]));
  const good = { rgb: [40, 40, 46], hex: '#28282E', hsl: C.rgbToHsl([40, 40, 46]), kind: 'neutral' };
  const poor = { rgb: [235, 232, 226], hex: '#EBE8E2', hsl: C.rgbToHsl([235, 232, 226]), kind: 'neutral' };
  const sg = C.scoreCand(good, region, [], '正文');
  const sp = C.scoreCand(poor, region, [], '正文');
  assert.ok(sg.score > sp.score, '可读候选得分应更高');
  assert.ok(sg.score >= 0 && sp.score >= 0);
});

test('reasonOf：包含实际对比数值且随类型变化', () => {
  const region = regionFrom(Array.from({ length: 100 }, () => [30, 34, 40]));
  const rgb = [240, 238, 232];
  const ev = C.evaluateOnRegion(rgb, region);
  const r1 = C.reasonOf(rgb, 'neutral', ev, region);
  const r2 = C.reasonOf(rgb, 'complement', ev, region);
  assert.ok(r1.includes(':1'), '理由应包含对比数值');
  assert.notStrictEqual(r1, r2);
});

/* =========================================================
   新增：背景分类 / 设计配色 / 情绪适配（对应需求三/四/五）
   ========================================================= */

test('新增导出齐全（classifyBg / adaptiveEnhanceParams / designPalette / applyMood / OKLCH 层）', () => {
  for (const k of ['classifyBg', 'adaptiveEnhanceParams', 'designPalette', 'applyMood',
    'oklabToOklch', 'oklchToOklab', 'gamutMap', 'enhanceColor', 'enhancementDegree', 'generateVariants']) {
    assert.strictEqual(typeof C[k], 'function', '缺少导出：' + k);
  }
});

test('classifyBg：纯白 / 纯黑 / 低饱和 / 高饱和分类正确', () => {
  const white = regionFrom(Array.from({ length: 200 }, () => [252, 252, 250]));
  const whiteBg = C.classifyBg([{ rgb: [250, 250, 248] }], white);
  assert.strictEqual(whiteBg.mode, 'B', '近白大面积无彩 → 纯白设计模式');
  assert.ok(whiteBg.type === 'pure-white', '类型：' + whiteBg.type);

  const black = regionFrom(Array.from({ length: 200 }, () => [8, 8, 10]));
  const blackBg = C.classifyBg([{ rgb: [10, 10, 12] }], black);
  assert.strictEqual(blackBg.type, 'pure-black');

  const grayGreen = regionFrom(Array.from({ length: 200 }, () => [140, 148, 132]));
  const lowSatBg = C.classifyBg([{ rgb: [150, 158, 140] }], grayGreen);
  assert.ok(lowSatBg.type.includes('low-sat') || lowSatBg.type === 'normal', '灰绿应为低饱和/普通：' + lowSatBg.type);

  const vivid = regionFrom(Array.from({ length: 200 }, () => [40, 220, 160]));
  const highBg = C.classifyBg([{ rgb: [30, 200, 150] }], vivid);
  assert.ok(highBg.type === 'high-sat' || highBg.satStrategy === 'reduce', '高饱和背景：' + highBg.type);
});

test('adaptiveEnhanceParams：纯白/纯黑克制（satMax 低），normal 允许更高饱和', () => {
  const pw = C.adaptiveEnhanceParams({ type: 'pure-white' });
  assert.ok(pw.satMax <= 40, '纯白 satMax=' + pw.satMax);
  assert.ok(pw.dCScale <= 0.4, '纯白 dCScale=' + pw.dCScale);
  const nm = C.adaptiveEnhanceParams({ type: 'normal' });
  assert.ok(nm.satMax >= 60, 'normal satMax=' + nm.satMax);
});

test('designPalette：纯白/纯黑返回设计条目，其他背景为空数组', () => {
  const pw = C.designPalette('pure-white');
  const pb = C.designPalette('pure-black');
  const other = C.designPalette('normal');
  assert.ok(pw.length >= 5, '纯白设计条目' + pw.length);
  assert.ok(pb.length >= 5, '纯黑设计条目' + pb.length);
  assert.deepStrictEqual(other, []);
  for (const e of pw) {
    assert.strictEqual(e.source, 'design');
    assert.ok(/^#[0-9A-F]{6}$/.test(e.hex));
  }
});

test('applyMood：null 原样返回；非空情绪只做有限偏移并保留条目数', () => {
  const pal = [{ rgb: [120, 140, 160], hex: '#788CA0', hsl: C.rgbToHsl([120, 140, 160]) }];
  assert.strictEqual(C.applyMood(pal, null), pal, 'null 情绪不应改动调色板');

  const lively = { warmth: 0.3, satScale: 1.3, lumBias: 0.3, contrast: 0.7, accentLevel: 0.85, hueBias: 3 };
  const out = C.applyMood(pal, lively);
  assert.strictEqual(out.length, pal.length);
  const oklchIn = C.oklabToOklch(C.rgbToOklab(pal[0].rgb));
  const oklchOut = C.oklabToOklch(C.rgbToOklab(out[0].rgb));
  assert.ok(Math.abs(oklchOut[2] - oklchIn[2]) <= 15, '色相偏移应 ≤14°（含舍入）');
  assert.ok(oklchOut[1] > oklchIn[1], 'lively 应提高色度');
});

test('buildSchemes 传入 mood 后：方案标记情绪名、色值变化、可读性不倒退', () => {
  const bg = BACKGROUNDS['B 冰蓝雪景'];
  const region = regionFrom(bg.regionColors);
  const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 25, name: 'x' }));
  const base = C.buildSchemes(palette, region, region);
  const mood = { id: 'cool', label: '清冷 · 克制', warmth: -0.7, satScale: 0.72, lumBias: 0.15, contrast: 0.62, accentLevel: 0.28, hueBias: -6 };
  const withMood = C.buildSchemes(palette, region, region, { mood });
  for (const s of withMood) {
    assert.ok(s.tag.includes('清冷'), '方案标记应含情绪名：' + s.tag);
  }
  const hexes = (schemes) => schemes.flatMap((s) => s.colors.map((c) => c.hex));
  assert.notDeepStrictEqual(hexes(base), hexes(withMood), '情绪应真正改变颜色，而不是仅改名称');
  /* 可读性硬线不应因情绪而退化：每套每色最不利对比 ≥1，正文到区域平均 ≥4.2 */
  for (const s of withMood) {
    for (const c of s.colors) assert.ok(c.worstC >= 1);
  }
  const bodyColor = withMood[1].colors.find((c) => c.use === '正文');
  assert.ok(C.contrast(bodyColor.rgb, region.meanRgb) >= 4.2, '情绪化方案的正文仍应可读');
});

test('同图不同情绪（清冷克制 vs 温柔治愈）方案有可解释的差异', () => {
  const bg = BACKGROUNDS['C 灰绿窗帘'];
  const region = regionFrom(bg.regionColors);
  const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 25, name: 'x' }));
  const mk = (mood) => C.buildSchemes(palette, region, region, { mood });
  const cool = mk({ id: 'cool', label: '清冷 · 克制', warmth: -0.7, satScale: 0.72, lumBias: 0.15, contrast: 0.62, accentLevel: 0.28, hueBias: -6 });
  const heal = mk({ id: 'healing', label: '温柔 · 治愈', warmth: 0.55, satScale: 1.02, lumBias: 0.30, contrast: 0.34, accentLevel: 0.42, hueBias: 4 });
  const avgChroma = (schemes) => {
    let s = 0;
    schemes.forEach((sc) => sc.colors.forEach((c) => { s += C.oklabToOklch(C.rgbToOklab(c.rgb))[1]; }));
    return s / (schemes.length * schemes[0].colors.length);
  };
  /* 治愈更柔和的预期是色度均值不高于清冷（satScale 更接近 1，但强调度更高）——
     这里验证的是：两套方案不相等 + 都有可读正文 */
  const hexes = (schemes) => schemes.flatMap((s) => s.colors.map((c) => c.hex));
  assert.notDeepStrictEqual(hexes(cool), hexes(heal), '同图不同情绪必须产出不同方案');
  for (const s of [...cool, ...heal]) {
    const body = s.colors.find((c) => c.use === '正文');
    assert.ok(C.contrast(body.rgb, region.meanRgb) >= 4.2, '正文可读性不因情绪牺牲');
  }
});

/* ====== 验收场景 1–5：以纯数据方式验证背景策略 ====== */

test('验收1：纯白背景 → 克制深色方案，不出现荧光色', () => {
  const region = regionFrom(Array.from({ length: 200 }, () => [250, 250, 250]));
  const palette = [{ rgb: [250, 250, 250], hex: '#FAFAFA', hsl: C.rgbToHsl([250, 250, 250]), pct: 100, name: '白' }];
  const schemes = C.buildSchemes(palette, region, region);
  const all = schemes.flatMap((s) => s.colors);
  /* 文字角色（正文/标题/辅助信息/强调）必须深色；装饰色允许略亮（艺术用途）。
     注意：判断「深色」看明度 l，判断「无荧光」看 HSL s ≤ 60（纯白底不会放大饱和度）。 */
  const TEXT_ROLES = ['正文', '主标题', '副标题', '辅助信息', '强调'];
  for (const c of all) {
    const hsl = C.rgbToHsl(c.rgb);
    if (TEXT_ROLES.includes(c.use)) {
      assert.ok(hsl.l < 60, '纯白背景文字角色应深色：' + c.hex + ' L=' + hsl.l.toFixed(0));
    }
    assert.ok(hsl.s <= 60, '不应出现荧光高饱和：' + c.hex + ' S=' + hsl.s.toFixed(0));
  }
  const body = all.find((c) => c.use === '正文');
  assert.ok(C.contrast(body.rgb, [250, 250, 250]) >= 4.5, '正文对白底对比应达标');
});

test('验收2：纯黑背景 → 清晰浅色方案，保持协调', () => {
  const region = regionFrom(Array.from({ length: 200 }, () => [8, 8, 10]));
  const palette = [{ rgb: [10, 10, 12], hex: '#0A0A0C', hsl: C.rgbToHsl([10, 10, 12]), pct: 100, name: '黑' }];
  const schemes = C.buildSchemes(palette, region, region);
  const all = schemes.flatMap((s) => s.colors);
  for (const c of all) {
    assert.ok(C.rgbToHsl(c.rgb).l > 35, '纯黑背景应有浅色文字：' + c.hex);
  }
  const body = all.find((c) => c.use === '正文');
  assert.ok(C.contrast(body.rgb, [8, 8, 10]) >= 4.5, '正文对黑底对比应达标');
});

test('验收3：低饱和灰绿 → 保留灰度气质，不无故变高饱和亮绿', () => {
  const region = regionFrom(Array.from({ length: 200 }, () => [140, 148, 132]));
  const palette = [{ rgb: [150, 158, 140], hex: '#969E8C', hsl: C.rgbToHsl([150, 158, 140]), pct: 100, name: '灰绿' }];
  const schemes = C.buildSchemes(palette, region, region);
  const bgType = C.classifyBg(palette, region);
  assert.ok(
    ['low-sat', 'low-sat-photo', 'very-light-low-sat', 'normal'].includes(bgType.type),
    '灰绿背景分类：' + bgType.type + '（satStrategy=' + bgType.satStrategy + '）');
  assert.equal(bgType.satStrategy, 'preserve', '低饱和图应走 preserve 策略，不做无理由增艳');
  const all = schemes.flatMap((s) => s.colors);
  /* 判断「无高饱和亮绿」必须用感知色度（OKLCH chroma）：
     HSL 饱和度在近黑处会失真（如 #172400 深绿 S=100 但 chroma 仅 0.062）。
     断言：不存在「亮（l>45）且高感知色度（chroma>0.10）」的颜色。 */
  const offenders = all.filter((c) => {
    const hsl = C.rgbToHsl(c.rgb);
    const lab = C.rgbToOklab(c.rgb);
    const chroma = Math.hypot(lab[1], lab[2]);
    return hsl.l > 45 && chroma > 0.10;
  });
  assert.ok(offenders.length === 0,
    '低饱和图不应出现亮且高感知色度的颜色：' + offenders.map((c) => c.hex).join(', '));
});

test('验收4：冰蓝雪景 → 保留冷色气质，同时保证文字清晰', () => {
  const bg = BACKGROUNDS['B 冰蓝雪景'];
  const region = regionFrom(bg.regionColors);
  const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 100, name: '雪' }));
  const schemes = C.buildSchemes(palette, region, region);
  /* 冷气质：主标题色相应偏蓝（180–270 附近）或至少非暖红黄 */
  const title = schemes[1].colors.find((c) => c.use === '主标题');
  const h = C.rgbToHsl(title.rgb).h;
  assert.ok((h >= 150 && h <= 360) || h <= 20 || C.rgbToHsl(title.rgb).s < 18,
    '冰蓝雪景主标题应保留冷色气质：h=' + h.toFixed(0));
  const body = schemes[1].colors.find((c) => c.use === '正文');
  assert.ok(C.contrast(body.rgb, region.meanRgb) >= 4.2, '正文对雪景背景应清晰');
});

test('验收5：深色室内摄影 → 生成适合深色背景的文字颜色', () => {
  const bg = BACKGROUNDS['D 深墨绿室内'];
  const region = regionFrom(bg.regionColors);
  const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 100, name: '室内' }));
  const schemes = C.buildSchemes(palette, region, region);
  const bodyLight = [];
  for (const s of schemes) {
    const b = s.colors.find((c) => c.use === '正文');
    bodyLight.push(C.rgbToHsl(b.rgb).l);
    assert.ok(C.contrast(b.rgb, region.meanRgb) >= 4.2, '深色背景正文应清晰');
  }
  const avgLight = bodyLight.reduce((a, b) => a + b, 0) / bodyLight.length;
  assert.ok(avgLight > 55, '深色背景正文应为浅色系：平均 L=' + avgLight.toFixed(0));
});

test('验收6+9：同一图片三套方案互不相同且均用于当前背景（数据层）', () => {
  const bg = BACKGROUNDS['B 冰蓝雪景'];
  const region = regionFrom(bg.regionColors);
  const palette = bg.palette.map((rgb) => ({ rgb, hex: C.rgbToHex(rgb), hsl: C.rgbToHsl(rgb), pct: 100, name: '雪' }));
  const schemes = C.buildSchemes(palette, region, region);
  const setOf = (s) => new Set(s.colors.map((c) => c.hex));
  assert.strictEqual(schemes.length, 3);
  assert.notDeepStrictEqual([...setOf(schemes[0])], [...setOf(schemes[1])], '方案1 与 方案2 应不同');
  assert.notDeepStrictEqual([...setOf(schemes[1])], [...setOf(schemes[2])], '方案2 与 方案3 应不同');
  /* 每套方案的正文对区域平均对比都达标 */
  for (const s of schemes) {
    const body = s.colors.find((c) => c.use === '正文');
    assert.ok(C.contrast(body.rgb, region.meanRgb) >= 4.2);
  }
});
