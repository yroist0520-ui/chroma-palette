/* =========================================================
   CHROMA · 基于图片与文案的智能文字配色
   ---------------------------------------------------------
   核心流程（与 PRD 一致）：
     上传图片 → 分析图片(真实像素) → 输入文案 → 判断情绪
     → 生成候选色 → 综合评分 → 输出三套方案 → 在真实图片上预览
   分工：
     color-core.js  图片取色 / 区域分析 / 颜色生成 / 对比度评分（纯函数）
     mood-core.js   文案情绪 → 可计算的配色参数（纯本地规则，非 AI）
     app.js（本文件）DOM、交互、把两者串成产品流程
   纯前端：Canvas 读取像素，本地计算，图片不离开浏览器。
   ========================================================= */
(function () {
  'use strict';

  /* ================= ① DOM ================= */
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone'), fileInput = $('fileInput');
  const dzPick = $('dzPick'), dzSample = $('dzSample');
  const sampleBtn = $('sampleBtn'), reanalyzeBtn = $('reanalyzeBtn'), replaceBtn = $('replaceBtn');
  const stage = $('stage'), frame = $('frame'), previewImg = $('previewImg');
  const overlay = $('overlay'), overlayText = $('overlayText'), overlayScrim = $('overlayScrim'), frameHint = $('frameHint');
  const ovTitle = $('ovTitle'), ovBody = $('ovBody'), ovAccent = $('ovAccent');
  const imgMeta = $('imgMeta'), contrastStrip = $('contrastStrip');
  const copyInput = $('copyInput'), moodChips = $('moodChips'), moodRead = $('moodRead');
  const generateBtn = $('generateBtn'), staleHint = $('staleHint');
  const resultPanel = $('resultPanel'), bgTypeBadge = $('bgTypeBadge'), bgSummary = $('bgSummary'), schemeList = $('schemeList');
  const advPanel = $('advPanel');
  const sizeRange = $('sizeRange'), sizeVal = $('sizeVal');
  const widthRange = $('widthRange'), widthVal = $('widthVal');
  const lhRange = $('lhRange'), lhVal = $('lhVal');
  const lsRange = $('lsRange'), lsVal = $('lsVal');
  const weightSelect = $('weightSelect'), alignSelect = $('alignSelect');
  const strokeToggle = $('strokeToggle'), shadowToggle = $('shadowToggle'), scrimToggle = $('scrimToggle'), resetBtn = $('resetBtn');
  const srcChip = $('srcChip'), srcHex = $('srcHex'), srcHsl = $('srcHsl'), srcPickBtn = $('srcPickBtn'), resetSourceBtn = $('resetSourceBtn');
  const enhanceL = $('enhanceL'), valL = $('valL'), enhanceC = $('enhanceC'), valC = $('valC'), variantRow = $('variantRow');
  const copyHexBtn = $('copyHexBtn'), copyCssBtn = $('copyCssBtn'), pngBtn = $('pngBtn'), jsonBtn = $('jsonBtn');
  const toastEl = $('toast');

  /* ================= ② 常量与状态 ================= */
  const STAGE_BG = [20, 20, 25]; // 透明 PNG 按舞台底色合成，避免透明像素被当作黑色
  const SCRIM_ALPHA = 0.55;      // 文字底衬不透明度（读数与渲染共用）
  const OK_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  const MAX_SIZE = 25 * 1024 * 1024;

  const DEFAULTS = {
    style: { size: 40, weight: '700', lh: 1.35, ls: 0.02, align: 'left', boxW: 62, stroke: true, shadow: true, scrim: false },
  };
  const SAMPLE_COPY = '把文字放进画面里\n拖动文字框，配色会按「真实背景」重新计算。';

  const state = {
    img: null,
    palette: [],       // 全图取色 [{rgb,hex,hsl,pct,name}]
    lum: null,         // 亮度图 {w,h,lum,rgb}
    global: null,      // 整图分析（analyzeRegion 结果）
    region: null,      // 文字框区域分析
    bgType: null,      // classifyBg 结果
    schemes: [],       // 三套方案
    activeScheme: 1,   // 默认落在「清晰专业」的成套方案
    hasResult: false,
    dirty: false,
    copyText: '',      // 用户实际输入的文案
    copy: { title: '', body: '', accent: '', hasAccent: false },
    moodHint: 'auto',  // 用户手动选择的情绪（'auto' 表示自动判断）
    mood: null,        // 当前生效的情绪参数
    style: { ...DEFAULTS.style },
    pos: { x: 0.5, y: 0.5 },
    /* 原色驱动增强 */
    srcColor: null, enhanceL: 0, enhanceC: 0,
    picking: false, customFgHex: null,
    scrimManual: false,
  };
  let objectUrl = null;
  let previewToken = 0;

  const {
    clamp, hexToRgb, rgbToHex, rgbToHsl, rgbToHsv, relLum,
    rgbToOklab, kmeansLab, mergeClose, analyzeRegion, evaluateOnRegion, contrastStatus,
    classifyBg, buildSchemes,
    oklabToOklch, gamutMap, enhanceColor, generateVariants,
  } = window.ColorCore;
  const MoodCore = window.MoodCore;

  const ICON_COPY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  /* ================= ③ 工具 ================= */
  function copyText(text, msg) {
    const done = () => toast(msg || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择色值'); }
    document.body.removeChild(ta);
  }
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-show'), 1900);
  }
  function updateRangeFill(el) {
    const min = Number(el.min), max = Number(el.max), v = Number(el.value);
    el.style.setProperty('--fill', (((v - min) / (max - min)) * 100) + '%');
  }
  const inkOf = (rgb) => (relLum(rgb) > 0.5 ? '#0A0A0C' : '#FFFFFF');
  const ratioCls = (worst) => (worst >= 4.5 ? 'is-ok' : worst >= 3 ? 'is-warn' : 'is-bad');

  /* ================= ④ 图片分析（真实像素） ================= */
  /* 全图取色：缩放到 220px 后按 OKLab 加权 k-means 聚类，避免单个异常像素影响 */
  function extractPalette(img, k) {
    const W = 220;
    const scale = Math.min(1, W / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = `rgb(${STAGE_BG.join(',')})`;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 125) continue;
      px.push(rgbToOklab([data[i], data[i + 1], data[i + 2]]));
    }
    if (!px.length) return [];
    const total = px.length;
    const clusters = mergeClose(kmeansLab(px, k, 8, 0.04), 0.04);
    clusters.sort((a, b) => b.n - a.n);
    return clusters.map((cl) => {
      const rgb = oklabToRgbSafe(cl.lab);
      return {
        rgb, hex: rgbToHex(rgb), hsl: rgbToHsl(rgb),
        pct: Math.max(1, Math.round((cl.n / total) * 100)), name: nameOf(rgb),
      };
    });
  }
  function oklabToRgbSafe(lab) { return window.ColorCore.oklabToRgb(lab); }
  function nameOf(rgb) { return window.ColorCore.nameOf(rgb); }

  /* 亮度图：96px 缩略，逐像素记录相对亮度与 RGB，供区域分析与吸色 */
  function buildLumMap(img) {
    const W = 96;
    const scale = Math.min(1, W / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = `rgb(${STAGE_BG.join(',')})`;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    const rgb = new Uint8ClampedArray(w * h * 3);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      lum[p] = relLum([r, g, b]);
      rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b;
    }
    return { w, h, lum, rgb };
  }

  /* ================= ⑤ 文字区域分析 ================= */
  function regionBounds() {
    const ir = previewImg.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();
    if (!ir.width || !ir.height) return null;
    return {
      x0: clamp((or.left - ir.left) / ir.width, 0, 1),
      y0: clamp((or.top - ir.top) / ir.height, 0, 1),
      x1: clamp((or.right - ir.left) / ir.width, 0, 1),
      y1: clamp((or.bottom - ir.top) / ir.height, 0, 1),
    };
  }
  /* 采样文字框覆盖区域 → analyzeRegion（背景明暗/复杂度/冷暖/两端色） */
  function sampleRegion() {
    if (!state.lum) return;
    const b = regionBounds();
    if (!b) {
      /* 预览图尚未完成布局时，回退到全图作为文字区域，避免 region 为 null */
      if (!state.region && state.global) state.region = state.global;
      return;
    }
    const { w, h, lum, rgb } = state.lum;
    const x0 = clamp(Math.floor(b.x0 * w), 0, w - 1);
    const x1 = clamp(Math.ceil(b.x1 * w) - 1, 0, w - 1);
    const y0 = clamp(Math.floor(b.y0 * h), 0, h - 1);
    const y1 = clamp(Math.ceil(b.y1 * h) - 1, 0, h - 1);
    const lums = [], rgbs = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * w + x;
        lums.push(lum[p]);
        rgbs.push(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
      }
    }
    state.region = analyzeRegion(lums, rgbs);
  }

  function analyzeImage() {
    state.palette = extractPalette(state.img, 7);
    state.lum = buildLumMap(state.img);
    state.global = analyzeRegion(state.lum.lum, state.lum.rgb);
    state.bgType = classifyBg(state.palette, state.global);
    sampleRegion();
  }

  /* ================= ⑥ 情绪 & 配色生成 ================= */
  /* 文案情绪（本地规则；moodHint 为用户手动选择） */
  function readMood() {
    const raw = copyInput.value.trim();
    return MoodCore.analyze(raw, state.moodHint);
  }

  /* 核心：文案 → 情绪 → 重新生成三套方案（不是只改预览文字） */
  function generate(opts) {
    opts = opts || {};
    if (!state.img) { toast('请先上传一张图片'); return; }
    const raw = copyInput.value.trim();
    if (!raw) { toast('请先输入一段文案，系统需要它来判断情绪'); copyInput.focus(); return; }

    if (!state.lum || !state.global) analyzeImage();
    sampleRegion();

    state.copyText = raw;
    state.copy = MoodCore.splitCopy(raw);
    state.mood = MoodCore.analyze(raw, state.moodHint);
    state.customFgHex = null;

    /* 情绪真实参与颜色计算：作为 opts.mood 传入 buildSchemes */
    /* region 可能在预览布局未完成时为 null，回退到全图分析，避免生成崩溃 */
    state.schemes = buildSchemes(state.palette, state.region || state.global, state.global, {
      bgType: state.bgType, mood: state.mood,
    });
    if (state.activeScheme >= state.schemes.length) state.activeScheme = 1;
    state.hasResult = true;
    state.dirty = false;
    if (!state.scrimManual) autoScrim();
    renderAll();
    if (opts.toastMsg) toast(opts.toastMsg);
    else if (!opts.silent) toast('已生成 ' + state.schemes.length + ' 套配色方案');
  }

  /* 推荐方案正文色在纯文字下读不清时，自动加一层底衬兜底（可被手动开关覆盖） */
  function autoScrim() {
    const s = state.schemes[1] || state.schemes[0];
    if (!s || !state.region) return;
    const body = s.colors.find((c) => c.use === '正文')
      || s.colors.slice().sort((a, b) => b.worstC - a.worstC)[0];
    if (!body) return;
    const raw = evaluateOnRegion(body.rgb, state.region, null);
    state.style.scrim = raw.worst < 4.5;
    scrimToggle.setAttribute('aria-checked', String(state.style.scrim));
  }

  /* ================= ⑦ 渲染：背景分析摘要 ================= */
  function renderBgSummary() {
    const g = state.global, bt = state.bgType;
    if (!g || !bt) return;
    bgTypeBadge.textContent = bt.label;
    bgTypeBadge.className = 'badge ' + (bt.mode === 'B' ? 'b-info' : 'b-ok');
    const main = state.palette[0];
    const warm = g.warmCool > 0.15 ? '偏暖' : g.warmCool < -0.15 ? '偏冷' : '中性';
    const complex = g.complexity < 0.25 ? '简洁' : g.complexity < 0.5 ? '适中' : '复杂';
    const light = g.meanLum > 0.5 ? '偏亮' : g.meanLum > 0.18 ? '中等明度' : '偏暗';
    const tags = [
      ['主色', main ? main.hex : '—', main ? main.hex : null],
      ['平均饱和', Math.round(g.satMean) + '%', null],
      ['冷暖', warm, null],
      ['明暗', light, null],
      ['复杂度', complex, null],
      ['文字区域', state.region ? (state.region.isComplex ? '明暗跨度大' : '较均匀') : '—', null],
    ];
    bgSummary.innerHTML = '';
    tags.forEach(([k, v, sw]) => {
      const el = document.createElement('span');
      el.className = 'tag';
      el.innerHTML = (sw ? '<span class="dot" style="background:' + sw + '"></span>' : '')
        + '<span>' + k + ' ' + v + '</span>';
      bgSummary.appendChild(el);
    });
    if (bt.hint) {
      const el = document.createElement('span');
      el.className = 'tag';
      el.style.color = 'var(--accent)';
      el.textContent = bt.hint;
      bgSummary.appendChild(el);
    }
  }

  /* ================= ⑧ 渲染：情绪 UI ================= */
  function renderMoodChips() {
    moodChips.innerHTML = '';
    MoodCore.MOOD_OPTIONS.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (opt.id === state.moodHint ? ' is-on' : '');
      b.textContent = opt.label;
      b.dataset.id = opt.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(opt.id === state.moodHint));
      moodChips.appendChild(b);
    });
  }
  /* 情绪读数：把文案 → 情绪的结果如实展示（本地规则，非 AI） */
  function renderMoodRead() {
    const raw = copyInput.value.trim();
    if (!raw) { moodRead.hidden = true; return; }
    const m = MoodCore.analyze(raw, state.moodHint);
    moodRead.hidden = false;
    const kw = Array.from(new Set(m.matched || [])).slice(0, 6);
    let txt;
    if (m.neutral && !kw.length) {
      txt = '未识别到明确情绪，采用中性策略（只保证可读性，不强行调色）';
    } else {
      txt = '识别情绪：' + m.label;
      if (!m.neutral) txt += '（置信度 ' + Math.round(m.confidence * 100) + '%）';
      if (kw.length) txt += ' · 命中：' + kw.join('、');
    }
    moodRead.textContent = txt;
  }

  /* ================= ⑨ 渲染：三套方案 ================= */
  const ROLE3 = [
    { role: '主标题', label: '标题色' },
    { role: '正文', label: '正文色' },
    { role: '强调', label: '强调色' },
  ];
  function activeScheme() { return state.schemes[state.activeScheme] || null; }

  /* 取方案中某角色的色；缺失时按可读性/饱和度回退，保证预览不空白 */
  function roleColor(s, role) {
    if (!s || !s.colors.length) return null;
    const found = s.colors.find((c) => c.use === role);
    if (found) return found;
    const byWorst = s.colors.slice().sort((a, b) => b.worstC - a.worstC);
    if (role === '强调') return s.colors.slice().sort((a, b) => b.sat - a.sat)[0] || byWorst[0];
    return byWorst[0];
  }

  function renderSchemes() {
    schemeList.innerHTML = '';
    if (!state.schemes.length) {
      schemeList.innerHTML = '<p class="scheme-desc">输入文案后点击「生成配色」，这里会出现三套针对当前图片与文案计算的方案。</p>';
      return;
    }
    state.schemes.forEach((s, si) => {
      const card = document.createElement('div');
      card.className = 'scheme-card' + (si === state.activeScheme ? ' is-active' : '');
      card.dataset.s = si;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-pressed', String(si === state.activeScheme));

      const head = document.createElement('div');
      head.className = 'scheme-head';
      head.innerHTML = '<span class="scheme-name">' + s.name + '</span>'
        + (s.mood ? '<span class="scheme-mood">' + s.mood + '</span>' : '')
        + '<span class="scheme-tag">' + s.tag + '</span>';
      card.appendChild(head);

      const desc = document.createElement('p');
      desc.className = 'scheme-desc';
      desc.textContent = s.desc;
      card.appendChild(desc);

      const rows = document.createElement('div');
      rows.className = 'role-rows';
      ROLE3.forEach(({ role, label }) => {
        const c = roleColor(s, role);
        if (!c) return;
        const row = document.createElement('div');
        row.className = 'role-row';
        row.innerHTML =
          '<span class="sw" style="background:' + c.hex + '"></span>'
          + '<span class="rname">' + label + '</span>'
          + '<span class="hexv">' + c.hex + '</span>'
          + '<span class="ratio ' + ratioCls(c.worstC) + '">' + c.worstC.toFixed(1) + ':1</span>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.dataset.copy = c.hex;
        btn.setAttribute('aria-label', '复制 ' + c.hex);
        btn.innerHTML = ICON_COPY;
        row.appendChild(btn);
        rows.appendChild(row);
      });
      card.appendChild(rows);

      /* 其余角色以小色点展示，保留完整信息但不喧宾夺主 */
      const extras = s.colors.filter((c) => !ROLE3.some((r) => r.role === c.use));
      if (extras.length) {
        const dots = document.createElement('div');
        dots.className = 'extra-dots';
        dots.innerHTML = '<span class="dlabel">其余</span>';
        extras.forEach((c) => {
          const d = document.createElement('span');
          d.className = 'dot';
          d.style.background = c.hex;
          d.title = (c.use || '点缀') + ' ' + c.hex;
          dots.appendChild(d);
        });
        card.appendChild(dots);
      }
      schemeList.appendChild(card);
    });
  }

  /* ================= ⑩ 渲染：可读性检查条 ================= */
  function scrimFor(rgb) {
    return state.style.scrim ? { dark: relLum(rgb) > 0.35, alpha: SCRIM_ALPHA } : null;
  }
  function renderContrastStrip() {
    if (!state.hasResult || !state.region) { contrastStrip.hidden = true; return; }
    const pc = previewColors();
    if (!pc) { contrastStrip.hidden = true; return; }
    contrastStrip.hidden = false;
    contrastStrip.innerHTML = '';
    [['标题色', pc.title], ['正文色', pc.body], ['强调色', pc.accent]].forEach(([label, c]) => {
      const ev = evaluateOnRegion(c.rgb, state.region, scrimFor(c.rgb));
      const box = document.createElement('div');
      box.className = 'cbox ' + ratioCls(ev.worst);
      box.innerHTML = '<span class="sw" style="background:' + c.hex + '"></span>'
        + '<span class="role">' + label + '</span>'
        + '<span class="hexv">' + c.hex + '</span>'
        + '<span class="ratio">' + ev.worst.toFixed(1) + ':1</span>';
      box.title = label + '对文字区域最不利处对比 ' + ev.worst.toFixed(2) + ':1（平均 ' + ev.avg.toFixed(2) + ':1）';
      contrastStrip.appendChild(box);
    });
  }

  /* ================= ⑪ 渲染：真实图片预览 ================= */
  /* 预览用色：标题/正文/强调三角色；手动变体可覆盖 */
  function previewColors() {
    if (state.customFgHex) {
      const rgb = hexToRgb(state.customFgHex);
      const c = { rgb, hex: state.customFgHex, worstC: 0, avgC: 0, use: '自定义' };
      return { title: c, body: c, accent: c };
    }
    const s = activeScheme();
    if (!s || !s.colors.length) return null;
    return { title: roleColor(s, '主标题'), body: roleColor(s, '正文'), accent: roleColor(s, '强调') };
  }

  function decorate(el, c) {
    el.style.color = c.hex;
    const S = state.style;
    const shadows = [];
    const lightText = relLum(c.rgb) > 0.4; // 亮字配深色衬，暗字配浅色衬
    if (S.shadow) {
      shadows.push(lightText
        ? '0 1px 2px rgba(0,0,0,.55), 0 2px 14px rgba(0,0,0,.42)'
        : '0 1px 2px rgba(255,255,255,.5), 0 2px 14px rgba(0,0,0,.30)');
    }
    if (S.stroke) {
      const sc = lightText ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.72)';
      const r = 0.028;
      [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([dx, dy]) => {
        shadows.push((dx * r).toFixed(3) + 'em ' + (dy * r).toFixed(3) + 'em 0 ' + sc);
      });
    }
    el.style.textShadow = shadows.length ? shadows.join(', ') : 'none';
  }

  function renderPreview() {
    const cp = state.copy || { title: '', body: '', accent: '' };
    ovTitle.textContent = cp.title || ' ';
    ovBody.textContent = cp.body || ' ';
    ovBody.hidden = !cp.body;
    ovAccent.textContent = cp.accent || '';
    ovAccent.hidden = !cp.accent;

    const pc = previewColors();
    if (pc) {
      decorate(ovTitle, pc.title);
      decorate(ovBody, pc.body);
      decorate(ovAccent, pc.accent);
    }
    overlayScrim.hidden = !state.style.scrim;
    if (state.style.scrim && pc) {
      const light = relLum(pc.body.rgb) > 0.35;
      overlayScrim.style.background = light
        ? 'rgba(8,8,12,' + SCRIM_ALPHA + ')'
        : 'rgba(255,255,255,' + (SCRIM_ALPHA + 0.05).toFixed(2) + ')';
    }
    applyTextStyle();
  }

  function applyTextStyle() {
    if (!state.img) return;
    const w = previewImg.getBoundingClientRect().width || 800;
    const k = w / 1000;
    const S = state.style;
    overlayText.style.fontSize = clamp(S.size * k, 10, 260).toFixed(1) + 'px';
    overlayText.style.fontWeight = S.weight;
    overlayText.style.lineHeight = S.lh;
    overlayText.style.letterSpacing = S.ls.toFixed(3) + 'em';
    overlayText.style.textAlign = S.align;
    overlay.style.width = S.boxW + '%';
  }

  function applyPosition() {
    overlay.style.left = (state.pos.x * 100) + '%';
    overlay.style.top = (state.pos.y * 100) + '%';
  }

  /* ================= ⑫ 渲染调度 ================= */
  function renderAll() {
    renderBgSummary();
    renderMoodChips();
    renderMoodRead();
    renderSchemes();
    renderContrastStrip();
    renderPreview();
    applyPosition();
    enableTools();
    requestAnimationFrame(() => { applyTextStyle(); renderContrastStrip(); });
  }

  function enableTools() {
    reanalyzeBtn.disabled = !state.img;
    const has = state.hasResult && state.schemes.length > 0;
    [copyHexBtn, copyCssBtn, pngBtn, jsonBtn].forEach((b) => { b.disabled = !has; });
    if (has) advPanel.hidden = false;
  }

  /* ================= ⑬ 图片载入 ================= */
  function onImageReady(img, src) {
    state.img = img;
    const token = ++previewToken;
    let done = false;
    const ready = () => {
      if (token !== previewToken || done) return;
      done = true;
      dropzone.hidden = true;
      frame.hidden = false;
      replaceBtn.hidden = false;
      resultPanel.hidden = false;
      imgMeta.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' · 本地分析';
      state.pos = { x: 0.5, y: 0.5 };
      state.scrimManual = false;
      frameHint.classList.remove('is-hidden');
      applyPosition();
      analyzeImage();
      setSourceColor(state.palette[0] ? state.palette[0].rgb : null, true);
      if (state.hasResult) {
        /* 图片改变 → 重新分析并生成新方案（满足「图片改变须重分析」） */
        generate({ silent: true, toastMsg: '已按新图片重新分析并生成配色' });
      } else {
        renderAll();
        renderSchemes();
      }
    };
    previewImg.onload = ready;
    previewImg.src = src;
    if (previewImg.complete && previewImg.naturalWidth) ready();
  }
  function loadImageSrc(src) {
    const img = new Image();
    img.onload = () => onImageReady(img, src);
    img.onerror = () => toast('图片加载失败，请换一张试试');
    img.src = src;
  }
  function handleFile(file) {
    if (!file) return;
    if (!OK_TYPES.includes(file.type)) { toast('仅支持 JPG / PNG / WebP 格式'); return; }
    if (file.size > MAX_SIZE) { toast('图片超过 25MB，请压缩后再试'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    loadImageSrc(objectUrl);
  }

  /* 本地生成示例图（离线可用，不请求网络） */
  function makeSampleImage() {
    const W = 1280, H = 800;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, H * 0.62);
    g.addColorStop(0, '#141a3a');
    g.addColorStop(0.45, '#4a3a72');
    g.addColorStop(0.78, '#c25f5f');
    g.addColorStop(1, '#ff9d5c');
    x.fillStyle = g; x.fillRect(0, 0, W, H * 0.62);
    x.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 80; i++) {
      const sx = Math.random() * W, sy = Math.random() * H * 0.4, r = Math.random() * 1.6 + 0.4;
      x.beginPath(); x.arc(sx, sy, r, 0, Math.PI * 2); x.fill();
    }
    const sunX = W * 0.68, sunY = H * 0.5;
    const sg = x.createRadialGradient(sunX, sunY, 0, sunX, sunY, 190);
    sg.addColorStop(0, 'rgba(255,240,180,1)');
    sg.addColorStop(0.35, 'rgba(255,200,110,.9)');
    sg.addColorStop(1, 'rgba(255,150,90,0)');
    x.fillStyle = sg; x.beginPath(); x.arc(sunX, sunY, 190, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ffe9a8'; x.beginPath(); x.arc(sunX, sunY, 62, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#3a2f5c';
    x.beginPath();
    x.moveTo(0, H * 0.62); x.lineTo(W * 0.18, H * 0.34); x.lineTo(W * 0.34, H * 0.5);
    x.lineTo(W * 0.5, H * 0.28); x.lineTo(W * 0.72, H * 0.52); x.lineTo(W * 0.88, H * 0.38);
    x.lineTo(W, H * 0.55); x.lineTo(W, H * 0.62); x.closePath(); x.fill();
    x.fillStyle = '#1e1a38';
    x.beginPath();
    x.moveTo(0, H * 0.62); x.lineTo(W * 0.22, H * 0.46); x.lineTo(W * 0.42, H * 0.58);
    x.lineTo(W * 0.6, H * 0.44); x.lineTo(W * 0.8, H * 0.6); x.lineTo(W, H * 0.5);
    x.lineTo(W, H * 0.62); x.closePath(); x.fill();
    const wg = x.createLinearGradient(0, H * 0.62, 0, H);
    wg.addColorStop(0, '#2b2a55'); wg.addColorStop(0.5, '#1a1b3d'); wg.addColorStop(1, '#0e0f24');
    x.fillStyle = wg; x.fillRect(0, H * 0.62, W, H * 0.38);
    const rg = x.createLinearGradient(sunX - 80, H * 0.62, sunX + 80, H);
    rg.addColorStop(0, 'rgba(255,200,120,0)');
    rg.addColorStop(0.5, 'rgba(255,200,120,.5)');
    rg.addColorStop(1, 'rgba(255,200,120,0)');
    x.fillStyle = rg; x.fillRect(sunX - 80, H * 0.62, 160, H * 0.38);
    x.strokeStyle = 'rgba(255,255,255,.12)'; x.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const yy = H * 0.66 + i * 20;
      x.beginPath(); x.moveTo(0, yy); x.lineTo(W, yy); x.stroke();
    }
    return c.toDataURL('image/png');
  }

  /* ================= ⑭ 交互：拖动文字框 ================= */
  let dragging = false, rafId = 0;
  function liveRegionUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      sampleRegion();
      renderContrastStrip();
    });
  }
  overlay.addEventListener('pointerdown', (ev) => {
    dragging = true;
    try { overlay.setPointerCapture(ev.pointerId); } catch (e) {}
    try { overlay.focus({ preventScroll: true }); } catch (e) {}
    frameHint.classList.add('is-hidden');
    ev.preventDefault();
  });
  overlay.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = previewImg.getBoundingClientRect();
    if (!r.width) return;
    state.pos.x = clamp((ev.clientX - r.left) / r.width, 0.02, 0.98);
    state.pos.y = clamp((ev.clientY - r.top) / r.height, 0.02, 0.98);
    applyPosition();
    liveRegionUpdate();
  });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { overlay.releasePointerCapture(ev.pointerId); } catch (e) {}
    sampleRegion();
    /* 区域变化 → 重新生成方案（位置决定颜色是否可读） */
    if (state.hasResult) generate({ silent: true });
    else renderContrastStrip();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', () => { dragging = false; });
  overlay.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.05 : 0.01;
    if (ev.key === 'ArrowLeft') state.pos.x = clamp(state.pos.x - step, 0.02, 0.98);
    else if (ev.key === 'ArrowRight') state.pos.x = clamp(state.pos.x + step, 0.02, 0.98);
    else if (ev.key === 'ArrowUp') state.pos.y = clamp(state.pos.y - step, 0.02, 0.98);
    else if (ev.key === 'ArrowDown') state.pos.y = clamp(state.pos.y + step, 0.02, 0.98);
    else return;
    ev.preventDefault();
    applyPosition();
    sampleRegion();
    if (state.hasResult) generate({ silent: true });
    else renderContrastStrip();
  });

  /* ================= ⑮ 交互：文案 / 情绪 / 主按钮 ================= */
  let copyTimer = 0;
  function showStale(msg) { staleHint.textContent = msg; staleHint.hidden = false; }
  function hideStale() { staleHint.hidden = true; }

  copyInput.addEventListener('input', () => {
    renderMoodRead();
    if (!state.hasResult) return;
    /* 文案改变 → 必须重新计算配色（debounce 后真正重算，而不是只改预览文字） */
    state.dirty = true;
    showStale('文案已改变，正在按新文案重新计算配色…');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      generate({ silent: true });
      hideStale();
      toast('已按新文案重新生成配色');
    }, 480);
  });

  moodChips.addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    state.moodHint = b.dataset.id;
    renderMoodChips();
    renderMoodRead();
    if (state.hasResult) {
      generate({ silent: true, toastMsg: '已按「' + MoodCore.moodLabelOf(state.mood ? state.mood.id : 'neutral') + '」重新生成配色' });
    }
  });

  generateBtn.addEventListener('click', () => { hideStale(); generate(); });

  /* ================= ⑯ 交互：方案切换 / 复制 ================= */
  schemeList.addEventListener('click', (ev) => {
    const card = ev.target.closest('.scheme-card');
    if (!card) return;
    const copyBtn = ev.target.closest('[data-copy]');
    if (copyBtn) {
      const hex = copyBtn.dataset.copy;
      copyText(hex, '已复制 ' + hex);
      const original = copyBtn.innerHTML;
      copyBtn.innerHTML = ICON_CHECK;
      copyBtn.classList.add('is-done');
      setTimeout(() => { copyBtn.innerHTML = original; copyBtn.classList.remove('is-done'); }, 1100);
      ev.stopPropagation();
      return;
    }
    /* 点击方案 → 切换下方预览 */
    state.activeScheme = Number(card.dataset.s);
    state.customFgHex = null;
    renderSchemes();
    renderContrastStrip();
    renderPreview();
  });
  schemeList.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest('.scheme-card');
    if (!card) return;
    ev.preventDefault();
    state.activeScheme = Number(card.dataset.s);
    state.customFgHex = null;
    renderSchemes(); renderContrastStrip(); renderPreview();
  });

  /* ================= ⑰ 交互：排版样式 ================= */
  sizeRange.addEventListener('input', () => {
    state.style.size = Number(sizeRange.value);
    sizeVal.textContent = state.style.size;
    updateRangeFill(sizeRange);
    applyTextStyle();
  });
  weightSelect.addEventListener('change', () => { state.style.weight = weightSelect.value; applyTextStyle(); });
  lhRange.addEventListener('input', () => {
    state.style.lh = Number(lhRange.value) / 100;
    lhVal.textContent = state.style.lh.toFixed(2);
    updateRangeFill(lhRange);
    applyTextStyle();
  });
  lsRange.addEventListener('input', () => {
    state.style.ls = Number(lsRange.value) / 100;
    lsVal.textContent = state.style.ls.toFixed(2) + 'em';
    updateRangeFill(lsRange);
    applyTextStyle();
  });
  alignSelect.addEventListener('change', () => { state.style.align = alignSelect.value; applyTextStyle(); });
  widthRange.addEventListener('input', () => {
    state.style.boxW = Number(widthRange.value);
    widthVal.textContent = state.style.boxW + '%';
    updateRangeFill(widthRange);
    applyTextStyle();
    liveRegionUpdate();
  });
  widthRange.addEventListener('change', () => {
    sampleRegion();
    if (state.hasResult) generate({ silent: true });
  });
  [[strokeToggle, 'stroke'], [shadowToggle, 'shadow']].forEach(([btn, key]) => {
    btn.addEventListener('click', () => {
      state.style[key] = !state.style[key];
      btn.setAttribute('aria-checked', String(state.style[key]));
      renderPreview();
    });
  });
  scrimToggle.addEventListener('click', () => {
    state.style.scrim = !state.style.scrim;
    state.scrimManual = true;
    scrimToggle.setAttribute('aria-checked', String(state.style.scrim));
    renderPreview();
    renderContrastStrip();
  });
  resetBtn.addEventListener('click', () => {
    state.style = { ...DEFAULTS.style };
    state.pos = { x: 0.5, y: 0.5 };
    state.customFgHex = null;
    sizeRange.value = state.style.size; sizeVal.textContent = state.style.size;
    weightSelect.value = state.style.weight;
    lhRange.value = Math.round(state.style.lh * 100); lhVal.textContent = state.style.lh.toFixed(2);
    lsRange.value = Math.round(state.style.ls * 100); lsVal.textContent = state.style.ls.toFixed(2) + 'em';
    alignSelect.value = state.style.align;
    widthRange.value = state.style.boxW; widthVal.textContent = state.style.boxW + '%';
    [sizeRange, lhRange, lsRange, widthRange].forEach(updateRangeFill);
    strokeToggle.setAttribute('aria-checked', 'true');
    shadowToggle.setAttribute('aria-checked', 'true');
    scrimToggle.setAttribute('aria-checked', 'false');
    state.scrimManual = false;
    applyPosition();
    sampleRegion();
    if (state.hasResult) generate({ silent: true });
    else { renderPreview(); renderContrastStrip(); }
    toast('已恢复默认排版');
  });

  /* ================= ⑱ 交互：原色驱动增强 ================= */
  function setSourceColor(rgb, resetSliders) {
    if (!rgb) return;
    state.srcColor = rgb.slice();
    if (resetSliders) { state.enhanceL = 0; state.enhanceC = 0; enhanceL.value = 0; enhanceC.value = 0; }
    srcChip.style.background = rgbToHex(rgb);
    srcHex.textContent = rgbToHex(rgb);
    const hsl = rgbToHsl(rgb);
    srcHsl.textContent = 'H ' + Math.round(hsl.h) + '° · S ' + Math.round(hsl.s) + '% · L ' + Math.round(hsl.l) + '%';
    valL.textContent = Math.round(state.enhanceL) + '%';
    valC.textContent = Math.round(state.enhanceC) + '%';
    renderVariantRow();
  }
  function enhanceCurrent() {
    if (!state.srcColor) return state.srcColor;
    const dL = (state.enhanceL / 100) * 0.12;
    const dC = (state.enhanceC / 100) * 0.08;
    return enhanceColor(state.srcColor, dL, dC, 0);
  }
  function renderVariantRow() {
    variantRow.innerHTML = '';
    if (!state.srcColor) return;
    const variants = generateVariants(enhanceCurrent());
    variants.forEach((v) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'variant-chip';
      el.style.background = v.hex;
      el.textContent = v.hex;
      el.title = v.label + ' · ' + v.hex;
      el.addEventListener('click', () => {
        state.customFgHex = v.hex;
        renderPreview();
        renderContrastStrip();
        navigator.clipboard?.writeText(v.hex).catch(() => {});
        toast('已应用 ' + v.hex + '（' + v.label + '）并复制');
      });
      variantRow.appendChild(el);
    });
  }
  function togglePicking() {
    state.picking = !state.picking;
    frame.classList.toggle('is-picking', state.picking);
    srcPickBtn.classList.toggle('is-active', state.picking);
    if (state.picking) toast('点击图片任意位置吸取颜色');
  }
  function pickColorFromImage(clientX, clientY) {
    if (!state.img || !previewImg.naturalWidth) return null;
    const rect = previewImg.getBoundingClientRect();
    const x = clamp(Math.round((clientX - rect.left) / rect.width * state.img.naturalWidth), 0, state.img.naturalWidth - 1);
    const y = clamp(Math.round((clientY - rect.top) / rect.height * state.img.naturalHeight), 0, state.img.naturalHeight - 1);
    const cv = document.createElement('canvas');
    cv.width = state.img.naturalWidth; cv.height = state.img.naturalHeight;
    const g = cv.getContext('2d');
    g.drawImage(state.img, 0, 0);
    const d = g.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  srcPickBtn.addEventListener('click', togglePicking);
  frame.addEventListener('click', (ev) => {
    if (!state.picking) return;
    const rgb = pickColorFromImage(ev.clientX, ev.clientY);
    if (rgb) { setSourceColor(rgb, true); togglePicking(); toast('已吸取颜色 ' + rgbToHex(rgb)); }
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.picking) togglePicking(); });
  enhanceL.addEventListener('input', () => { state.enhanceL = +enhanceL.value; valL.textContent = Math.round(state.enhanceL) + '%'; renderVariantRow(); });
  enhanceC.addEventListener('input', () => { state.enhanceC = +enhanceC.value; valC.textContent = Math.round(state.enhanceC) + '%'; renderVariantRow(); });
  resetSourceBtn.addEventListener('click', () => {
    if (state.palette && state.palette[0]) setSourceColor(state.palette[0].rgb, true);
    else toast('请先载入图片');
  });

  /* ================= ⑲ 上传 / 示例 / 拖放 / 粘贴 ================= */
  dzPick.addEventListener('click', () => fileInput.click());
  replaceBtn.addEventListener('click', () => fileInput.click());
  [sampleBtn, dzSample].forEach((b) => b.addEventListener('click', () => loadImageSrc(makeSampleImage())));
  reanalyzeBtn.addEventListener('click', () => {
    if (!state.img) return;
    analyzeImage();
    setSourceColor(state.palette[0] ? state.palette[0].rgb : null, true);
    if (state.hasResult) generate({ silent: true, toastMsg: '已重新分析图片并更新配色' });
    else { renderAll(); toast('已重新分析图片'); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) => {
    stage.addEventListener(t, (ev) => { ev.preventDefault(); dropzone.classList.add('is-over'); });
  });
  stage.addEventListener('dragleave', (ev) => {
    if (!stage.contains(ev.relatedTarget)) dropzone.classList.remove('is-over');
  });
  stage.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dropzone.classList.remove('is-over');
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  window.addEventListener('paste', (ev) => {
    const items = ev.clipboardData && ev.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && OK_TYPES.includes(items[i].type)) {
        const f = items[i].getAsFile();
        if (f) { handleFile(f); ev.preventDefault(); break; }
      }
    }
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    applyTextStyle();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sampleRegion();
      if (state.hasResult) generate({ silent: true });
      else renderContrastStrip();
    }, 250);
  });

  /* ================= ⑳ 导出 ================= */
  function cssVars() {
    const s = activeScheme();
    if (!s) return '';
    const lines = [':root {', '  /* ' + s.name + ' · ' + s.tag + ' · CHROMA */'];
    s.colors.forEach((c, i) => lines.push('  --chroma-' + (i + 1) + ': ' + c.hex + '; /* ' + (c.use || '点缀') + ' · ' + c.status + ' */'));
    const role = (u) => { const c = s.colors.find((x) => x.use === u); return c ? c.hex : '#000000'; };
    lines.push('  --chroma-title: ' + role('主标题') + ';');
    lines.push('  --chroma-body: ' + role('正文') + ';');
    lines.push('  --chroma-accent: ' + role('强调') + ';');
    lines.push('}');
    return lines.join('\n');
  }
  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  }
  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function roundRectPath(x, rx, ry, w, h, r) {
    if (x.roundRect) { x.beginPath(); x.roundRect(rx, ry, w, h, r); return; }
    x.beginPath();
    x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r);
    x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r);
    x.arcTo(rx, ry, rx + w, ry, r);
    x.closePath();
  }
  function exportPng() {
    const s = activeScheme();
    if (!s || !s.colors.length) return;
    const colors = s.colors;
    const cw = 200, ch = 120, pad = 28, gap = 16, rows = Math.ceil(colors.length / 4);
    const W = pad * 2 + Math.min(colors.length, 4) * cw + (Math.min(colors.length, 4) - 1) * gap;
    const H = pad * 2 + rows * (ch + 66) - 66 + 50;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#f4f4f6';
    x.font = '600 20px system-ui, -apple-system, "PingFang SC", sans-serif';
    x.fillText(s.name + ' · ' + s.tag, pad, pad + 8);
    colors.forEach((cl, i) => {
      const col = i % 4, row = Math.floor(i / 4);
      const bx = pad + col * (cw + gap);
      const by = pad + 30 + row * (ch + 66);
      x.fillStyle = cl.hex;
      roundRectPath(x, bx, by, cw, ch, 14); x.fill();
      x.fillStyle = inkOf(cl.rgb);
      x.font = '600 26px system-ui, sans-serif';
      x.fillText('Aa', bx + 14, by + 44);
      x.textBaseline = 'top';
      x.fillStyle = '#f4f4f6';
      x.font = '600 15px system-ui, -apple-system, "PingFang SC", sans-serif';
      x.fillText((cl.use || '点缀') + ' · ' + cl.status, bx, by + ch + 10);
      x.fillStyle = '#a3a3af';
      x.font = '14px ui-monospace, Menlo, Consolas, monospace';
      x.fillText(cl.hex + '  ' + cl.worstC.toFixed(1) + ':1', bx, by + ch + 32);
      x.textBaseline = 'alphabetic';
    });
    downloadCanvas(c, 'chroma-scheme.png');
    toast('已导出色卡 PNG');
  }
  function exportJson() {
    const s = activeScheme();
    if (!s) return;
    const data = {
      tool: 'CHROMA',
      generatedAt: new Date().toISOString(),
      image: state.img ? { width: state.img.naturalWidth, height: state.img.naturalHeight } : null,
      bgType: state.bgType,
      mood: state.mood && { id: state.mood.id, label: state.mood.label, confidence: state.mood.confidence, matched: state.mood.matched },
      copy: state.copy,
      global: state.global && {
        meanLum: +state.global.meanLum.toFixed(4), warmCool: +state.global.warmCool.toFixed(3),
        complexity: +state.global.complexity.toFixed(3), satMean: Math.round(state.global.satMean),
        dominant: rgbToHex(state.global.dominantRgb), mean: rgbToHex(state.global.meanRgb),
      },
      textRegion: state.region && {
        meanLum: +state.region.meanLum.toFixed(4), lumP50: +state.region.lumP50.toFixed(4),
        lumStd: +state.region.lumStd.toFixed(4), complexity: +state.region.complexity.toFixed(3),
        warmCool: +state.region.warmCool.toFixed(3), isComplex: state.region.isComplex,
        mean: rgbToHex(state.region.meanRgb), bright: rgbToHex(state.region.brightRgb), dark: rgbToHex(state.region.darkRgb),
      },
      schemes: state.schemes.map((sc) => ({
        id: sc.id, name: sc.name, tag: sc.tag, desc: sc.desc, mood: sc.mood || null,
        colors: sc.colors.map((c) => ({
          hex: c.hex, rgb: c.rgb, hsl: c.hsl, okL: c.okL, sat: c.sat,
          use: c.use || '点缀', status: c.status, contrastAvg: c.avgC, contrastWorst: c.worstC, reason: c.reason,
        })),
      })),
      currentScheme: s.id,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'chroma-analysis.json');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出分析 JSON');
  }
  copyHexBtn.addEventListener('click', () => {
    const s = activeScheme();
    if (s && s.colors.length) copyText(s.colors.map((c) => c.hex).join(', '), '已复制 ' + s.colors.length + ' 个色值');
  });
  copyCssBtn.addEventListener('click', () => copyText(cssVars(), '已复制整套 CSS 变量'));
  pngBtn.addEventListener('click', exportPng);
  jsonBtn.addEventListener('click', exportJson);

  /* ================= ㉑ 初始化 ================= */
  [sizeRange, lhRange, lsRange, widthRange].forEach(updateRangeFill);
  renderMoodChips();
  renderMoodRead();

  /* 测试钩子：供自动化验收调用，不影响正常使用 */
  window.__IPS = {
    load: loadImageSrc,
    sample: () => loadImageSrc(makeSampleImage()),
    setCopy(text) { copyInput.value = text; renderMoodRead(); },
    setMood(id) { state.moodHint = id; renderMoodChips(); renderMoodRead(); },
    generate() { generate({ silent: true }); },
    setPos(x, y) {
      state.pos = { x: clamp(x, 0.02, 0.98), y: clamp(y, 0.02, 0.98) };
      applyPosition(); sampleRegion();
      if (state.hasResult) generate({ silent: true });
    },
    get() {
      const pc = previewColors();
      return {
        hasResult: state.hasResult,
        palette: state.palette.map((e) => e.hex),
        bgType: state.bgType && { type: state.bgType.type, label: state.bgType.label, mode: state.bgType.mode },
        global: state.global && { meanLum: +state.global.meanLum.toFixed(3), warmCool: +state.global.warmCool.toFixed(2), complexity: +state.global.complexity.toFixed(2), satMean: Math.round(state.global.satMean) },
        region: state.region && { meanLum: +state.region.meanLum.toFixed(3), complexity: +state.region.complexity.toFixed(2), isComplex: state.region.isComplex },
        mood: state.mood && { id: state.mood.id, label: state.mood.label, confidence: state.mood.confidence, neutral: state.mood.neutral, matched: state.mood.matched },
        copy: state.copy,
        activeScheme: state.activeScheme,
        preview: pc && { title: pc.title.hex, body: pc.body.hex, accent: pc.accent.hex },
        schemes: state.schemes.map((s) => ({
          id: s.id, name: s.name, tag: s.tag, mood: s.mood || null, n: s.colors.length,
          roles: { title: (roleColor(s, '主标题') || {}).hex, body: (roleColor(s, '正文') || {}).hex, accent: (roleColor(s, '强调') || {}).hex },
          colors: s.colors.map((c) => ({ hex: c.hex, use: c.use || '点缀', status: c.status, worst: c.worstC, avg: c.avgC })),
        })),
      };
    },
  };
})();
