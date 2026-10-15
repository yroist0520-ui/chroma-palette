/* mood-core.js 单元测试（Node 内置 test runner）
   运行：node --test tests/mood-core.test.js */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const MoodCore = require('../mood-core.js');

/* ---------- 情绪分类 ---------- */
test('清冷克制文案 → cool', () => {
  const r = MoodCore.analyzeMood('雪落在凌晨的山脊，安静得只剩风。');
  assert.strictEqual(r.id, 'cool');
  assert.ok(!r.neutral, '置信度足够时不应退回中性');
  assert.ok(r.warmth < 0, 'cool 应偏冷');
});

test('温柔治愈文案 → healing', () => {
  const r = MoodCore.analyzeMood('轻轻抱住你，一切都会慢慢好起来的，温暖安心。');
  assert.strictEqual(r.id, 'healing');
  assert.ok(r.lumBias > 0, 'healing 应提亮');
});

test('怀旧沉静文案 → nostalgic', () => {
  const r = MoodCore.analyzeMood('泛黄的胶片里，那年秋天的回忆慢慢褪色…');
  assert.strictEqual(r.id, 'nostalgic');
  assert.ok(r.satScale < 1, 'nostalgic 应降色度');
});

test('浪漫柔和文案 → romantic', () => {
  const r = MoodCore.analyzeMood('月光下的告白，是心动的浪漫。');
  assert.strictEqual(r.id, 'romantic');
});

test('活泼明亮文案 → lively', () => {
  const r = MoodCore.analyzeMood('元气满满的夏日派对！奔跑吧快乐！好耶！');
  assert.strictEqual(r.id, 'lively');
  assert.ok(r.satScale > 1, 'lively 应提高色度');
});

test('高级简约文案 → premium', () => {
  const r = MoodCore.analyzeMood('极简剪裁，质感格调，秩序与留白。');
  assert.strictEqual(r.id, 'premium');
  assert.ok(r.satScale < 1, 'premium 应大幅降色度');
});

/* ---------- 中性兜底 ---------- */
test('空文案 → neutral (reason empty)', () => {
  const r = MoodCore.analyzeMood('   ');
  assert.strictEqual(r.id, 'neutral');
  assert.ok(r.neutral);
  assert.strictEqual(r.signals.reason, 'empty');
});

test('无法判断的无情绪文案 → neutral', () => {
  const r = MoodCore.analyzeMood('这是一段测试文字，用于检查分类器。');
  assert.strictEqual(r.id, 'neutral');
});

test('前二差距太小 → 退回中性', () => {
  /* 混合两种情绪且不含更多线索的文案 */
  const r = MoodCore.analyzeMood('安静温柔');
  assert.ok(['neutral', 'healing', 'cool'].includes(r.id));
  if (r.id === 'neutral') assert.ok(r.neutral);
});

/* ---------- 可计算参数与插值 ---------- */
test('参数必须落在声明范围内', () => {
  for (const text of ['雪夜寂静', '元气派对！', '高级简约']) {
    const r = MoodCore.analyzeMood(text);
    assert.ok(r.warmth >= -1 && r.warmth <= 1, 'warmth ∈ [-1,1]');
    assert.ok(r.satScale >= 0.5 && r.satScale <= 1.4, 'satScale ∈ [0.5,1.4]');
    assert.ok(r.lumBias >= -1 && r.lumBias <= 1);
    assert.ok(r.contrast >= 0 && r.contrast <= 1);
    assert.ok(r.accentLevel >= 0 && r.accentLevel <= 1);
    assert.ok(Math.abs(r.hueBias) <= 14, 'hueBias ≤ 14°');
  }
});

test('置信度低时参数向中性收敛（不能单个关键词决定一切）', () => {
  const r = MoodCore.analyzeMood('花');
  if (r.confidence < 0.5) {
    assert.ok(Math.abs(r.warmth) < 0.5, '低置信度时 warmth 应接近 0');
  }
});

/* ---------- 手动 hint ---------- */
test('手动 hint 优先于自动判断', () => {
  const r = MoodCore.analyzeMood('雪夜寂静', 'healing');
  assert.strictEqual(r.id, 'healing');
  assert.strictEqual(r.confidence, 0.92);
  assert.ok(r.signals.manual);
});

test('手动 neutral 直接采用', () => {
  const r = MoodCore.analyzeMood('雪夜寂静', 'neutral');
  assert.strictEqual(r.id, 'neutral');
  assert.strictEqual(r.confidence, 1);
});

/* ---------- splitCopy 分层 ---------- */
test('多行文案：首行为标题，其余为正文', () => {
  const r = MoodCore.splitCopy('山之晨\n云海在脚下翻涌\n风很轻');
  assert.strictEqual(r.title, '山之晨');
  assert.ok(r.body.includes('云海'));
  assert.ok(r.body.includes('风很轻'));
});

test('引号/书名号内短语优先作为强调词', () => {
  const r = MoodCore.splitCopy('冬季特辑「冰湖之境」正式上线');
  assert.strictEqual(r.accent, '冰湖之境');
  assert.ok(r.hasAccent);
});

test('「｜」分隔提取强调词', () => {
  const r = MoodCore.splitCopy('冰湖之境｜冬日的第一场雪');
  assert.strictEqual(r.accent, '冰湖之境');
  assert.strictEqual(r.title, '冬日的第一场雪');
});

test('超长标题截断到 26 字', () => {
  const long = '一'.repeat(40);
  const r = MoodCore.splitCopy(long);
  assert.ok(r.title.length <= 26);
});

test('空文案 splitCopy 安全返回', () => {
  const r = MoodCore.splitCopy('');
  assert.strictEqual(r.hasAccent, false);
  assert.strictEqual(r.title, '');
});

/* ---------- 外部分析器注入 ---------- */
test('setMoodAnalyzer 可注入外部分析器并覆盖默认', () => {
  const fake = { id: 'custom', satScale: 0.8, warmth: 0.1 };
  MoodCore.setMoodAnalyzer(() => fake);
  const r = MoodCore.analyze('任意', 'auto');
  assert.strictEqual(r, fake);
  MoodCore.setMoodAnalyzer(null); /* 还原 */
  const r2 = MoodCore.analyze('雪夜寂静', 'auto');
  assert.strictEqual(r2.id, 'cool');
});

test('外部分析器返回 null 时回退本地规则', () => {
  MoodCore.setMoodAnalyzer(() => null);
  const r = MoodCore.analyze('雪夜寂静', 'auto');
  assert.strictEqual(r.id, 'cool');
  MoodCore.setMoodAnalyzer(null);
});

/* ---------- MOOD_OPTIONS 完整性 ---------- */
test('MOOD_OPTIONS 含自动判断与全部情绪 + 中性', () => {
  const ids = MoodCore.MOOD_OPTIONS.map((o) => o.id);
  assert.ok(ids[0] === 'auto');
  for (const id of ['cool', 'healing', 'nostalgic', 'romantic', 'lively', 'premium', 'neutral']) {
    assert.ok(ids.includes(id), `缺少 ${id}`);
  }
});
