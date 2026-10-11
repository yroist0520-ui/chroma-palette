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
    'clamp', 'hexToRgb', 'rgbToHex', 'rgbToHsl', 'hslToRgb',
    'relLum', 'contrast', 'levelOf', 'nameOf',
    'srgbToLinear', 'linearToSrgb', 'rgbToOklab', 'oklabToRgb', 'distLab',
    'medianCutLab', 'kmeansLab', 'mergeClose', 'adaptForContrast',
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

/* ================= 7. 命名 ================= */
test('nameOf：最近邻命名', () => {
  assert.strictEqual(C.nameOf([0, 0, 0]), '纯黑');
  assert.strictEqual(C.nameOf([255, 255, 255]), '纯白');
  assert.strictEqual(C.nameOf([216, 255, 62]), '柠檬黄');
});
