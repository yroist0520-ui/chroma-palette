/* =========================================================
   Image Palette Studio · 文案情绪分析核心（纯本地规则引擎）
   ---------------------------------------------------------
   本模块只做一件事：把「用户文案」翻译成可计算的配色参数。
   它不生成颜色 —— 颜色仍由 color-core.js 从图片真实像素出发生成，
   情绪只决定「往哪个方向偏」。

   重要声明：本模块是纯本地规则实现（中文关键词 + 标点 + 语义线索 + 叠词），
   没有接入任何语言模型，也不伪造 AI 能力。若将来接入外部模型，
   可用 setMoodAnalyzer() 注入自定义分析器覆盖默认规则。

   情绪参数含义（供 color-core.buildSchemes 使用）：
     warmth      色温倾向   -1 冷 … +1 暖
     satScale    饱和度缩放  0.5 克制 … 1.4 浓烈
     lumBias     明暗层次   -1 压暗 … +1 提亮
     contrast    对比强度    0 柔和 … 1 强烈
     accentLevel 强调色使用程度 0 极克制 … 1 强强调
     hueBias     色相偏移（度，±14 内）

   双端加载：浏览器挂 window.MoodCore；Node 走 module.exports。
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MoodCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- 情绪词典 ----------
     每种情绪 = 一组可计算的配色参数 + 一组带权关键词。
     权重越高，该词对情绪判断的贡献越大。 */
  const MOODS = {
    cool: {
      label: '清冷 · 克制',
      desc: '降低色度、轻微提亮、拉开明度层次，色相略偏冷。',
      warmth: -0.70, satScale: 0.72, lumBias: 0.15, contrast: 0.62, accentLevel: 0.28, hueBias: -6,
      keywords: [
        ['清冷', 3], ['冷', 2], ['克制', 2], ['安静', 2], ['寂静', 2.4], ['雪', 2.4], ['冰', 2.4],
        ['霜', 2.2], ['冬', 2], ['寒', 2], ['凛冽', 2.6], ['疏离', 2.4], ['淡漠', 2], ['沉默', 1.8],
        ['雾', 1.8], ['月', 1.6], ['夜', 1.4], ['凌晨', 2], ['留白', 1.8], ['干净', 1.4], ['清醒', 1.4],
        ['灰', 1.6], ['蓝', 1.8], ['青', 1.4], ['素', 1.4], ['淡', 1.2], ['静', 1.6],
      ],
    },
    healing: {
      label: '温柔 · 治愈',
      desc: '轻微提亮与柔化，保留暖意，降低对比，颜色更软。',
      warmth: 0.55, satScale: 1.02, lumBias: 0.30, contrast: 0.34, accentLevel: 0.42, hueBias: 4,
      keywords: [
        ['温柔', 3], ['治愈', 3], ['温暖', 2.6], ['暖', 1.8], ['软', 1.8], ['轻轻', 2.4], ['慢慢', 2.2],
        ['阳光', 2.4], ['春日', 2.2], ['春天', 2], ['拥抱', 2.2], ['安心', 2.4], ['陪', 1.6], ['好好', 1.8],
        ['甜', 1.8], ['米白', 1.8], ['奶', 1.8], ['绒', 1.6], ['呼吸', 1.6], ['慢慢来', 2.4], ['一切都会', 2],
      ],
    },
    nostalgic: {
      label: '怀旧 · 沉静',
      desc: '压低色度、略压暗、降低对比，像旧照片与旧胶片。',
      warmth: 0.35, satScale: 0.66, lumBias: -0.12, contrast: 0.42, accentLevel: 0.30, hueBias: 5,
      keywords: [
        ['怀旧', 3], ['旧', 2.2], ['从前', 2.4], ['那年', 2.4], ['回忆', 2.6], ['记忆', 2.2], ['时光', 2.2],
        ['岁月', 2.2], ['老', 1.8], ['胶片', 2.4], ['泛黄', 2.6], ['故事', 1.6], ['秋天', 1.8], ['木', 1.6],
        ['沉静', 2.6], ['安静地', 1.8], ['久', 1.4], ['褪色', 2.4], ['旧日', 2.4],
      ],
    },
    romantic: {
      label: '浪漫 · 柔和',
      desc: '柔化对比、微暖、略提亮，色度克制但偏粉调。',
      warmth: 0.45, satScale: 0.92, lumBias: 0.24, contrast: 0.30, accentLevel: 0.52, hueBias: 6,
      keywords: [
        ['浪漫', 3], ['玫瑰', 2.4], ['粉', 2.2], ['心动', 2.4], ['喜欢', 1.8], ['爱', 2], ['告白', 2.4],
        ['花', 1.8], ['春', 1.6], ['甜', 1.6], ['月亮', 1.8], ['星空', 1.8], ['相遇', 2], ['心跳', 2],
        ['柔', 1.8], ['暧昧', 2.2], ['想你', 2.2], ['永远', 1.8],
      ],
    },
    lively: {
      label: '活泼 · 明亮',
      desc: '提高色度、提亮、加强对比与强调色，色彩更跳。',
      warmth: 0.35, satScale: 1.30, lumBias: 0.32, contrast: 0.70, accentLevel: 0.85, hueBias: 3,
      keywords: [
        ['活泼', 3], ['明亮', 2.6], ['快乐', 2.4], ['开心', 2.4], ['元气', 2.6], ['夏天', 2.2], ['夏日', 2.4],
        ['果汁', 2], ['跳', 1.8], ['奔跑', 2.2], ['哈哈', 2.4], ['太棒', 2.2], ['好耶', 2.4], ['派对', 2.4],
        ['活力', 2.6], ['缤纷', 2.4], ['热闹', 2.2], ['冲', 1.6], ['炫', 2],
      ],
    },
    premium: {
      label: '高级 · 简约',
      desc: '大幅降色度、收敛明暗层次、保持高对比的干净感。',
      warmth: -0.22, satScale: 0.54, lumBias: 0.06, contrast: 0.72, accentLevel: 0.20, hueBias: -3,
      keywords: [
        ['高级', 3], ['简约', 3], ['极简', 2.4], ['质感', 2.4], ['格调', 2.4], ['品味', 2.2], ['留白', 1.8],
        ['克制', 1.6], ['黑', 1.8], ['白', 1.6], ['灰', 1.4], ['金属', 2], ['线', 1.4], ['品牌', 2],
        ['设计', 1.8], ['剪裁', 2], ['建筑', 1.8], ['冷静', 1.8], ['秩序', 2],
      ],
    },
  };

  /* 中性兜底：不偏不倚，不为了氛围牺牲可读性 */
  const NEUTRAL = {
    label: '中性 · 通用',
    desc: '未识别到明确情绪倾向，采用中性策略，只保证可读性。',
    warmth: 0, satScale: 1, lumBias: 0, contrast: 0.5, accentLevel: 0.5, hueBias: 0,
  };

  /* 供 UI 使用的情绪选项（含「自动判断」） */
  const MOOD_OPTIONS = [
    { id: 'auto', label: '自动判断' },
    { id: 'cool', label: MOODS.cool.label },
    { id: 'healing', label: MOODS.healing.label },
    { id: 'nostalgic', label: MOODS.nostalgic.label },
    { id: 'romantic', label: MOODS.romantic.label },
    { id: 'lively', label: MOODS.lively.label },
    { id: 'premium', label: MOODS.premium.label },
    { id: 'neutral', label: NEUTRAL.label },
  ];

  /* 判定阈值：总分太低或前二差距太小 → 不可靠，退回中性 */
  const MIN_SCORE = 2.2;
  const MIN_MARGIN = 0.9;

  function countOccurrences(text, kw) {
    let n = 0, i = 0;
    while ((i = text.indexOf(kw, i)) !== -1) { n++; i += kw.length; }
    return n;
  }

  /* 把情绪定义 + 置信度合成为实际配色参数（按置信度在中性值上插值，
     避免「单个关键词就决定所有颜色」） */
  function compose(id, confidence, matched, signals) {
    const m = MOODS[id] || NEUTRAL;
    const k = clamp(confidence, 0, 1);
    const lerp = (from, to) => +(from + (to - from) * k).toFixed(3);
    return {
      id: id in MOODS ? id : 'neutral',
      label: m.label,
      desc: m.desc || NEUTRAL.desc,
      confidence: +k.toFixed(2),
      neutral: (id === 'neutral') || k < 0.34,
      matched: matched,
      signals: signals || {},
      /* 供 color-core 使用的可计算参数 */
      warmth: lerp(0, m.warmth),
      satScale: lerp(1, m.satScale),
      lumBias: lerp(0, m.lumBias),
      contrast: lerp(0.5, m.contrast),
      accentLevel: lerp(0.5, m.accentLevel),
      hueBias: lerp(0, m.hueBias),
    };
  }

  /* ---------- 主入口：文案 → 情绪参数 ----------
     text：用户文案
     hint：用户手动选择的情绪 id（'auto' 或空表示自动判断） */
  function analyzeMood(text, hint) {
    const raw = (text || '').trim();

    /* 手动指定优先，直接高置信度采用 */
    if (hint && hint !== 'auto') {
      if (hint === 'neutral') return compose('neutral', 1, [], { manual: true });
      if (MOODS[hint]) return compose(hint, 0.92, [], { manual: true });
    }

    if (!raw) return compose('neutral', 0, [], { reason: 'empty' });

    const scores = {};
    const matched = [];
    for (const id of Object.keys(MOODS)) {
      let s = 0;
      for (const [kw, w] of MOODS[id].keywords) {
        const n = countOccurrences(raw, kw);
        if (n) { s += w * Math.min(n, 2); matched.push(kw); }
      }
      scores[id] = s;
    }

    /* 标点与结构线索 */
    const ex = (raw.match(/[!！]/g) || []).length;
    const q = (raw.match(/[?？]/g) || []).length;
    const ell = (raw.match(/…+|\.{3,}/g) || []).length;
    const redup = (raw.match(/([\u4e00-\u9fa5])\1/g) || []).length;
    const lines = raw.split(/\n+/).filter((l) => l.trim()).length;
    const noPunct = !/[，。！？、；：,.!?;:]/.test(raw);

    if (ex) scores.lively += ex * 0.9;
    if (q) scores.lively += q * 0.5;
    if (ell) { scores.nostalgic += ell * 0.8; scores.cool += ell * 0.5; }
    if (redup) { scores.healing += redup * 0.9; scores.romantic += redup * 0.6; }
    if (noPunct && raw.length <= 14) { scores.premium += 1.0; scores.cool += 0.4; }
    if (lines >= 3) { scores.nostalgic += 0.5; scores.premium += 0.4; }

    const signals = { ex, q, ell, redup, lines, noPunct };

    /* 取前二 */
    const ranked = Object.keys(scores).map((id) => ({ id, s: scores[id] })).sort((a, b) => b.s - a.s);
    const top = ranked[0], second = ranked[1];
    if (!top || top.s < MIN_SCORE) return compose('neutral', 0.2, matched, signals);
    const margin = top.s - (second ? second.s : 0);
    if (margin < MIN_MARGIN) return compose('neutral', 0.3, matched, signals);

    /* 置信度：分值越高、领先越多越自信；上限 0.9（本地规则不做满分承诺） */
    const conf = clamp(top.s / (top.s + (second ? second.s : 0)) * 1.6 * clamp(margin / 3, 0.5, 1), 0.35, 0.9);
    return compose(top.id, conf, matched, signals);
  }

  /* ---------- 文案分层 ----------
     把用户的多行文案拆成 标题 / 正文 / 强调 三个角色，
     供预览区展示真实层级。 */
  function splitCopy(text) {
    const raw = (text || '').trim();
    if (!raw) return { title: '', body: '', accent: '', hasAccent: false };
    const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    let title = lines[0] || '';
    let bodyLines = lines.slice(1);

    /* 强调词优先级：书名号/引号/方括号内的短语 > 「｜」分隔 > 短句 */
    let accent = '';
    const quoted = raw.match(/[「『【《“"]([^」』】》”"]{1,10})[」』】》”"]/);
    if (quoted) accent = quoted[1];
    if (!accent && /[｜|]/.test(title)) {
      const segs = title.split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
      if (segs.length > 1) { accent = segs[0]; title = segs.slice(1).join(' '); }
    }
    if (!accent) {
      const segs = title.split(/[，,、。；;:：\s]+/).filter(Boolean);
      const short = segs.find((s) => s.length >= 2 && s.length <= 8);
      if (short && segs.length > 1) accent = short;
    }

    if (title.length > 26) title = title.slice(0, 26);
    let body = bodyLines.join('\n').trim();
    if (!body) body = lines.slice(1).join(' ').trim();
    if (!body) {
      /* 只有一行时：把标题的剩余部分当正文，避免预览空白 */
      const segs = lines[0].split(/[。！？!?]/).map((s) => s.trim()).filter(Boolean);
      body = segs.length > 1 ? segs.slice(1).join('。') : '';
    }
    return { title, body, accent, hasAccent: !!accent };
  }

  /* ---------- 外部分析器注入接口（默认未接入任何 AI） ---------- */
  let externalAnalyzer = null;
  /* setMoodAnalyzer(fn)：fn(text, hint) → 与 analyzeMood 同形状的对象，或 null（回退本地规则）。
     项目默认未接入语言模型；此接口仅供将来扩展，不改变默认行为。 */
  function setMoodAnalyzer(fn) { externalAnalyzer = typeof fn === 'function' ? fn : null; }
  function analyze(text, hint) {
    if (externalAnalyzer) {
      const r = externalAnalyzer(text, hint);
      if (r && typeof r === 'object' && typeof r.satScale === 'number') return r;
    }
    return analyzeMood(text, hint);
  }

  return {
    MOODS, NEUTRAL, MOOD_OPTIONS,
    analyzeMood, analyze, splitCopy, setMoodAnalyzer,
    /* 便于测试与 UI 展示 */
    moodLabelOf: (id) => (MOODS[id] ? MOODS[id].label : NEUTRAL.label),
  };
});
