/* =========================================================
   Image Palette Studio · 基于背景图像的智能文字配色
   ---------------------------------------------------------
   管线：载入图片 → 全图取色(OKLab) → 亮度图 → 文字框区域分析
        → 候选生成 → 评分过滤 → 三套方案 → 实时排版预览
   纯前端：Canvas 读取像素，本地计算，图片不离开浏览器。
   算法纯函数在 color-core.js（UMD），单元测试见 tests/。
   ========================================================= */
(function () {
  'use strict';

  /* ================= ① DOM 引用 ================= */
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone'), fileInput = $('fileInput');
  const pickBtn = $('pickBtn'), dzPick = $('dzPick');
  const sampleBtn = $('sampleBtn'), dzSample = $('dzSample');
  const reanalyzeBtn = $('reanalyzeBtn');
  const stage = $('stage'), frame = $('frame'), previewImg = $('previewImg');
  const overlay = $('overlay'), overlayText = $('overlayText'), overlayScrim = $('overlayScrim'), frameHint = $('frameHint');
  const ovTitle = $('ovTitle'), ovSub = $('ovSub'), ovBody = $('ovBody'), ovAux = $('ovAux');
  const controls = $('controls');
  const titleInput = $('titleInput'), subInput = $('subInput'), bodyInput = $('bodyInput'), auxInput = $('auxInput');
  const sizeRange = $('sizeRange'), sizeVal = $('sizeVal');
  const weightSelect = $('weightSelect');
  const lhRange = $('lhRange'), lhVal = $('lhVal');
  const lsRange = $('lsRange'), lsVal = $('lsVal');
  const alignSelect = $('alignSelect');
  const widthRange = $('widthRange'), widthVal = $('widthVal');
  const opacityRange = $('opacityRange'), opacityVal = $('opacityVal');
  const strokeToggle = $('strokeToggle'), shadowToggle = $('shadowToggle'), scrimToggle = $('scrimToggle');
  const colorSel = $('colorSel'), resetBtn = $('resetBtn');
  const ratioVal = $('ratioVal'), worstVal = $('worstVal'), ratioBadge = $('ratioBadge');
  const fgSwatch = $('fgSwatch'), fgHex = $('fgHex'), bgSwatch = $('bgSwatch'), bgHex = $('bgHex');
  const extBrightSwatch = $('extBrightSwatch'), extBrightHex = $('extBrightHex');
  const extDarkSwatch = $('extDarkSwatch'), extDarkHex = $('extDarkHex');
  const regionNote = $('regionNote');
  const analysisSize = $('analysisSize'), domColors = $('domColors'), domDetail = $('domDetail');
  const lumBar = $('lumBar'), hiPct = $('hiPct'), midPct = $('midPct'), shPct = $('shPct');
  const warmTag = $('warmTag'), complexTag = $('complexTag'), lumTag = $('lumTag');
  const schemeTabs = $('schemeTabs'), schemeDesc = $('schemeDesc'), schemeColorsEl = $('schemeColors'), schemeCount = $('schemeCount');
  const copyHexBtn = $('copyHexBtn'), copyCssBtn = $('copyCssBtn'), pngBtn = $('pngBtn'), jsonBtn = $('jsonBtn');
  const toastEl = $('toast');
  /* 原色驱动调整器 DOM */
  const srcChip = $('srcChip'), srcHex = $('srcHex'), srcHsl = $('srcHsl'), srcPickBtn = $('srcPickBtn');
  const enhanceL = $('enhanceL'), valL = $('valL'), enhanceC = $('enhanceC'), valC = $('valC');
  const variantRow = $('variantRow'), resetSourceBtn = $('resetSourceBtn');

  /* ================= ② 状态 ================= */
  const STAGE_BG = [20, 20, 25]; // 页面舞台底色：透明 PNG 按预览实际背景合成
  const SCRIM_ALPHA = 0.55;     // 文字底衬不透明度（读数与渲染共用）
  const DEFAULTS = {
    text: {
      title: '在山与海之间',
      sub: 'A JOURNEY BETWEEN MOUNTAINS AND SEA',
      body: '把文字放进画面里，检验它是否真的被读到。拖动文字框，对比度与推荐会随位置实时更新。',
      aux: 'IMAGE PALETTE STUDIO · 2026',
    },
    style: { size: 64, weight: '600', lh: 1.35, ls: 0, align: 'center', boxW: 62, opacity: 100, stroke: true, shadow: true, scrim: false },
  };
  const state = {
    img: null,
    palette: [],            // 全图取色 [{hex,rgb,hsl,pct,name}]
    global: null,           // 整图分析（analyzeRegion 结果）
    region: null,           // 文字框区域分析
    lum: null,              // 亮度图 {w,h,lum,rgb}
    schemes: [],            // 三套方案
    activeScheme: 1,        // 默认落在「高对比度文字色」——为可读性设计的成套方案
    previewSel: -1,         // 预览用色（-1 = 跟随方案角色）
    text: { ...DEFAULTS.text },
    style: { ...DEFAULTS.style },
    pos: { x: 0.5, y: 0.5 },
    /* 原色驱动调整器状态 */
    srcColor: null,         // 当前原始色 [r,g,b]
    enhanceL: 0,            // 明度增强滑块（-30~30 表示 -30%~+30%）
    enhanceC: 0,            // 色度增强滑块
    picking: false,         // 是否处于吸色模式
    customFgHex: null,      // 变体一键应用的自定义前景色（覆盖方案默认）
  };
  let objectUrl = null;
  let previewToken = 0;

  const {
    clamp, hexToRgb, rgbToHex, rgbToHsl, rgbToHsv, relLum, contrast, levelOf, nameOf,
    rgbToOklab, oklabToRgb, kmeansLab, mergeClose, analyzeRegion, evaluateOnRegion,
    contrastStatus, buildSchemes,
    /* 原色驱动增强层 */
    oklabToOklch, oklchToOklab, gamutMap, enhanceColor, enhancementDegree, generateVariants,
  } = window.ColorCore;

  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';

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
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-show'), 1800);
  }
  function updateRangeFill(el) {
    const min = Number(el.min), max = Number(el.max), v = Number(el.value);
    el.style.setProperty('--fill', (((v - min) / (max - min)) * 100) + '%');
  }
  const inkOf = (rgb) => (relLum(rgb) > 0.5 ? '#0A0A0C' : '#FFFFFF');

  /* ================= ④ 取色（OKLab 感知空间） ================= */
  function extractPalette(img, k) {
    const W = 220;
    const scale = Math.min(1, W / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = `rgb(${STAGE_BG.join(',')})`; // 透明像素按预览实际背景合成
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
      const rgb = oklabToRgb(cl.lab);
      return {
        rgb, hex: rgbToHex(rgb), hsl: rgbToHsl(rgb),
        pct: Math.max(1, Math.round((cl.n / total) * 100)), name: nameOf(rgb),
      };
    });
  }

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

  /* ================= ⑤ 区域分析 ================= */
  /* 文字框覆盖的图像区域（归一化坐标） */
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
  function sampleRegion() {
    if (!state.lum) return;
    const b = regionBounds();
    if (!b) return;
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

  /* ================= ⑥ 方案构建 ================= */
  function rebuildSchemes() {
    if (!state.region || !state.palette.length) return;
    state.schemes = buildSchemes(state.palette, state.region, state.global);
    const cur = state.schemes[state.activeScheme];
    if (state.previewSel >= cur.colors.length) state.previewSel = -1;
    renderSchemeTabs();
    renderSchemeColors();
    refreshColorSel();
    renderPreview();
    updateReadout();
  }

  /* ================= ⑦ 渲染：背景分析 ================= */
  function renderAnalysis() {
    const p = state.palette;
    if (!p.length || !state.global) return;
    analysisSize.textContent = state.img.naturalWidth + '×' + state.img.naturalHeight;
    domColors.innerHTML = '';
    p.forEach((e, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dom-chip' + (i === 0 ? ' is-main' : '');
      chip.style.background = e.hex;
      chip.style.color = inkOf(e.rgb);
      chip.title = e.name + ' ' + e.hex + ' · 占比 ' + e.pct + '%';
      chip.innerHTML = '<span>' + e.pct + '%</span>';
      chip.addEventListener('click', () => copyText(e.hex, '已复制 ' + e.hex));
      domColors.appendChild(chip);
    });
    const g = state.global;
    const d = p[0];
    const hsv = rgbToHsv(d.rgb);
    domDetail.innerHTML =
      '<div><em>主色</em><b>' + d.hex + '</b></div>' +
      '<div><em>RGB</em><b>' + d.rgb.join(', ') + '</b></div>' +
      '<div><em>HSL</em><b>' + Math.round(d.hsl.h) + ', ' + Math.round(d.hsl.s) + ', ' + Math.round(d.hsl.l) + '</b></div>' +
      '<div><em>HSV</em><b>' + Math.round(hsv.h) + ', ' + Math.round(hsv.s) + ', ' + Math.round(hsv.v) + '</b></div>' +
      '<div><em>感知明度 L*</em><b>' + Math.round(rgbToOklab(d.rgb)[0] * 100) + '</b></div>' +
      '<div><em>平均饱和</em><b>' + Math.round(g.satMean) + '%</b></div>';
    const hi = Math.round(g.highlightRatio * 100);
    const sh = Math.round(g.shadowRatio * 100);
    const mid = Math.max(0, 100 - hi - sh);
    lumBar.children[0].style.width = hi + '%';
    lumBar.children[1].style.width = mid + '%';
    lumBar.children[2].style.width = sh + '%';
    hiPct.textContent = hi + '%';
    midPct.textContent = mid + '%';
    shPct.textContent = sh + '%';
    warmTag.textContent = g.warmCool > 0.15 ? '偏暖 ' + Math.round(g.warmCool * 100) : g.warmCool < -0.15 ? '偏冷 ' + Math.round(-g.warmCool * 100) : '中性';
    complexTag.textContent = g.complexity < 0.25 ? '简洁' : g.complexity < 0.5 ? '适中' : '复杂';
    lumTag.textContent = g.meanLum > 0.5 ? '浅' : g.meanLum > 0.18 ? '中' : '深';
  }

  /* ================= ⑧ 渲染：方案卡片 ================= */
  function renderSchemeTabs() {
    schemeTabs.querySelectorAll('.stab').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.s) === state.activeScheme);
    });
    const s = state.schemes[state.activeScheme];
    if (!s) return;
    schemeDesc.textContent = s.desc;
    schemeCount.textContent = s.colors.length + ' 色 · ' + s.tag;
  }

  function renderSchemeColors() {
    const s = state.schemes[state.activeScheme];
    schemeColorsEl.innerHTML = '';
    if (!s || !s.colors.length) {
      schemeColorsEl.innerHTML = '<div class="palette-empty"><span class="palette-empty-mark"></span><p>载入图片后，这里会给出三套可直接用于排版的文字配色。</p></div>';
      return;
    }
    const useCount = {};
    s.colors.forEach((c) => { const u = c.use || '点缀'; useCount[u] = (useCount[u] || 0) + 1; });
    const seenUse = {};
    s.colors.forEach((c, i) => {
      const use = c.use || '点缀';
      seenUse[use] = (seenUse[use] || 0) + 1;
      const useLabel = useCount[use] > 1 ? use + ' ' + seenUse[use] : use;
      const card = document.createElement('div');
      card.className = 'scard';
      card.dataset.i = i;
      card.tabIndex = 0;
      card.style.animationDelay = (i * 0.035) + 's';
      card.innerHTML =
        '<span class="scard-chip" style="background:' + c.hex + ';color:' + inkOf(c.rgb) + '">Aa</span>' +
        '<div class="scard-main">' +
          '<div class="scard-top"><b>' + nameOf(c.rgb) + '</b><span class="scard-use">' + useLabel + '</span>' +
            '<span class="badge ' + c.statusCls + '">' + c.status + '</span></div>' +
          '<div class="scard-hex mono">' + c.hex +
            '<button class="icon-btn" data-copy type="button" aria-label="复制 ' + c.hex + '">' + ICON_COPY + '</button>' +
            '<button class="icon-btn" data-apply type="button" aria-label="用作预览文字颜色" title="用作预览文字颜色">' + ICON_EYE + '</button>' +
          '</div>' +
          '<div class="scard-vals mono">RGB ' + c.rgb.join(',') + ' · HSL ' + c.hsl.h + ',' + c.hsl.s + ',' + c.hsl.l + '</div>' +
          '<div class="scard-vals mono dim">感知明度 ' + c.okL + ' · 饱和 ' + c.sat + ' · 对比 ' + c.avgC.toFixed(1) + ':1 <i>（最不利 ' + c.worstC.toFixed(1) + ':1）</i></div>' +
          '<p class="scard-reason">' + c.reason + '。</p>' +
        '</div>';
      schemeColorsEl.appendChild(card);
    });
  }

  /* ================= ⑨ 渲染：排版预览 ================= */
  function activeScheme() { return state.schemes[state.activeScheme] || null; }

  function lineColors() {
    /* 变体一键应用的自定义前景色覆盖所有四行 */
    if (state.customFgHex) {
      const rgb = hexToRgb(state.customFgHex);
      const c = { rgb, hex: state.customFgHex, use: '自定义', worst: 0, avg: 0 };
      return { title: c, sub: c, body: c, aux: c };
    }
    const s = activeScheme();
    if (!s || !s.colors.length) return null;
    if (state.previewSel >= 0 && s.colors[state.previewSel]) {
      const c = s.colors[state.previewSel];
      return { title: c, sub: c, body: c, aux: c };
    }
    const byUse = {};
    s.colors.forEach((c) => { const u = c.use || '点缀'; if (!byUse[u]) byUse[u] = c; });
    const byWorst = s.colors.slice().sort((a, b) => b.worstC - a.worstC);
    const pick = (u) => byUse[u] || byWorst[0];
    return { title: pick('主标题'), sub: pick('副标题'), body: pick('正文'), aux: pick('辅助信息') };
  }

  function currentFgColor() {
    const lc = lineColors();
    return lc ? lc.body : null;
  }

  function decorate(el, c) {
    el.style.color = c.hex;
    const S = state.style;
    const shadows = [];
    const dark = relLum(c.rgb) > 0.4; // 亮字配深色衬，暗字配浅色衬
    if (S.shadow) {
      shadows.push(dark
        ? '0 1px 2px rgba(0,0,0,.55), 0 2px 14px rgba(0,0,0,.42)'
        : '0 1px 2px rgba(255,255,255,.5), 0 2px 14px rgba(0,0,0,.30)');
    }
    if (S.stroke) {
      const sc = dark ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.72)';
      const r = 0.028;
      [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([dx, dy]) => {
        shadows.push((dx * r).toFixed(3) + 'em ' + (dy * r).toFixed(3) + 'em 0 ' + sc);
      });
    }
    el.style.textShadow = shadows.length ? shadows.join(', ') : 'none';
  }

  function renderPreview() {
    const lc = lineColors();
    ovTitle.textContent = state.text.title || ' ';
    ovSub.textContent = state.text.sub || ' ';
    ovBody.textContent = state.text.body || ' ';
    ovAux.textContent = state.text.aux || ' ';
    if (lc) {
      decorate(ovTitle, lc.title);
      decorate(ovSub, lc.sub);
      decorate(ovBody, lc.body);
      decorate(ovAux, lc.aux);
    }
    const S = state.style;
    overlayScrim.hidden = !S.scrim;
    if (S.scrim && lc) {
      const light = relLum(lc.body.rgb) > 0.35;
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
    ovTitle.style.fontSize = clamp(S.size * k, 10, 260).toFixed(1) + 'px';
    ovSub.style.fontSize = clamp(S.size * 0.42 * k, 8, 130).toFixed(1) + 'px';
    ovBody.style.fontSize = clamp(S.size * 0.30 * k, 8, 96).toFixed(1) + 'px';
    ovAux.style.fontSize = clamp(S.size * 0.22 * k, 7, 72).toFixed(1) + 'px';
    [ovTitle, ovSub, ovBody, ovAux].forEach((el) => {
      el.style.fontWeight = S.weight;
      el.style.lineHeight = S.lh;
      el.style.letterSpacing = S.ls.toFixed(2) + 'em';
    });
    overlay.style.width = S.boxW + '%';
    overlayText.style.textAlign = S.align;
    overlayText.style.opacity = S.opacity / 100;
  }

  function applyPosition() {
    overlay.style.left = (state.pos.x * 100) + '%';
    overlay.style.top = (state.pos.y * 100) + '%';
  }

  /* ================= ⑩ 可读性读数 ================= */
  function scrimFor(rgb) {
    return state.style.scrim ? { dark: relLum(rgb) > 0.35, alpha: SCRIM_ALPHA } : null;
  }

  function updateReadout() {
    if (!state.region || !state.lum) return;
    const fg = currentFgColor();
    if (!fg) return;
    const ev = evaluateOnRegion(fg.rgb, state.region, scrimFor(fg.rgb));
    const evRaw = evaluateOnRegion(fg.rgb, state.region, null);
    const lv = contrastStatus(ev.worst);
    ratioVal.textContent = ev.avg.toFixed(2) + ':1';
    worstVal.textContent = ev.worst.toFixed(2) + ':1';
    ratioBadge.textContent = lv.label;
    ratioBadge.className = 'badge ' + lv.cls;
    fgSwatch.style.background = fg.hex; fgHex.textContent = fg.hex;
    bgSwatch.style.background = rgbToHex(state.region.meanRgb);
    bgHex.textContent = rgbToHex(state.region.meanRgb);
    extBrightSwatch.style.background = rgbToHex(state.region.brightRgb);
    extBrightHex.textContent = rgbToHex(state.region.brightRgb);
    extDarkSwatch.style.background = rgbToHex(state.region.darkRgb);
    extDarkHex.textContent = rgbToHex(state.region.darkRgb);
    const complex = state.region.isComplex;
    if (complex && evRaw.worst < 3) {
      regionNote.hidden = false;
      regionNote.className = 'region-note is-warn';
      regionNote.textContent = state.style.scrim
        ? '该区域明暗跨度较大：加底衬后最不利对比 ' + ev.worst.toFixed(1) + ':1（纯文字为 ' + evRaw.worst.toFixed(1) + ':1），已明显改善。'
        : '该区域明暗跨度较大，纯文字最不利处仅 ' + evRaw.worst.toFixed(1) + ':1。建议开启底衬 / 描边，或把文字框移到更均匀的画面。';
    } else if (complex) {
      regionNote.hidden = false;
      regionNote.className = 'region-note is-info';
      regionNote.textContent = state.style.scrim
        ? '加底衬后最不利对比 ' + ev.worst.toFixed(1) + ':1（纯文字为 ' + evRaw.worst.toFixed(1) + ':1）。'
        : '该区域包含明暗两端，已按最不利处给出对比度评级。';
    } else {
      regionNote.hidden = true;
    }
  }

  /* ================= ⑩·5 原色驱动调整器 ================= */
  /* setSourceColor：设置原始色并渲染整个面板（色块 + HEX + HSL + 滑块 + 变体网格） */
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
  /* enhanceCurrent：根据当前 L/C 滑块值，把 enhanceColor 的 ΔL/ΔC 映射到 OKLCH 增量 */
  function enhanceCurrent() {
    if (!state.srcColor) return state.srcColor;
    /* 滑块 ±30 表示 OKLCH 上 ΔL ±0.12、ΔC ±0.08 */
    const dL = (state.enhanceL / 100) * 0.12;
    const dC = (state.enhanceC / 100) * 0.08;
    return enhanceColor(state.srcColor, dL, dC, 0);
  }
  /* renderVariantRow：用 color-core 的 generateVariants 渲染 10 个变体（8 正向 + 2 横跨） */
  function renderVariantRow() {
    variantRow.innerHTML = '';
    if (!state.srcColor) return;
    const baseRgb = enhanceCurrent();
    const variants = generateVariants(baseRgb);
    variants.forEach((v) => {
      const isCross = (v.key || '').startsWith('cross');
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'variant-chip';
      el.style.background = v.hex;
      el.dataset.hex = v.hex;
      if (isCross) el.dataset.cross = 'true';
      el.textContent = v.hex;
      el.title = v.label + ' · ' + v.hex + '\nΔL=' + v.degree.dL.toFixed(2) + ' ΔC=' + v.degree.dC.toFixed(2);
      el.addEventListener('click', () => {
        state.customFgHex = v.hex;                 /* 一键应用到预览文字 */
        state.previewSel = -1;
        colorSel.value = '-1';
        renderPreview(); updateReadout();
        navigator.clipboard?.writeText(v.hex).catch(() => {});
        toast('已应用 ' + v.hex + '（' + v.label + '）并复制');
      });
      variantRow.appendChild(el);
    });
  }
  /* 吸色模式 */
  function togglePicking() {
    state.picking = !state.picking;
    frame.classList.toggle('is-picking', state.picking);
    srcPickBtn.classList.toggle('is-active', state.picking);
    if (state.picking) toast('点击图片任意位置吸取颜色');
  }
  /* 从图片点击坐标取色（坐标映射：previewImg 显示坐标 → 原图像素） */
  function pickColorFromImage(clientX, clientY) {
    if (!state.img || !previewImg.naturalWidth) return null;
    const rect = previewImg.getBoundingClientRect();
    const x = Math.round((clientX - rect.left) / rect.width * state.img.naturalWidth);
    const y = Math.round((clientY - rect.top) / rect.height * state.img.naturalHeight);
    /* 从原图像素取色：临时画到隐藏 canvas → getImageData */
    const cv = document.createElement('canvas');
    cv.width = state.img.naturalWidth; cv.height = state.img.naturalHeight;
    const g = cv.getContext('2d');
    g.drawImage(state.img, 0, 0);
    const d = g.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /* ================= ⑪ 渲染调度 ================= */
  function refreshColorSel() {
    const s = activeScheme();
    colorSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '-1';
    optAll.textContent = '跟随方案角色';
    colorSel.appendChild(optAll);
    if (!s) return;
    s.colors.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = (c.use || '点缀') + ' · ' + c.hex + ' · ' + c.status;
      colorSel.appendChild(o);
    });
    colorSel.value = String(state.previewSel);
  }

  function enableTools(on) {
    reanalyzeBtn.disabled = !on;
    const has = on && state.schemes.length > 0;
    [copyHexBtn, copyCssBtn, pngBtn, jsonBtn].forEach((b) => { b.disabled = !has; });
  }

  function renderAll() {
    renderAnalysis();
    renderSchemeTabs();
    renderSchemeColors();
    refreshColorSel();
    renderPreview();
    applyPosition();
    requestAnimationFrame(() => {
      applyTextStyle();
      updateReadout();
      enableTools(true);
    });
  }

  /* 当推荐方案的最优正文色在纯文字下仍读不清时，自动加一层半透明底衬兜底（PRD 5.3） */
  function autoScrim() {
    const s = state.schemes[1] || state.schemes[0];
    if (!s || !s.colors.length) return;
    const body = s.colors.find((c) => c.use === '正文')
      || s.colors.slice().sort((a, b) => b.worstC - a.worstC)[0];
    if (!body) return;
    const raw = evaluateOnRegion(body.rgb, state.region, null);
    if (raw.worst < 4.5) state.style.scrim = true;
  }

  function analyzeAll() {
    state.palette = extractPalette(state.img, 7);
    state.lum = buildLumMap(state.img);
    const n = state.lum.w * state.lum.h;
    state.global = analyzeRegion(state.lum.lum, state.lum.rgb);
    sampleRegion();
    state.schemes = buildSchemes(state.palette, state.region, state.global);
    state.previewSel = -1;
    state.style.scrim = false;
    autoScrim();
    scrimToggle.setAttribute('aria-checked', String(state.style.scrim));
    /* 自动把图片主色作为默认原色 */
    setSourceColor(state.palette[0] ? state.palette[0].rgb : null, /* resetSliders */ true);
    renderAll();
  }

  /* ================= ⑫ 图片载入 ================= */
  function onImageReady(img, src) {
    state.img = img;
    const token = ++previewToken;
    let done = false;
    const ready = () => {
      if (token !== previewToken || done) return;
      done = true;
      dropzone.hidden = true;
      frame.hidden = false;
      controls.hidden = false;
      state.pos = { x: 0.5, y: 0.5 };
      frameHint.classList.remove('is-hidden');
      applyPosition();
      analyzeAll();
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
  const OK_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  function handleFile(file) {
    if (!file) return;
    if (!OK_TYPES.includes(file.type)) { toast('仅支持 JPG / PNG / WebP 格式'); return; }
    if (file.size > 25 * 1024 * 1024) { toast('图片超过 25MB，请压缩后再试'); return; }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    loadImageSrc(objectUrl);
  }

  /* 本地生成的示例图（离线可用，不请求网络） */
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

  /* ================= ⑬ 交互 ================= */
  /* 拖动文字框：移动中只刷新读数，松手后按新区域重建推荐 */
  let dragging = false, rafId = 0;
  function liveRegionUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      sampleRegion();
      updateReadout();
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
    rebuildSchemes();
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
    rebuildSchemes();
  });

  /* 文案输入 */
  titleInput.addEventListener('input', () => { state.text.title = titleInput.value; renderPreview(); });
  subInput.addEventListener('input', () => { state.text.sub = subInput.value; renderPreview(); });
  bodyInput.addEventListener('input', () => { state.text.body = bodyInput.value; renderPreview(); });
  auxInput.addEventListener('input', () => { state.text.aux = auxInput.value; renderPreview(); });

  /* 排版样式 */
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
  widthRange.addEventListener('change', () => { sampleRegion(); rebuildSchemes(); });
  opacityRange.addEventListener('input', () => {
    state.style.opacity = Number(opacityRange.value);
    opacityVal.textContent = state.style.opacity + '%';
    updateRangeFill(opacityRange);
    applyTextStyle();
  });
  [[strokeToggle, 'stroke'], [shadowToggle, 'shadow'], [scrimToggle, 'scrim']].forEach(([btn, key]) => {
    btn.addEventListener('click', () => {
      state.style[key] = !state.style[key];
      btn.setAttribute('aria-checked', String(state.style[key]));
      renderPreview();
      updateReadout();
    });
  });

  /* 方案页签 */
  schemeTabs.addEventListener('click', (ev) => {
    const b = ev.target.closest('.stab');
    if (!b) return;
    state.activeScheme = Number(b.dataset.s);
    state.previewSel = -1;
    renderSchemeTabs();
    renderSchemeColors();
    refreshColorSel();
    renderPreview();
    updateReadout();
  });

  /* 预览颜色切换 */
  colorSel.addEventListener('change', () => {
    state.previewSel = Number(colorSel.value);
    renderPreview();
    updateReadout();
  });

  /* 恢复默认排版（保留图片与方案） */
  resetBtn.addEventListener('click', () => {
    state.text = { ...DEFAULTS.text };
    state.style = { ...DEFAULTS.style };
    state.pos = { x: 0.5, y: 0.5 };
    state.previewSel = -1;
    titleInput.value = state.text.title;
    subInput.value = state.text.sub;
    bodyInput.value = state.text.body;
    auxInput.value = state.text.aux;
    sizeRange.value = state.style.size; sizeVal.textContent = state.style.size;
    weightSelect.value = state.style.weight;
    lhRange.value = Math.round(state.style.lh * 100); lhVal.textContent = state.style.lh.toFixed(2);
    lsRange.value = Math.round(state.style.ls * 100); lsVal.textContent = state.style.ls.toFixed(2) + 'em';
    alignSelect.value = state.style.align;
    widthRange.value = state.style.boxW; widthVal.textContent = state.style.boxW + '%';
    opacityRange.value = state.style.opacity; opacityVal.textContent = state.style.opacity + '%';
    [sizeRange, lhRange, lsRange, widthRange, opacityRange].forEach(updateRangeFill);
    strokeToggle.setAttribute('aria-checked', 'true');
    shadowToggle.setAttribute('aria-checked', 'true');
    scrimToggle.setAttribute('aria-checked', 'false');
    refreshColorSel();
    renderPreview();
    applyPosition();
    sampleRegion();
    rebuildSchemes();
    autoScrim();
    scrimToggle.setAttribute('aria-checked', String(state.style.scrim));
    renderPreview();
    updateReadout();
    toast('已恢复默认排版');
  });

  /* ============ 原色驱动调整器事件 ============ */
  srcPickBtn.addEventListener('click', togglePicking);
  frame.addEventListener('click', (ev) => {
    if (!state.picking) return;
    const rgb = pickColorFromImage(ev.clientX, ev.clientY);
    if (rgb) {
      setSourceColor(rgb, true);
      togglePicking();
      toast('已吸取颜色 ' + rgbToHex(rgb));
    }
  });
  frame.addEventListener('click', (ev) => { if (state.picking) ev.stopPropagation(); }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.picking) togglePicking(); });
  enhanceL.addEventListener('input', () => {
    state.enhanceL = +enhanceL.value; renderVariantRow();
  });
  enhanceC.addEventListener('input', () => {
    state.enhanceC = +enhanceC.value; renderVariantRow();
  });
  resetSourceBtn.addEventListener('click', () => {
    if (state.palette && state.palette[0]) setSourceColor(state.palette[0].rgb, true);
    else toast('请先载入图片');
  });

  /* 方案卡片：点卡片复制 HEX，眼睛按钮用作预览色 */
  schemeColorsEl.addEventListener('click', (ev) => {
    const card = ev.target.closest('.scard');
    if (!card) return;
    const i = Number(card.dataset.i);
    const s = activeScheme();
    if (!s) return;
    const c = s.colors[i];
    if (ev.target.closest('[data-apply]')) {
      state.previewSel = i;
      colorSel.value = String(i);
      renderPreview();
      updateReadout();
      toast('预览已换用 ' + c.hex);
      return;
    }
    copyText(c.hex, '已复制 ' + c.hex);
    if (ev.target.closest('[data-copy]')) {
      const btn = ev.target.closest('[data-copy]');
      const original = btn.innerHTML;
      btn.innerHTML = ICON_CHECK;
      btn.style.color = 'var(--ok)';
      setTimeout(() => { btn.innerHTML = original; btn.style.color = ''; }, 1200);
    }
  });
  schemeColorsEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest('.scard');
    if (!card) return;
    ev.preventDefault();
    const c = activeScheme() && activeScheme().colors[Number(card.dataset.i)];
    if (c) copyText(c.hex, '已复制 ' + c.hex);
  });

  /* 上传 / 示例 / 拖放 / 粘贴 */
  [pickBtn, dzPick].forEach((b) => b.addEventListener('click', () => fileInput.click()));
  [sampleBtn, dzSample].forEach((b) => b.addEventListener('click', () => loadImageSrc(makeSampleImage())));
  reanalyzeBtn.addEventListener('click', () => {
    if (!state.img) return;
    analyzeAll();
    toast('已重新分析');
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

  /* 窗口变化：文字框尺寸变了，防抖后按新区域重建 */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    applyTextStyle();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sampleRegion();
      rebuildSchemes();
    }, 250);
  });

  /* ================= ⑭ 导出 ================= */
  function exportColors() {
    const s = activeScheme();
    return s ? s.colors : [];
  }
  function cssVars() {
    const s = activeScheme();
    if (!s) return '';
    const lines = [':root {', '  /* ' + s.name + ' · ' + s.tag + ' · Image Palette Studio */'];
    s.colors.forEach((c, i) => lines.push('  --ips-' + (i + 1) + ': ' + c.hex + '; /* ' + (c.use || '点缀') + ' · ' + c.status + ' */'));
    const role = (u) => {
      const c = s.colors.find((x) => x.use === u);
      return c ? c.hex : '#000000';
    };
    lines.push('  --ips-title: ' + role('主标题') + ';');
    lines.push('  --ips-subtitle: ' + role('副标题') + ';');
    lines.push('  --ips-body: ' + role('正文') + ';');
    lines.push('  --ips-aux: ' + role('辅助信息') + ';');
    lines.push('  --ips-accent: ' + role('强调') + ';');
    lines.push('  --ips-decor: ' + role('装饰') + ';');
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
    const colors = exportColors();
    if (!colors.length) return;
    const s = activeScheme();
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
    downloadCanvas(c, 'image-palette-scheme.png');
    toast('已导出色卡 PNG');
  }
  function exportJson() {
    const s = activeScheme();
    if (!s) return;
    const data = {
      tool: 'Image Palette Studio',
      generatedAt: new Date().toISOString(),
      image: state.img ? { width: state.img.naturalWidth, height: state.img.naturalHeight } : null,
      global: state.global && {
        meanLum: +state.global.meanLum.toFixed(4),
        warmCool: +state.global.warmCool.toFixed(3),
        complexity: +state.global.complexity.toFixed(3),
        highlightRatio: +state.global.highlightRatio.toFixed(3),
        shadowRatio: +state.global.shadowRatio.toFixed(3),
        dominant: rgbToHex(state.global.dominantRgb),
        mean: rgbToHex(state.global.meanRgb),
      },
      textRegion: state.region && {
        meanLum: +state.region.meanLum.toFixed(4),
        lumP50: +state.region.lumP50.toFixed(4),
        lumStd: +state.region.lumStd.toFixed(4),
        complexity: +state.region.complexity.toFixed(3),
        warmCool: +state.region.warmCool.toFixed(3),
        mean: rgbToHex(state.region.meanRgb),
        bright: rgbToHex(state.region.brightRgb),
        dark: rgbToHex(state.region.darkRgb),
      },
      schemes: state.schemes.map((sc) => ({
        id: sc.id, name: sc.name, tag: sc.tag, desc: sc.desc,
        colors: sc.colors.map((c) => ({
          hex: c.hex, rgb: c.rgb, hsl: c.hsl, okL: c.okL, sat: c.sat,
          use: c.use || '点缀', status: c.status,
          contrastAvg: c.avgC, contrastWorst: c.worstC, reason: c.reason,
        })),
      })),
      currentScheme: s.id,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'image-palette-analysis.json');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出分析 JSON');
  }
  copyHexBtn.addEventListener('click', () => {
    const colors = exportColors();
    if (colors.length) copyText(colors.map((c) => c.hex).join(', '), '已复制 ' + colors.length + ' 个色值');
  });
  copyCssBtn.addEventListener('click', () => copyText(cssVars(), '已复制整套 CSS 变量'));
  pngBtn.addEventListener('click', exportPng);
  jsonBtn.addEventListener('click', exportJson);

  /* ================= ⑮ 初始化 ================= */
  [sizeRange, lhRange, lsRange, widthRange, opacityRange].forEach(updateRangeFill);

  /* 测试钩子：供自动化验收调用，不影响正常使用 */
  window.__IPS = {
    load: loadImageSrc,
    setPos(x, y) {
      state.pos = { x: clamp(x, 0.02, 0.98), y: clamp(y, 0.02, 0.98) };
      applyPosition();
      sampleRegion();
      rebuildSchemes();
    },
    get() {
      return {
        palette: state.palette.map((e) => e.hex),
        global: state.global && { meanLum: +state.global.meanLum.toFixed(3), warmCool: +state.global.warmCool.toFixed(2), complexity: +state.global.complexity.toFixed(2) },
        region: state.region && { meanLum: +state.region.meanLum.toFixed(3), complexity: +state.region.complexity.toFixed(2), isComplex: state.region.isComplex },
        readout: { avg: ratioVal.textContent, worst: worstVal.textContent, badge: ratioBadge.textContent },
        lines: (() => {
          const lc = lineColors();
          if (!lc || !state.region) return null;
          const out = {};
          [['title', lc.title], ['sub', lc.sub], ['body', lc.body], ['aux', lc.aux]].forEach(([k, c]) => {
            const ev = evaluateOnRegion(c.rgb, state.region, scrimFor(c.rgb));
            out[k] = { hex: c.hex, use: c.use || '', worst: +ev.worst.toFixed(2), avg: +ev.avg.toFixed(2) };
          });
          return out;
        })(),
        schemes: state.schemes.map((s) => ({
          id: s.id, name: s.name, n: s.colors.length,
          colors: s.colors.map((c) => ({ hex: c.hex, use: c.use || '点缀', status: c.status, worst: c.worstC, avg: c.avgC })),
        })),
      };
    },
  };
})();
