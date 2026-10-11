/* =========================================================
   CHROMA · 图片可读色卡 — 应用逻辑
   ---------------------------------------------------------
   ① 状态   ② 颜色工具   ③ 取色量化(OKLab 感知空间 + 中位切分 + K-means)
   ④ 亮度图 / 文字下方背景采样   ⑤ 图片载入
   ⑥ 渲染色卡   ⑦ 可读性计算与适配   ⑧ 交互   ⑨ 导出
   纯前端实现：Canvas 读取像素，无任何外部依赖。
   色彩算法纯函数抽离至 color-core.js（UMD），单元测试见 tests/color-core.test.js。
   ========================================================= */
(function () {
  'use strict';

  /* ================= ① DOM 引用 ================= */
  const $ = (id) => document.getElementById(id);
  const dropzone     = $('dropzone');
  const fileInput    = $('fileInput');
  const pickBtn      = $('pickBtn');
  const sampleBtn    = $('sampleBtn');
  const stage        = $('stage');
  const frame        = $('frame');
  const previewImg   = $('previewImg');
  const overlay      = $('overlay');
  const overlayText  = $('overlayText');
  const overlayScrim = $('overlayScrim');
  const frameHint    = $('frameHint');
  const controls     = $('controls');
  const textInput    = $('textInput');
  const sizeRange    = $('sizeRange');
  const sizeVal      = $('sizeVal');
  const scrimToggle  = $('scrimToggle');
  const paletteEl    = $('palette');
  const paletteCount = $('paletteCount');
  const countRange   = $('countRange');
  const countVal     = $('countVal');
  const adaptToggle  = $('adaptToggle');
  const ratioVal     = $('ratioVal');
  const ratioBadge   = $('ratioBadge');
  const fgSwatch     = $('fgSwatch');
  const fgHex        = $('fgHex');
  const bgSwatch     = $('bgSwatch');
  const bgHex        = $('bgHex');
  const copyHexBtn   = $('copyHexBtn');
  const copyCssBtn   = $('copyCssBtn');
  const pngBtn       = $('pngBtn');
  const jsonBtn      = $('jsonBtn');
  const toastEl      = $('toast');

  /* ================= ② 状态 ================= */
  const state = {
    img: null,
    palette: [],                 // { hex, rgb, hsl, pct, name, adapted: {hex,rgb}|null }
    active: 0,                   // 当前作为文字色的色卡序号
    adapt: false,                // 可读性适配开关
    scrim: false,                // 文字底衬开关
    count: 6,                    // 取色数量
    fontSize: 48,                // 字号（相对 1000px 宽图片的基准）
    pos: { x: 0.5, y: 0.5 },     // 文字中心在图片中的归一化坐标
    lum: null,                   // 亮度图 { w, h, lum: Float32Array, rgb: Uint8ClampedArray }
    bg: { rgb: [18, 18, 22], lum: 0.01 }, // 文字下方平均背景
  };
  let objectUrl = null;
  let previewToken = 0;

  /* 动态图标（内联 SVG，Lucide 风格，离线可用） */
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  /* ================= ③ 颜色工具 / 取色算法 =================
     纯算法抽离至 color-core.js（UMD 双端模块，tests/ 内有单元测试）：
     RGB/HEX/HSL 互转、WCAG 对比度、sRGB↔OKLab、
     中位切分 + K-means 取色、近似色合并、可读性适配。 */
  const {
    clamp, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, relLum, contrast, levelOf, nameOf,
    rgbToOklab, oklabToRgb, distLab, medianCutLab, kmeansLab, mergeClose, adaptForContrast,
  } = window.ColorCore;

  function extractPalette(img, k) {
    const W = 140;
    const scale = Math.min(1, W / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 125) continue; // 跳过透明像素
      px.push(rgbToOklab([data[i], data[i + 1], data[i + 2]]));
    }
    if (!px.length) return [];
    const total = px.length;
    const clusters = mergeClose(kmeansLab(px, k, 8), 0.04);
    clusters.sort((a, b) => b.n - a.n);
    return clusters.map((cl) => {
      const rgb = oklabToRgb(cl.lab);
      return {
        rgb,
        hex: rgbToHex(rgb),
        hsl: rgbToHsl(rgb),
        pct: Math.max(1, Math.round((cl.n / total) * 100)),
        name: nameOf(rgb),
        adapted: null,
      };
    });
  }

  /* ================= ⑤ 亮度图 & 背景采样 ================= */
  function buildLumMap(img) {
    const W = 96;
    const scale = Math.min(1, W / img.naturalWidth);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
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

  /* 采样文字框下方区域的平均背景 */
  function sampleBg() {
    if (!state.lum) return;
    const ir = previewImg.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();
    if (!ir.width || !ir.height) return;
    const nx0 = clamp((or.left - ir.left) / ir.width, 0, 1);
    const ny0 = clamp((or.top - ir.top) / ir.height, 0, 1);
    const nx1 = clamp((or.right - ir.left) / ir.width, 0, 1);
    const ny1 = clamp((or.bottom - ir.top) / ir.height, 0, 1);
    const { w, h, lum, rgb } = state.lum;
    const x0 = clamp(Math.floor(nx0 * w), 0, w - 1);
    const x1 = clamp(Math.ceil(nx1 * w) - 1, 0, w - 1);
    const y0 = clamp(Math.floor(ny0 * h), 0, h - 1);
    const y1 = clamp(Math.ceil(ny1 * h) - 1, 0, h - 1);
    let sl = 0, sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = y * w + x;
        sl += lum[p];
        sr += rgb[p * 3]; sg += rgb[p * 3 + 1]; sb += rgb[p * 3 + 2];
        cnt++;
      }
    }
    if (!cnt) cnt = 1;
    state.bg = {
      lum: sl / cnt,
      rgb: [Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt)],
    };
  }

  /* 计入底衬后的“有效背景” */
  function effectiveBg() {
    const bg = state.bg.rgb.slice();
    if (!state.scrim) return bg;
    const textLight = relLum(currentColorRgb()) > 0.35;
    const scrimRGB = textLight ? [0, 0, 0] : [255, 255, 255];
    const a = textLight ? 0.42 : 0.55;
    return bg.map((v, i) => Math.round(v * (1 - a) + scrimRGB[i] * a));
  }

  /* ================= 当前文字色 ================= */
  const currentEntry = () => state.palette[state.active] || null;
  function currentColorRgb() {
    const e = currentEntry();
    if (!e) return [255, 255, 255];
    return state.adapt && e.adapted ? e.adapted.rgb : e.rgb;
  }
  function currentColorHex() {
    const e = currentEntry();
    if (!e) return '#FFFFFF';
    return state.adapt && e.adapted ? e.adapted.hex : e.hex;
  }

  /* ================= 可读性适配（adaptForContrast 在 color-core.js 中） ================= */
  function applyAdaptation() {
    if (!state.palette.length) return;
    if (!state.adapt) { state.palette.forEach((e) => { e.adapted = null; }); return; }
    sampleBg();
    const bg = state.bg.rgb; // 以真实背景为准做适配
    state.palette.forEach((e) => {
      const rgb = adaptForContrast(e.rgb, bg, 4.5);
      e.adapted = { rgb, hex: rgbToHex(rgb) };
    });
  }

  /* ================= ⑥ 渲染色卡 ================= */
  function renderPalette() {
    paletteEl.innerHTML = '';
    state.palette.forEach((e, i) => {
      const shown = state.adapt && e.adapted ? e.adapted : e;
      const chipInk = relLum(shown.rgb) > 0.5 ? '#0A0A0C' : '#FFFFFF';
      const adapted = state.adapt && e.adapted;
      const row = document.createElement('div');
      row.className = 'swatch-row' + (i === state.active ? ' is-active' : '');
      row.dataset.i = String(i);
      row.tabIndex = 0;
      row.style.animationDelay = (i * 0.03) + 's';
      row.innerHTML =
        '<span class="swatch-chip" style="background:' + shown.hex + ';color:' + chipInk + '">Aa' +
          (adapted ? '<span class="adapt-dot" style="background:' + e.hex + '"></span>' : '') +
        '</span>' +
        '<span class="swatch-info">' +
          '<span class="swatch-name">' + e.name + '</span>' +
          '<span class="swatch-sub">' +
            '<span class="hex">' + shown.hex + '</span>' +
            '<span class="pct">' + e.pct + '%</span>' +
            (adapted ? '<span class="tag-adapt">已适配</span>' : '') +
          '</span>' +
        '</span>' +
        '<span class="swatch-side">' +
          '<span class="ratio-tag" data-ratio>—</span>' +
          '<button class="icon-btn" data-copy type="button" aria-label="复制 ' + shown.hex + '">' + ICON_COPY + '</button>' +
        '</span>';
      paletteEl.appendChild(row);
    });
    paletteCount.textContent = state.palette.length + ' 色';
  }

  function updateActiveRow() {
    const rows = paletteEl.querySelectorAll('.swatch-row');
    rows.forEach((r) => r.classList.toggle('is-active', Number(r.dataset.i) === state.active));
  }

  /* ================= ⑦ 可读性计算 ================= */
  function computeReadability() {
    if (!state.palette.length || !state.lum) return;
    sampleBg();
    const bg = effectiveBg();

    const rows = paletteEl.querySelectorAll('.swatch-row');
    state.palette.forEach((e, i) => {
      const shown = state.adapt && e.adapted ? e.adapted : e;
      const ratio = contrast(shown.rgb, bg);
      const lv = levelOf(ratio);
      const tag = rows[i] && rows[i].querySelector('[data-ratio]');
      if (tag) { tag.textContent = ratio.toFixed(1); tag.className = 'ratio-tag ' + lv.cls; }
    });

    const activeRgb = currentColorRgb();
    const ratio = contrast(activeRgb, bg);
    const lv = levelOf(ratio);
    ratioVal.textContent = ratio.toFixed(2) + ':1';
    ratioBadge.textContent = lv.label;
    ratioBadge.className = 'badge ' + lv.cls;

    const hex = currentColorHex();
    fgSwatch.style.background = hex; fgHex.textContent = hex;
    const bgHexStr = rgbToHex(bg);
    bgSwatch.style.background = bgHexStr; bgHex.textContent = bgHexStr;

    overlayText.style.color = hex;
    if (state.scrim) {
      const textLight = relLum(activeRgb) > 0.35;
      overlayScrim.hidden = false;
      overlayScrim.style.background = textLight ? 'rgba(0,0,0,0.42)' : 'rgba(255,255,255,0.5)';
    } else {
      overlayScrim.hidden = true;
    }
  }

  /* ================= 位置 / 字号 ================= */
  function applyPosition() {
    overlay.style.left = (state.pos.x * 100) + '%';
    overlay.style.top = (state.pos.y * 100) + '%';
  }
  function applyTextStyle() {
    if (!state.img) return;
    const w = previewImg.getBoundingClientRect().width || 800;
    overlayText.style.fontSize = clamp(state.fontSize * (w / 1000), 11, 220).toFixed(1) + 'px';
  }

  /* ================= ⑤ 图片载入 ================= */
  function enableTools(on) {
    countRange.disabled = !on;
    adaptToggle.disabled = !on;
    const has = on && state.palette.length > 0;
    [copyHexBtn, copyCssBtn, pngBtn, jsonBtn].forEach((b) => { b.disabled = !has; });
  }

  function buildAll() {
    state.palette = extractPalette(state.img, state.count);
    state.lum = buildLumMap(state.img);
    state.adapt = false; adaptToggle.setAttribute('aria-checked', 'false');
    state.scrim = false; scrimToggle.setAttribute('aria-checked', 'false');
    state.active = 0;
    applyAdaptation();
    renderPalette();
    applyTextStyle();
    requestAnimationFrame(() => {
      applyPosition();
      applyTextStyle();
      computeReadability();
      enableTools(true);
    });
  }

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
      overlayText.textContent = textInput.value;
      applyPosition();
      applyTextStyle();
      buildAll();
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
    if (!file || !file.type || file.type.indexOf('image/') !== 0) { toast('请选择图片文件'); return; }
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

  /* ================= ⑧ 交互 ================= */
  let rafId = 0;
  function scheduleReadability() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; computeReadability(); });
  }

  /* 拖动文字 */
  let dragging = false;
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
    scheduleReadability();
  });
  const endDrag = (ev) => {
    dragging = false;
    try { overlay.releasePointerCapture(ev.pointerId); } catch (e) {}
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
    scheduleReadability();
  });

  /* 色卡点击 / 复制 */
  paletteEl.addEventListener('click', (ev) => {
    const row = ev.target.closest('.swatch-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const copyBtn = ev.target.closest('[data-copy]');
    if (copyBtn) {
      const e = state.palette[i];
      const hex = state.adapt && e.adapted ? e.adapted.hex : e.hex;
      copyText(hex, '已复制 ' + hex);
      const original = copyBtn.innerHTML;
      copyBtn.innerHTML = ICON_CHECK;
      copyBtn.style.color = 'var(--ok)';
      setTimeout(() => { copyBtn.innerHTML = original; copyBtn.style.color = ''; }, 1200);
      return;
    }
    state.active = i;
    updateActiveRow();
    computeReadability();
  });
  paletteEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const row = ev.target.closest('.swatch-row');
    if (!row) return;
    ev.preventDefault();
    state.active = Number(row.dataset.i);
    updateActiveRow();
    computeReadability();
  });

  /* 文字内容 / 字号 */
  textInput.addEventListener('input', () => {
    overlayText.textContent = textInput.value || ' ';
    scheduleReadability();
  });
  sizeRange.addEventListener('input', () => {
    state.fontSize = Number(sizeRange.value);
    sizeVal.textContent = state.fontSize;
    updateRangeFill(sizeRange);
    applyTextStyle();
    scheduleReadability();
  });

  /* 取色数量 */
  countRange.addEventListener('input', () => {
    state.count = Number(countRange.value);
    countVal.textContent = state.count;
    updateRangeFill(countRange);
  });
  countRange.addEventListener('change', () => {
    if (!state.img) return;
    state.palette = extractPalette(state.img, state.count);
    state.active = Math.min(state.active, state.palette.length - 1);
    applyAdaptation();
    renderPalette();
    requestAnimationFrame(computeReadability);
  });

  /* 开关 */
  adaptToggle.addEventListener('click', () => {
    state.adapt = !state.adapt;
    adaptToggle.setAttribute('aria-checked', String(state.adapt));
    applyAdaptation();
    renderPalette();
    requestAnimationFrame(computeReadability);
  });
  scrimToggle.addEventListener('click', () => {
    state.scrim = !state.scrim;
    scrimToggle.setAttribute('aria-checked', String(state.scrim));
    computeReadability();
  });

  /* 上传 / 示例 / 拖放 / 粘贴 */
  pickBtn.addEventListener('click', () => fileInput.click());
  sampleBtn.addEventListener('click', () => loadImageSrc(makeSampleImage()));
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
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        const f = items[i].getAsFile();
        if (f) { handleFile(f); ev.preventDefault(); break; }
      }
    }
  });

  /* 窗口尺寸变化：文字框会变，需重算 */
  window.addEventListener('resize', () => { applyTextStyle(); scheduleReadability(); });

  /* ================= ⑨ 导出 ================= */
  function hexList() {
    return state.palette.map((e) => (state.adapt && e.adapted ? e.adapted.hex : e.hex));
  }
  function cssVars() {
    return ':root {\n' + hexList().map((h, i) => '  --chroma-' + (i + 1) + ': ' + h + ';').join('\n') + '\n}';
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
    const n = state.palette.length;
    if (!n) return;
    const cw = 200, ch = 300, pad = 28, gap = 16;
    const W = pad * 2 + n * cw + (n - 1) * gap;
    const H = pad * 2 + ch + 74;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, W, H);
    state.palette.forEach((e, i) => {
      const shown = state.adapt && e.adapted ? e.adapted : e;
      const bx = pad + i * (cw + gap);
      x.fillStyle = shown.hex;
      roundRectPath(x, bx, pad, cw, ch, 18); x.fill();
      x.textBaseline = 'top';
      x.fillStyle = '#f4f4f6';
      x.font = '600 22px system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif';
      x.fillText(e.name, bx, pad + ch + 16);
      x.fillStyle = '#a3a3af';
      x.font = '16px ui-monospace, Menlo, Consolas, monospace';
      x.fillText(shown.hex, bx, pad + ch + 46);
    });
    downloadCanvas(c, 'chroma-palette.png');
    toast('已导出色卡 PNG');
  }
  function exportJson() {
    if (!state.palette.length) return;
    const bg = effectiveBg();
    const data = {
      tool: 'CHROMA 图片可读色卡',
      generatedAt: new Date().toISOString(),
      image: state.img ? { width: state.img.naturalWidth, height: state.img.naturalHeight } : null,
      textBackground: { hex: rgbToHex(bg) },
      adapted: state.adapt,
      colors: state.palette.map((e) => {
        const shown = state.adapt && e.adapted ? e.adapted : e;
        const ratio = contrast(shown.rgb, bg);
        return {
          name: e.name,
          hex: e.hex,
          rgb: e.rgb,
          hsl: { h: Math.round(e.hsl.h), s: Math.round(e.hsl.s), l: Math.round(e.hsl.l) },
          share: e.pct + '%',
          contrast: Number(ratio.toFixed(2)),
          level: levelOf(ratio).label,
          adaptedHex: e.adapted ? e.adapted.hex : null,
        };
      }),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'chroma-palette.json');
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出 JSON');
  }

  copyHexBtn.addEventListener('click', () => {
    copyText(hexList().join(', '), '已复制 ' + state.palette.length + ' 个色值');
  });
  copyCssBtn.addEventListener('click', () => copyText(cssVars(), '已复制 CSS 变量'));
  pngBtn.addEventListener('click', exportPng);
  jsonBtn.addEventListener('click', exportJson);

  /* ================= 工具：复制 / 提示 / 滑杆填充 ================= */
  function copyText(text, msg) {
    const done = () => toast(msg || '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
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

  /* ================= 初始化 ================= */
  updateRangeFill(sizeRange);
  updateRangeFill(countRange);
  enableTools(false);
})();
