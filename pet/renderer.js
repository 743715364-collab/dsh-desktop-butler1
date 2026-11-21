'use strict';

(() => {
  const api = window.desktopButler;
  const liveFrame = document.getElementById('liveFrame');
  const initialThemeRaw = new URLSearchParams(window.location.search).get('theme');
  const THEME_NAMES = ['blue', 'cinematic', 'live-gold', 'live-blue'];
  const initialTheme = THEME_NAMES.includes(initialThemeRaw) ? initialThemeRaw : 'gold';
  document.documentElement.dataset.theme = initialTheme;
  liveFrame.addEventListener('load', () => {
    liveFrame.classList.add('ready');
    syncLiveFx();
  });
  function applyLiveFrame(theme) {
    const src =
      theme === 'live-gold' ? 'assets/live/gold.html' : theme === 'live-blue' ? 'assets/live/blue.html' : '';
    if (!src) {
      liveFrame.classList.remove('ready');
      liveFrame.removeAttribute('src');
      return;
    }
    if (liveFrame.getAttribute('src') !== src) {
      liveFrame.classList.remove('ready');
      liveFrame.src = src;
    }
  }

  const reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
  let speakFxRaf = 0;
  let speakFxOn = false;
  let speakRingCtl = null;
  function isLiveTheme() {
    return document.documentElement.dataset.theme.startsWith('live-');
  }
  function stopSpeakFx() {
    if (speakFxRaf) cancelAnimationFrame(speakFxRaf);
    speakFxRaf = 0;
    speakFxOn = false;
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.classList.remove('speak-fx');
      appEl.style.removeProperty('--speak-dur');
      appEl.style.removeProperty('--speak-glow');
    }
    if (speakRingCtl) {
      try {
        speakRingCtl.setPaused(false);
      } catch {
        /* iframe gone */
      }
      speakRingCtl = null;
    }
  }
  function shouldLiveFx() {
    if (reduceMotion || !isLiveTheme()) return false;
    const states = ['thinking', 'working', 'result', 'waiting'];
    const work = typeof workStatus !== 'undefined' && workStatus ? workStatus.state : null;
    return (typeof phase !== 'undefined' && phase === 'speaking') || states.includes(work);
  }
  function syncLiveFx() {
    if (!shouldLiveFx()) {
      stopSpeakFx();
      return;
    }
    if (!speakFxOn) startSpeakFx();
  }
  function startSpeakFx() {
    if (!shouldLiveFx()) return;
    stopSpeakFx();
    const appEl = document.getElementById('app');
    if (!appEl) return;
    appEl.classList.add('speak-fx');
    appEl.style.setProperty('--speak-dur', (2.4 + Math.random() * 1.8).toFixed(2) + 's');
    appEl.style.setProperty('--speak-glow', (0.14 + Math.random() * 0.12).toFixed(2));

    let rc = null;
    try {
      rc = liveFrame.contentWindow && liveFrame.contentWindow.ringControl;
    } catch {
      rc = null;
    }
    if (!rc) return;
    try {
      rc.setPaused(true);
    } catch {
      return;
    }
    speakRingCtl = rc;
    speakFxOn = true;
    let spin = Number(rc.getSpin()) || 0;
    let vel = (Math.random() * 2 - 1) * 0.35;
    let target = vel;
    let next = performance.now() + 800;
    let last = performance.now();
    function tick(now) {
      if (!speakFxOn) return;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (now >= next) {
        target = (Math.random() * 2 - 1) * 0.55;
        next = now + 700 + Math.random() * 900;
      }
      vel += (target - vel) * Math.min(1, dt * 2.2);
      spin += vel * dt;
      try {
        rc.setSpin(spin);
      } catch {
        stopSpeakFx();
        return;
      }
      speakFxRaf = requestAnimationFrame(tick);
    }
    speakFxRaf = requestAnimationFrame(tick);
  }
  applyLiveFrame(initialTheme);
  api.onTheme((theme) => {
    const next = THEME_NAMES.includes(theme) ? theme : 'gold';
    stopSpeakFx();
    document.documentElement.dataset.theme = next;
    applyLiveFrame(next);
    syncLiveFx();
  });
  const app = document.getElementById('app');
  const stage = document.getElementById('stage');
  const hit = document.getElementById('hit');
  const bubble = document.getElementById('bubble');
  const textEl = document.getElementById('text');
  const vids = [document.getElementById('v0'), document.getElementById('v1')];
  const holo = document.getElementById('holo');
  const alwaysBtn = document.getElementById('always');
  const workChip = document.getElementById('workChip');

  const CLICK_LINES = [
    '为您服务。',
    '我在。',
    '请吩咐。',
    '全息核心已响应。',
    '听候您的指令。',
    '需要我做什么？',
  ];
  const IDLE_LINES = [
    '系统一切正常。',
    '注意休息。',
    '能量水平稳定。',
    '所有系统已就绪。',
    '全息投影运行中。',
    '时间不早了。',
    '我会保持待命。',
  ];
  const CLICK_CLIPS = ['click1', 'click2', 'click3'];

  let front = 0;
  let current = 'idle';
  let token = 0;
  let bubbleTimer = null;
  let inside = false;
  let drag = null;
  let holoPulse = 0;
  let holoTheta = 0.6;
  let holoLast = 0;
  let holoAimX = 0;
  let holoAimY = 0;
  let holoViewX = 0;
  let holoViewY = 0;

  function setWidth(width) {
    const w = Math.max(360, Math.min(660, Number(width) || 460));
    document.documentElement.style.setProperty('--w', w + 'px');
  }

  function showBubble(text, holdMs = 7200) {
    if (!text) return;
    window.clearTimeout(bubbleTimer);
    textEl.textContent = text;
    bubble.classList.add('on');
    api.bubble(true);
    bubbleTimer = window.setTimeout(() => {
      bubble.classList.remove('on');
      api.bubble(false);
    }, holdMs);
  }

  function hideBubble() {
    window.clearTimeout(bubbleTimer);
    bubble.classList.remove('on');
    api.bubble(false);
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function playClip(name, once = false) {
    if (!once && current === name) return;
    const my = ++token;
    const back = vids[1 - front];
    const old = vids[front];
    back.onended = null;
    back.loop = !once;
    back.classList.remove('front');
    if (back.getAttribute('src') !== 'assets/webm/' + name + '.webm') {
      back.src = 'assets/webm/' + name + '.webm';
      back.load();
    }
    const go = () => {
      if (my !== token) return;
      back.play().then(
        () => {
          if (my !== token) return;
          old.classList.remove('front');
          back.classList.add('front');
          front = 1 - front;
          current = name;
          window.setTimeout(() => {
            if (my === token && old !== vids[front]) {
              try {
                old.pause();
                old.removeAttribute('src');
                old.load();
              } catch {
                /* ignore */
              }
            }
          }, 300);
          if (once) {
            back.onended = () => {
              back.onended = null;
              resumeBase();
            };
          }
        },
        () => {
          /* autoplay blocked: keep the current frame */
        },
      );
    };
    if (back.readyState >= 2) {
      go();
    } else {
      back.addEventListener('loadeddata', go, { once: true });
    }
  }

  // ------------------------------------------------------- DSH 工作状态 --

  const WORK_LABELS = {
    thinking: 'DSH · THINKING',
    working: 'DSH · WORKING',
    result: 'DSH · RESULT',
    waiting: 'DSH · WAITING',
    success: 'DSH · DONE',
    error: 'DSH · ERROR',
  };

  let workStatus = null;
  let appliedWorkKey = '';

  /** 右下角的小状态牌：只在空闲时显示，语音/拖拽时让位。 */
  function renderWorkChip() {
    if (!workChip) return;
    const active = phase === 'idle' && !drag && workStatus && workStatus.state;
    if (!active) {
      workChip.classList.remove('on');
      workChip.removeAttribute('data-state');
      workChip.removeAttribute('title');
      workChip.textContent = '';
      return;
    }
    workChip.textContent = WORK_LABELS[workStatus.state] || '';
    workChip.dataset.state = workStatus.state;
    workChip.classList.add('on');
    if (workStatus.task) workChip.title = workStatus.task;
    else workChip.removeAttribute('title');
  }

  /**
   * 把 DSH 状态映射到金色全息球自己的动作：
   *   thinking → think、working → busy、result → sparkle、waiting → turn、
   *   success → success（只播一次）、error → error（只播一次）、空闲 → idle。
   * 完成/出错只播一次，语音或拖拽结束后不会重放；其余状态循环到状态变化。
   */
  function renderWorkState(force) {
    if (phase !== 'idle' || drag) {
      renderWorkChip();
      return;
    }
    const state = workStatus && workStatus.state ? workStatus.state : null;
    const key = state || 'idle';
    const terminal = state === 'success' || state === 'error';
    if (!force && key === appliedWorkKey) {
      renderWorkChip();
      return;
    }
    if (force && terminal && key === appliedWorkKey) {
      // 终态已经播过了：回来时直接待机，别重复庆祝/报错。
      playClip('idle', false);
      renderWorkChip();
      return;
    }
    appliedWorkKey = key;
    switch (state) {
      case 'thinking':
        playClip('think', false);
        break;
      case 'working':
        playClip('busy', false);
        break;
      case 'result':
        playClip('sparkle', false);
        break;
      case 'waiting':
        playClip('turn', false);
        break;
      case 'success':
        playClip('success', true);
        break;
      case 'error':
        playClip('error', true);
        break;
      default:
        playClip('idle', false);
    }
    renderWorkChip();
  }

  function applyWorkStatus(next) {
    workStatus = next && WORK_LABELS[next.state] ? next : null;
    renderWorkState(false);
    syncLiveFx();
  }

  /** 一次性动作（点击回应 / 完成 / 出错）播完后回到当前工作状态或待机。 */
  function resumeBase() {
    if (phase !== 'idle') return;
    renderWorkState(true);
  }

  function pulse() {
    app.classList.remove('clicked');
    // force restart the CSS animation
    void app.offsetWidth;
    app.classList.add('clicked');
    holoPulse = 1;
    window.setTimeout(() => app.classList.remove('clicked'), 620);
  }

  const HOLO = { w: 640, h: 360, cx: 320, cy: 174, r: 150 };
  const hctx = holo && typeof holo.getContext === 'function' ? holo.getContext('2d') : null;

  function holoRotate(p, yaw, tilt) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const x = p[0] * cy + p[2] * sy;
    const z0 = -p[0] * sy + p[2] * cy;
    const cx = Math.cos(tilt);
    const sx = Math.sin(tilt);
    return [x, p[1] * cx - z0 * sx, p[1] * sx + z0 * cx];
  }

  function holoProject(p, scale) {
    const persp = 1 / (1 - p[2] * 0.16);
    return [HOLO.cx + p[0] * HOLO.r * scale * persp, HOLO.cy + p[1] * HOLO.r * scale * persp, p[2]];
  }

  function holoSphere(lat, lon) {
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    return [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)];
  }

  function holoSegment(a, b, alpha, color) {
    hctx.strokeStyle = 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha + ')';
    hctx.lineWidth = 0.8;
    hctx.beginPath();
    hctx.moveTo(a[0], a[1]);
    hctx.lineTo(b[0], b[1]);
    hctx.stroke();
  }

  /** Thin HUD panel with corner brackets, grid and a row of data bars. */
  function holoPanel(x, y, w, h, rgb, alpha, seed) {
    hctx.fillStyle = 'rgba(' + rgb + ',' + alpha * 0.12 + ')';
    hctx.fillRect(x, y, w, h);
    hctx.strokeStyle = 'rgba(' + rgb + ',' + alpha * 0.55 + ')';
    hctx.lineWidth = 0.7;
    hctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    const corner = 7;
    hctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')';
    hctx.beginPath();
    for (const [cx, cy, sx, sy] of [
      [x, y, 1, 1],
      [x + w, y, -1, 1],
      [x, y + h, 1, -1],
      [x + w, y + h, -1, -1],
    ]) {
      hctx.moveTo(cx, cy + sy * corner);
      hctx.lineTo(cx, cy);
      hctx.lineTo(cx + sx * corner, cy);
    }
    hctx.stroke();
    hctx.strokeStyle = 'rgba(' + rgb + ',' + alpha * 0.22 + ')';
    hctx.lineWidth = 0.5;
    hctx.beginPath();
    for (let i = 1; i <= 3; i += 1) {
      const yy = y + (h * i) / 4;
      hctx.moveTo(x + 4, yy);
      hctx.lineTo(x + w - 4, yy);
    }
    for (let i = 1; i <= 4; i += 1) {
      const xx = x + (w * i) / 5;
      hctx.moveTo(xx, y + 4);
      hctx.lineTo(xx, y + h - 4);
    }
    hctx.stroke();
    hctx.fillStyle = 'rgba(' + rgb + ',' + alpha * 0.6 + ')';
    for (let i = 0; i < 7; i += 1) {
      const r = Math.sin(seed * 91.7 + i * 17.3) * 0.5 + 0.5;
      const bw = 2 + r * (w / 9);
      hctx.fillRect(x + 5 + i * (w / 8), y + h - 8, bw, 2);
    }
  }

  /** Organic plasma filaments: curved strands and sparks, not another geometric ring. */
  function drawFilaments(t, intensity, color, yaw, tilt, scale) {
    const rgb = color[0] + ',' + color[1] + ',' + color[2];
    const rnd = (i) => {
      const v = Math.sin(i * 53.71 + 17.3) * 43758.5453;
      return v - Math.floor(v);
    };
    hctx.save();
    hctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i += 1) {
      const lat = (rnd(i) * 2 - 1) * 72;
      const lon = rnd(i + 4) * 360 + t * (10 + (i % 5) * 4);
      const p0 = holoProject(holoRotate(holoSphere(lat * 0.12, lon), yaw, tilt), scale * 0.82);
      const p1 = holoProject(holoRotate(holoSphere(lat * 0.6, lon + 16 + rnd(i + 8) * 22), yaw, tilt), scale * 1.02);
      const p2 = holoProject(holoRotate(holoSphere(lat * 1.02, lon + 30 + rnd(i + 12) * 30), yaw, tilt), scale * 1.06);
      const alpha = (0.12 + rnd(i + 16) * 0.20) * intensity;
      const width = 0.6 + rnd(i + 20) * 1.2;
      for (const [w, a] of [
        [width * 3.4, alpha * 0.22],
        [width, alpha],
      ]) {
        hctx.strokeStyle = 'rgba(' + rgb + ',' + a + ')';
        hctx.lineWidth = w;
        hctx.beginPath();
        hctx.moveTo(p0[0], p0[1]);
        hctx.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]);
        hctx.stroke();
      }
      hctx.fillStyle = 'rgba(' + rgb + ',' + alpha * 1.5 + ')';
      hctx.beginPath();
      hctx.arc(p2[0], p2[1], 0.8 + rnd(i + 24) * 1.4, 0, Math.PI * 2);
      hctx.fill();
    }
    hctx.restore();
  }

  /** White-hot core bloom + a faint anamorphic streak. */
  function drawCinematicBloom(t, intensity) {
    hctx.save();
    hctx.globalCompositeOperation = 'lighter';
    const bloom = hctx.createRadialGradient(HOLO.cx, HOLO.cy, 0, HOLO.cx, HOLO.cy, HOLO.r * 0.58);
    bloom.addColorStop(0, 'rgba(255,250,232,' + 0.20 * intensity + ')');
    bloom.addColorStop(0.22, 'rgba(255,222,154,' + 0.12 * intensity + ')');
    bloom.addColorStop(0.55, 'rgba(255,165,58,' + 0.05 * intensity + ')');
    bloom.addColorStop(1, 'rgba(255,140,40,0)');
    hctx.fillStyle = bloom;
    hctx.fillRect(0, 0, HOLO.w, HOLO.h);
    const streak = hctx.createLinearGradient(HOLO.cx - HOLO.r * 1.55, 0, HOLO.cx + HOLO.r * 1.55, 0);
    streak.addColorStop(0, 'rgba(255,190,90,0)');
    streak.addColorStop(0.42, 'rgba(255,215,140,' + 0.03 * intensity + ')');
    streak.addColorStop(0.5, 'rgba(255,245,220,' + 0.16 * intensity + ')');
    streak.addColorStop(0.58, 'rgba(255,215,140,' + 0.03 * intensity + ')');
    streak.addColorStop(1, 'rgba(255,190,90,0)');
    hctx.fillStyle = streak;
    hctx.fillRect(HOLO.cx - HOLO.r * 1.55, HOLO.cy - 1.2, HOLO.r * 3.1, 2.4);
    hctx.restore();
  }

  /** One nested cage layer with its own yaw/tilt/spin. */
  function buildHoloLayer(radius, latStep, lonStep, meridianStep, spin, tiltOff, alphaScale, width, color, tiltBase, scale) {
    const segs = [];
    const yawLayer = holoTheta * spin + holoViewX * 0.35;
    const tiltLayer = tiltBase + tiltOff + holoViewY * 0.08;
    for (let lat = -72; lat <= 72; lat += latStep) {
      let prev = null;
      for (let lon = 0; lon <= 360; lon += lonStep) {
        const p = holoProject(holoRotate(holoSphere(lat, lon).map((v) => v * radius), yawLayer, tiltLayer), scale);
        if (prev) {
          const front = (prev[2] + p[2]) * 0.5;
          segs.push([
            prev[0],
            prev[1],
            p[0],
            p[1],
            (0.035 + 0.16 * (front + 1) * 0.5) * alphaScale,
            width,
            color,
          ]);
        }
        prev = p;
      }
    }
    for (let lon = 0; lon < 360; lon += meridianStep) {
      let prev = null;
      for (let lat = -80; lat <= 80; lat += 10) {
        const p = holoProject(holoRotate(holoSphere(lat, lon).map((v) => v * radius), yawLayer, tiltLayer), scale);
        if (prev) {
          const front = (prev[2] + p[2]) * 0.5;
          segs.push([
            prev[0],
            prev[1],
            p[0],
            p[1],
            (0.03 + 0.15 * (front + 1) * 0.5) * alphaScale,
            width,
            color,
          ]);
        }
        prev = p;
      }
    }
    return segs;
  }

  function strokeHoloLayer(segs, intensity, glow = false) {
    for (const s of segs) {
      const c = s[6];
      hctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + s[4] * (glow ? 0.24 : 1) * intensity + ')';
      hctx.lineWidth = glow ? s[5] * 3.2 : s[5];
      hctx.beginPath();
      hctx.moveTo(s[0], s[1]);
      hctx.lineTo(s[2], s[3]);
      hctx.stroke();
    }
  }

  /** The film's big arch/HUD layer: outer rings, ticks, struts, panels, scanline. */
  function drawOuterHud(t, intensity, color) {
    const rgb = color[0] + ',' + color[1] + ',' + color[2];
    const cx = HOLO.cx;
    const cy = HOLO.cy;
    const r = HOLO.r;
    hctx.save();
    hctx.globalCompositeOperation = 'lighter';

    // Segmented outer containment rings (the big circular arch in the film).
    const rings = [
      [1.40, 64, 0.10, 0.22],
      [1.50, 88, -0.06, 0.14],
      [1.28, 48, 0.16, 0.28],
    ];
    for (const [scale, count, speed, alpha] of rings) {
      hctx.strokeStyle = 'rgba(' + rgb + ',' + alpha * intensity + ')';
      hctx.lineWidth = 1.1;
      for (let i = 0; i < count; i += 1) {
        if (i % 7 === 0) continue;
        const a0 = (i / count) * Math.PI * 2 + t * speed;
        hctx.beginPath();
        hctx.arc(cx, cy, r * scale, a0, a0 + (Math.PI * 2 * 0.52) / count);
        hctx.stroke();
      }
    }

    // A few thicker broken arcs give the arch its silhouette.
    hctx.strokeStyle = 'rgba(' + rgb + ',' + 0.42 * intensity + ')';
    hctx.lineWidth = 4.5;
    for (const [a0, len] of [
      [-2.35, 0.95],
      [-0.75, 0.62],
      [0.55, 1.05],
      [2.2, 0.7],
    ]) {
      hctx.beginPath();
      hctx.arc(cx, cy, r * 1.37, a0 + t * 0.05, a0 + len + t * 0.05);
      hctx.stroke();
    }

    // Radial ticks and long struts.
    hctx.lineWidth = 0.8;
    for (let i = 0; i < 96; i += 1) {
      const a = (i / 96) * Math.PI * 2 - t * 0.03;
      const r0 = r * (i % 6 === 0 ? 1.32 : 1.38);
      const r1 = r * (i % 6 === 0 ? 1.47 : 1.43);
      hctx.strokeStyle = 'rgba(' + rgb + ',' + (i % 6 === 0 ? 0.38 : 0.22) * intensity + ')';
      hctx.beginPath();
      hctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      hctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      hctx.stroke();
    }
    hctx.strokeStyle = 'rgba(' + rgb + ',' + 0.22 * intensity + ')';
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2 + t * 0.02;
      hctx.beginPath();
      hctx.moveTo(cx + Math.cos(a) * r * 1.03, cy + Math.sin(a) * r * 1.03);
      hctx.lineTo(cx + Math.cos(a) * r * 1.32, cy + Math.sin(a) * r * 1.32);
      hctx.stroke();
    }

    // Floating translucent data panels around the orb.
    holoPanel(18, 72, 96, 86, rgb, 0.46 * intensity, 3);
    holoPanel(526, 72, 96, 86, rgb, 0.46 * intensity, 7);
    holoPanel(26, 188, 78, 58, rgb, 0.36 * intensity, 11);
    holoPanel(536, 188, 78, 58, rgb, 0.36 * intensity, 13);
    holoPanel(252, 12, 136, 38, rgb, 0.32 * intensity, 19);
    holoPanel(252, 304, 136, 36, rgb, 0.28 * intensity, 23);

    // Horizontal scan sweep across the projection.
    const sy = cy + Math.sin(t * 0.75) * r * 1.42;
    const sweep = hctx.createLinearGradient(cx - r * 1.5, 0, cx + r * 1.5, 0);
    sweep.addColorStop(0, 'rgba(' + rgb + ',0)');
    sweep.addColorStop(0.5, 'rgba(' + rgb + ',' + 0.12 * intensity + ')');
    sweep.addColorStop(1, 'rgba(' + rgb + ',0)');
    hctx.fillStyle = sweep;
    hctx.fillRect(cx - r * 1.5, sy, r * 3, 1.2);

    // Embers drifting beyond the orb's limb.
    const rnd = (i) => {
      const v = Math.sin(i * 91.17 + 31.7) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < 38; i += 1) {
      const a = rnd(i) * Math.PI * 2 + t * (0.10 + (i % 5) * 0.02);
      const rad = r * (1.03 + rnd(i + 4) * 0.46);
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad * 0.96;
      const trail = 4 + rnd(i + 8) * 16;
      const alpha = (0.14 + rnd(i + 12) * 0.32) * intensity;
      hctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')';
      hctx.lineWidth = 0.8;
      hctx.beginPath();
      hctx.moveTo(x, y);
      hctx.lineTo(x - Math.cos(a + 0.55) * trail, y - Math.sin(a + 0.55) * trail);
      hctx.stroke();
      hctx.fillStyle = 'rgba(' + rgb + ',' + alpha * 1.4 + ')';
      hctx.beginPath();
      hctx.arc(x, y, 0.8 + rnd(i + 16) * 1.2, 0, Math.PI * 2);
      hctx.fill();
    }
    hctx.restore();
  }

  function drawHolo(now) {
    window.requestAnimationFrame(drawHolo);
    if (!hctx) return;
    if (document.documentElement.dataset.theme.startsWith('live-')) {
      holoLast = now;
      return;
    }
    if (!holoLast) holoLast = now;
    if (now - holoLast < 32) return;
    const dt = Math.min(0.06, (now - holoLast) / 1000);
    holoLast = now;

    const busy = current === 'busy';
    const error = current === 'error';
    const success = current === 'success';
    const dragMode = current === 'drag' || current === 'move_a' || current === 'move_b';
    const speed = busy ? 0.55 : dragMode ? 0.48 : current === 'think' ? 0.26 : 0.10;
    holoTheta += dt * speed * (1 + holoPulse * 0.9);
    holoPulse *= Math.pow(0.08, dt);
    const ease = Math.min(1, dt * 6);
    holoViewX += (holoAimX - holoViewX) * ease;
    holoViewY += (holoAimY - holoViewY) * ease;

    const t = now / 1000;
    const tilt = 0.32 + 0.07 * Math.sin(t * 0.35) + holoViewY * 0.10;
    const yaw = holoTheta + holoViewX * 0.35;
    const scale = 1 + holoPulse * 0.025;
    const blueTheme = document.documentElement.dataset.theme === 'blue';
    const cinematic = document.documentElement.dataset.theme === 'cinematic';
    const color = error
      ? [255, 108, 58]
      : success
        ? blueTheme
          ? [205, 245, 255]
          : [255, 226, 168]
        : busy
          ? blueTheme
            ? [95, 185, 255]
            : [255, 170, 72]
          : phase === 'listening'
            ? blueTheme
              ? [135, 215, 255]
              : [255, 208, 126]
            : blueTheme
              ? [112, 198, 255]
              : [255, 190, 96];
    const intensity = (error ? 0.72 + 0.12 * Math.sin(t * 17) : busy ? 1.12 : 1) * (1 + holoPulse * 0.55);
    const limbRGB = blueTheme ? '1,6,16' : '6,3,1';
    const limbRGB2 = blueTheme ? '2,8,20' : '7,4,2';
    const rimRGB = blueTheme ? '80,170,255' : '255,180,80';
    const rimHighRGB = blueTheme ? '150,220,255' : '255,205,128';
    const specRGB = blueTheme ? '205,240,255' : '255,248,226';
    const specRGB2 = blueTheme ? '160,215,255' : '255,224,170';

    hctx.clearRect(0, 0, HOLO.w, HOLO.h);
    hctx.save();
    hctx.globalCompositeOperation = 'source-over';

    // Sphere limb shading: pull the flat artwork's edge into the dark so the
    // bright plasma reads as the front of a volume, not a cut-out.
    const limb = hctx.createRadialGradient(HOLO.cx, HOLO.cy, HOLO.r * 0.28, HOLO.cx, HOLO.cy, HOLO.r * 1.06);
    limb.addColorStop(0, 'rgba(' + limbRGB + ',0)');
    limb.addColorStop(0.66, 'rgba(' + limbRGB + ',0)');
    limb.addColorStop(0.84, 'rgba(' + limbRGB2 + ',' + 0.18 * intensity + ')');
    limb.addColorStop(1, 'rgba(' + limbRGB + ',' + 0.54 * intensity + ')');
    hctx.fillStyle = limb;
    hctx.beginPath();
    hctx.arc(HOLO.cx, HOLO.cy, HOLO.r * 1.06, 0, Math.PI * 2);
    hctx.fill();

    hctx.globalCompositeOperation = 'lighter';
    // Fresnel rim: the strongest single cue that this is a sphere, not a flat sprite.
    const rim = hctx.createRadialGradient(HOLO.cx, HOLO.cy, HOLO.r * 0.72, HOLO.cx, HOLO.cy, HOLO.r * 1.08);
    rim.addColorStop(0, 'rgba(' + rimRGB + ',0)');
    rim.addColorStop(0.76, 'rgba(' + rimRGB + ',' + 0.02 * intensity + ')');
    rim.addColorStop(0.9, 'rgba(' + rimHighRGB + ',' + 0.20 * intensity + ')');
    rim.addColorStop(1, 'rgba(' + rimRGB + ',0)');
    hctx.fillStyle = rim;
    hctx.beginPath();
    hctx.arc(HOLO.cx, HOLO.cy, HOLO.r * 1.08, 0, Math.PI * 2);
    hctx.fill();

    // A cool-white specular glint keeps the orb from reading as flat smoke.
    const spec = hctx.createRadialGradient(
      HOLO.cx - HOLO.r * 0.34,
      HOLO.cy - HOLO.r * 0.42,
      0,
      HOLO.cx - HOLO.r * 0.34,
      HOLO.cy - HOLO.r * 0.42,
      HOLO.r * 0.38,
    );
    spec.addColorStop(0, 'rgba(' + specRGB + ',' + 0.11 * intensity + ')');
    spec.addColorStop(0.55, 'rgba(' + specRGB2 + ',' + 0.04 * intensity + ')');
    spec.addColorStop(1, 'rgba(' + specRGB2 + ',0)');
    hctx.fillStyle = spec;
    hctx.fillRect(0, 0, HOLO.w, HOLO.h);

    if (cinematic) drawCinematicBloom(t, intensity);
    drawOuterHud(t, intensity, color);

    /** @type {Array<[number, number, number, number, number]>} */
    const segments = [];

    // Latitude rings + meridians, depth-faded: the actual 3D cage.
    for (let lat = -72; lat <= 72; lat += 18) {
      let prev = null;
      for (let lon = 0; lon <= 360; lon += 10) {
        const p = holoProject(holoRotate(holoSphere(lat, lon), yaw, tilt), scale);
        if (prev) {
          segments.push([prev[0], prev[1], p[0], p[1], 0.08 + 0.26 * ((prev[2] + p[2]) * 0.5 + 0.5)]);
        }
        prev = p;
      }
    }
    for (let lon = 0; lon < 360; lon += 45) {
      let prev = null;
      for (let lat = -80; lat <= 80; lat += 10) {
        const p = holoProject(holoRotate(holoSphere(lat, lon), yaw, tilt), scale);
        if (prev) {
          segments.push([prev[0], prev[1], p[0], p[1], 0.07 + 0.25 * ((prev[2] + p[2]) * 0.5 + 0.5)]);
        }
        prev = p;
      }
    }

    // Three tilted orbital rings in perspective.
    const rings = [
      [1.16, 1.22, 0.42],
      [1.32, 0.58, -0.3],
      [1.04, 1.55, 0.18],
    ];
    for (const [radius, ringTilt, spin] of rings) {
      let prev = null;
      for (let i = 0; i <= 72; i += 1) {
        const a = (i / 72) * Math.PI * 2 + yaw * spin;
        const p = holoProject(
          holoRotate(
            [Math.cos(a) * radius, Math.sin(a) * radius * Math.cos(ringTilt), Math.sin(a) * radius * Math.sin(ringTilt)],
            yaw * 0.35,
            tilt * 0.4,
          ),
          scale,
        );
        if (prev) segments.push([prev[0], prev[1], p[0], p[1], 0.09 + 0.20 * (p[2] + 1) * 0.5]);
        prev = p;
      }
    }

    // Sphere-surface particles: front points larger/brighter than back points.
    const rnd = (i) => {
      const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < 48; i += 1) {
      const lat = (Math.asin(rnd(i + 3) * 2 - 1) * 180) / Math.PI;
      const lon = rnd(i + 19) * 360 + yaw * 30;
      const p = holoProject(holoRotate(holoSphere(lat, lon), yaw, tilt), scale);
      if (p[2] < -0.75) continue;
      const tw = 0.5 + 0.5 * Math.sin(t * (1.5 + (i % 4) * 0.4) + i);
      const front = (p[2] + 1) * 0.5;
      const alpha = (0.06 + 0.25 * front) * tw * intensity;
      const radius = 0.7 + front * 1.6 + (i % 7 === 0 ? 0.8 : 0);
      hctx.fillStyle = 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha + ')';
      hctx.beginPath();
      hctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
      hctx.fill();
    }

    // Cinematic version uses three nested cages: a counter-rotating outer halo,
    // the main shell, and a faster inner gyroscope.
    const outerLayer = cinematic
      ? buildHoloLayer(1.16, 30, 18, 90, -0.42, -0.45, 0.65, 0.65, color, tilt, scale)
      : [];
    const innerLayer = cinematic
      ? buildHoloLayer(0.54, 30, 18, 75, 1.85, 0.55, 1.0, 0.8, blueTheme ? [220, 248, 255] : [255, 244, 218], tilt, scale)
      : [];

    // Glow pass first, then the crisp cage linework.
    hctx.globalCompositeOperation = 'lighter';
    if (cinematic) {
      strokeHoloLayer(outerLayer, intensity, true);
      strokeHoloLayer(outerLayer, intensity, false);
    }
    for (const s of segments) {
      hctx.strokeStyle = 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + s[4] * 0.22 * intensity + ')';
      hctx.lineWidth = 3.2;
      hctx.beginPath();
      hctx.moveTo(s[0], s[1]);
      hctx.lineTo(s[2], s[3]);
      hctx.stroke();
    }
    for (const s of segments) {
      holoSegment([s[0], s[1]], [s[2], s[3]], s[4] * intensity, color);
    }
    if (cinematic) {
      strokeHoloLayer(innerLayer, intensity, true);
      strokeHoloLayer(innerLayer, intensity, false);
    }
    if (cinematic) drawFilaments(t, intensity, color, yaw, tilt, scale);
    hctx.restore();
  }

  window.requestAnimationFrame(drawHolo);

  function hitTest(x, y) {
    const r = hit.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = r.width / 2;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) return true;
    if (bubble.classList.contains('on')) {
      const b = bubble.getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
    }
    return false;
  }

  function updateHover(x, y) {
    const over = hitTest(x, y);
    if (over === inside) return;
    inside = over;
    app.classList.toggle('hot', over);
  }

  document.addEventListener('mousemove', (e) => {
    if (drag) return;
    holoAimX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
    holoAimY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    updateHover(e.clientX, e.clientY);
  });

  document.addEventListener('mouseleave', () => {
    if (drag) return;
    inside = false;
    holoAimX = 0;
    holoAimY = 0;
    app.classList.remove('hot');
  });

  hit.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { sx: e.screenX, sy: e.screenY, moved: false, pointerId: e.pointerId };
    renderWorkChip();
    api.dragStart();
    try {
      hit.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 6) {
      drag.moved = true;
      hit.classList.add('dragging');
      hideBubble();
      playClip('drag', false);
    }
    if (drag.moved) api.dragMove();
  });

  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    hit.classList.remove('dragging');
    renderWorkChip();
    if (moved) {
      api.dragEnd();
      resumeBase();
      inside = false;
      app.classList.remove('hot');
    } else if (phase === 'listening') {
      void finishListening('manual');
    } else if (phase === 'idle') {
      pulse();
      playClip(pick(CLICK_CLIPS), true);
      const line = pick(CLICK_LINES);
      showBubble(line);
      api.sayText(line);
    }
  });

  window.addEventListener('pointercancel', () => {
    if (!drag) return;
    drag = null;
    hit.classList.remove('dragging');
    renderWorkChip();
    api.dragEnd();
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.openSettings();
  });

  bubble.addEventListener('click', (e) => {
    e.stopPropagation();
    hideBubble();
  });

  api.onWidth((width) => setWidth(width));
  api.onBubble((text) => showBubble(text));

  api.getWidth().then(setWidth).catch(() => setWidth(460));

  // ---------------------------------------------------------------- voice --
  //
  // The renderer owns the microphone and the speaker; the main process owns the
  // keys and the network. One turn:
  //
  //   Ctrl+Alt+Space（或菜单）→ capture 16 kHz PCM → silence decides the end → main transcribes
  //   → main asks the model → reply back here → speechSynthesis / cloud audio
  //
  // Everything is duck-typed and defensive: a missing microphone, a missing API
  // key and a failing network all have to degrade into a spoken sentence rather
  // than a broken pet.

  let vcfg = {
    silenceMs: 900,
    maxMs: 20000,
    minMs: 400,
    threshold: 0.015,
    noSpeechMs: 8000,
    trimSilence: true,
    tts: { mode: 'edge', voice: '', rate: 1, pitch: 1 },
    name: '桌面管家',
  };
  let phase = 'idle'; // idle | listening | thinking | speaking
  let rec = null;
  let speakToken = 0;
  let audioEl = null;
  let voices = [];
  /** 闲聊模式开着时，主进程会自己找话题；静态待机台词就不要再插嘴了。 */
  let chitchatOn = false;

  /**
   * 语音常开：麦克风一直开着，能量 VAD 切出一句就发一轮对话；
   * 思考 / 朗读期间暂停录音，避免把自己的声音识别进去。
   */
  const cont = {
    active: false,
    want: false,
    starting: false,
    paused: false,
    busy: false,
    ctx: null,
    stream: null,
    source: null,
    node: null,
    mute: null,
    chunks: [],
    preroll: [],
    sampleRate: 16000,
    speechSeen: false,
    lastLoud: 0,
    utteranceStart: 0,
    generation: 0,
  };

  function setPhase(next) {
    if (next === phase) return;
    phase = next;
    app.classList.toggle('listening', next === 'listening');
    app.classList.toggle('thinking', next === 'thinking');
    app.classList.toggle('speaking', next === 'speaking');
    api.voiceState(next);
    if (cont.active) {
      if (next === 'thinking' || next === 'speaking') {
        // 自己思考/朗读时把常开录音静音，避免把自己的声音识别进去。
        cont.paused = true;
        cont.speechSeen = false;
        cont.chunks = [];
        cont.preroll = [];
      } else if (next === 'idle' && !cont.busy) {
        // 闲聊朗读结束、或常开刚开启时 phase 不是 idle：回到 idle 后再开录。
        cont.paused = false;
        cont.speechSeen = false;
        cont.chunks = [];
        cont.preroll = [];
      }
    }
    if (next === 'listening') playClip('sparkle', false);
    else if (next === 'thinking') playClip('think', false);
    else if (next === 'speaking') playClip('idle', false);
    else if (next === 'idle') renderWorkState(true);
    renderWorkChip();
    syncLiveFx();
  }

  /** Long replies need the bubble to stay up long enough to be read. */
  function holdFor(text) {
    return Math.max(3600, Math.min(16000, 2400 + String(text).length * 240));
  }

  function refreshVoices() {
    try {
      voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    } catch {
      voices = [];
    }
  }

  /** Pick a Chinese system voice, honouring the configured name when it exists. */
  function pickVoice() {
    if (!voices.length) return null;
    const want = String(vcfg.tts.voice || '')
      .toLowerCase()
      .trim();
    if (want) {
      const exact = voices.find((v) => v.name.toLowerCase() === want);
      if (exact) return exact;
      const loose = voices.find((v) => v.name.toLowerCase().includes(want));
      if (loose) return loose;
      // "Microsoft Huihui Desktop" is reported as "Microsoft Huihui - Chinese…".
      const token = want
        .split(/\s+/)
        .filter((word) => word.length > 3 && !word.includes('microsoft'))
        .sort((a, b) => b.length - a.length)[0];
      if (token) {
        const byToken = voices.find((v) => v.name.toLowerCase().includes(token));
        if (byToken) return byToken;
      }
    }
    const zh = voices.filter((v) => /^zh/i.test(v.lang));
    const preferred = zh.find((v) => /huihui|xiaoxiao|yaoyao|female/i.test(v.name));
    return preferred || zh[0] || voices.find((v) => /^en/i.test(v.lang)) || null;
  }

  function base64ToBytes(b64) {
    const bin = atob(String(b64));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function concatFloat32(chunks) {
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function resampleLinear(input, from, to) {
    const ratio = from / to;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = idx + 1 < input.length ? input[idx + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  /** 裁掉首尾静音，缩短上传/识别时间；首尾各多留几帧，别切掉字头字尾。 */
  function trimSilence(samples, sampleRate) {
    const frame = Math.max(1, Math.floor(sampleRate * 0.02));
    const threshold = 0.012;
    let start = 0;
    let end = samples.length;
    for (let i = 0; i + frame <= samples.length; i += frame) {
      let sum = 0;
      for (let j = 0; j < frame; j++) sum += samples[i + j] * samples[i + j];
      if (Math.sqrt(sum / frame) > threshold) {
        start = Math.max(0, i - frame * 5);
        break;
      }
    }
    for (let k = samples.length - frame; k >= 0; k -= frame) {
      let sum = 0;
      for (let j = 0; j < frame; j++) sum += samples[k + j] * samples[k + j];
      if (Math.sqrt(sum / frame) > threshold) {
        end = Math.min(samples.length, k + frame * 6);
        break;
      }
    }
    if (end - start < sampleRate * 0.2) return samples;
    return samples.slice(start, end);
  }

  /** Float32 采样 → 规范的 16kHz mono PCM16 WAV（DSH 识别只收这个格式）。 */
  function encodeWav(samples, sampleRate) {
    const target = 16000;
    const data = sampleRate && Math.abs(sampleRate - target) > 1
      ? resampleLinear(samples, sampleRate, target)
      : samples;
    const bytes = new Uint8Array(44 + data.length * 2);
    const view = new DataView(bytes.buffer);
    const tag = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    tag(0, 'RIFF');
    view.setUint32(4, 36 + data.length * 2, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, target, true);
    view.setUint32(28, target * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, 'data');
    view.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return bytes.buffer;
  }

  function toWav(chunks, sampleRate) {
    const samples = concatFloat32(chunks);
    const trimmed = vcfg.trimSilence === false ? samples : trimSilence(samples, sampleRate);
    return encodeWav(trimmed, sampleRate);
  }

  function micErrorText(err) {
    const name = err && err.name ? String(err.name) : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风被系统挡住了。请到「设置 → 隐私 → 麦克风」放行。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '我没有找到麦克风。';
    }
    if (name === 'NotReadableError') return '麦克风被别的程序占用了。';
    return '麦克风打不开，您：' + (err && err.message ? err.message : '未知原因');
  }

  function stopSpeaking() {
    speakToken += 1;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* nothing queued */
    }
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        /* already stopped */
      }
      audioEl = null;
    }
    setPhase('idle');
  }

  function speak(text, audioB64, mime, onDone) {
    const mine = ++speakToken;
    // 新的一句立刻接替旧的：不要让两条点击台词/回答叠在一起。
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
      audioEl = null;
    }
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* nothing queued */
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (mine !== speakToken) return;
      setPhase('idle');
      if (typeof onDone === 'function') onDone();
    };
    showBubble(text, holdFor(text));
    setPhase('speaking');

    if (audioB64) {
      const url = URL.createObjectURL(new Blob([base64ToBytes(audioB64)], { type: mime || 'audio/mpeg' }));
      const el = new Audio(url);
      audioEl = el;
      const done = () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        if (audioEl === el) audioEl = null;
        finish();
      };
      el.onended = done;
      el.onerror = done;
      el.play().catch(done);
      return;
    }

    if (!window.speechSynthesis) {
      // No engine: the bubble still carries the answer.
      window.setTimeout(finish, holdFor(text));
      return;
    }

    const utter = new SpeechSynthesisUtterance(String(text));
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    utter.lang = (voice && voice.lang) || 'zh-CN';
    utter.rate = Math.max(0.5, Math.min(2, Number(vcfg.tts.rate) || 1));
    utter.pitch = Math.max(0, Math.min(2, Number(vcfg.tts.pitch) || 1));
    // Chromium occasionally never fires onend for long utterances.
    const guard = window.setTimeout(finish, holdFor(text) + 8000);
    utter.onend = () => {
      window.clearTimeout(guard);
      finish();
    };
    utter.onerror = () => {
      window.clearTimeout(guard);
      finish();
    };
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch {
      window.clearTimeout(guard);
      finish();
    }
  }

  // ------------------------------------------------------- 语音常开 --------

  function updateAlwaysButton() {
    const on = cont.active || cont.starting;
    alwaysBtn.classList.toggle('on', on);
    alwaysBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    alwaysBtn.title = on
      ? '语音常开：正在持续聆听（点击关闭）'
      : '语音常开（持续聆听）';
  }

  function cleanupContinuousAudio() {
    try {
      if (cont.node) {
        cont.node.onaudioprocess = null;
        cont.node.disconnect();
      }
    } catch {
      /* ignore */
    }
    try {
      if (cont.source) cont.source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (cont.mute) cont.mute.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (cont.stream) cont.stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    try {
      if (cont.ctx) void cont.ctx.close();
    } catch {
      /* ignore */
    }
    cont.ctx = null;
    cont.stream = null;
    cont.source = null;
    cont.node = null;
    cont.mute = null;
  }

  async function startContinuous(silent) {
    if (cont.active || cont.starting) {
      updateAlwaysButton();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showBubble('这个环境拿不到麦克风接口。', 5600);
      api.setAlwaysListen(false);
      return;
    }
    cont.want = true;
    cont.starting = true;
    const gen = ++cont.generation;
    updateAlwaysButton();
    // 手动录音进行中：先收掉那一段，避免两个录音器抢麦克风。
    if (rec) await finishListening('abort');
    if (!cont.want || gen !== cont.generation) {
      cont.starting = false;
      updateAlwaysButton();
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (gen === cont.generation) {
        cont.want = false;
        cont.starting = false;
        api.setAlwaysListen(false);
        updateAlwaysButton();
      }
      showBubble(micErrorText(err), 7600);
      return;
    }
    // getUserMedia 期间用户可能已经点过关闭。
    if (!cont.want || gen !== cont.generation) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
      cont.starting = false;
      updateAlwaysButton();
      return;
    }

    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* keep going */
      }
    }
    if (!cont.want || gen !== cont.generation) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
      cont.starting = false;
      updateAlwaysButton();
      return;
    }

    let source;
    let node;
    let mute;
    try {
      source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      mute = ctx.createGain();
      mute.gain.value = 0;
    } catch (err) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        /* ignore */
      }
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
      cont.want = false;
      cont.starting = false;
      api.setAlwaysListen(false);
      updateAlwaysButton();
      showBubble('麦克风音频处理没起来，您：' + (err && err.message ? err.message : String(err)), 7600);
      return;
    }
    cont.stream = stream;
    cont.ctx = ctx;
    cont.source = source;
    cont.node = node;
    cont.mute = mute;
    cont.sampleRate = ctx.sampleRate || 16000;
    cont.active = true;
    cont.starting = false;
    // 如果正赶上朗读/思考，先静音，等回到 idle 再自动开录。
    cont.paused = phase !== 'idle';
    cont.busy = false;
    cont.chunks = [];
    cont.preroll = [];
    cont.speechSeen = false;
    node.onaudioprocess = onContinuousAudio;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);

    api.setAlwaysListen(true);
    updateAlwaysButton();
    if (!silent) showBubble('语音常开已开启。直接说就行。', 4200);
  }

  function stopContinuous(silent) {
    // 先立愿望再清 active：getUserMedia 期间的关闭也能靠 generation 取消。
    cont.want = false;
    cont.generation += 1;
    cont.starting = false;
    if (!cont.active) {
      api.setAlwaysListen(false);
      updateAlwaysButton();
      return;
    }
    cont.active = false;
    cont.paused = true;
    cont.busy = false;
    cont.chunks = [];
    cont.preroll = [];
    cont.speechSeen = false;
    cleanupContinuousAudio();
    api.setAlwaysListen(false);
    updateAlwaysButton();
    // 正在等识别/正在听：直接回 idle；正在朗读则让它把这一句说完。
    if (phase === 'listening' || phase === 'thinking') setPhase('idle');
    if (!silent) showBubble('语音常开已关闭。', 3200);
  }

  function toggleContinuous() {
    if (cont.want) stopContinuous(false);
    else void startContinuous(false);
  }

  /** 能量 VAD：空闲时存 0.5s 预录；一句话说完就切出来发对话。 */
  function onContinuousAudio(event) {
    if (!cont.active || cont.paused || cont.busy) return;
    const data = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(data.length);
    copy.set(data);
    let energy = 0;
    for (let i = 0; i < copy.length; i++) energy += copy[i] * copy[i];
    const rms = Math.sqrt(energy / copy.length);
    const now = performance.now();

    if (!cont.speechSeen) {
      cont.preroll.push(copy);
      const maxPreroll = Math.max(2, Math.ceil((0.5 * cont.sampleRate) / copy.length));
      while (cont.preroll.length > maxPreroll) cont.preroll.shift();
      if (rms >= vcfg.threshold) {
        cont.speechSeen = true;
        cont.chunks = cont.preroll.slice();
        cont.preroll = [];
        cont.lastLoud = now;
        cont.utteranceStart = now;
        setPhase('listening');
      }
      return;
    }

    cont.chunks.push(copy);
    if (rms >= vcfg.threshold) cont.lastLoud = now;
    const silentFor = now - cont.lastLoud;
    const duration = now - cont.utteranceStart;
    if (silentFor > vcfg.silenceMs || duration > vcfg.maxMs) finalizeContinuous();
  }

  function finalizeContinuous() {
    if (!cont.active || cont.busy || !cont.speechSeen) return;
    const chunks = cont.chunks;
    const held = performance.now() - cont.utteranceStart;
    cont.chunks = [];
    cont.preroll = [];
    cont.speechSeen = false;
    cont.busy = true;
    cont.paused = true;
    setPhase('thinking');

    const wav = toWav(chunks, cont.sampleRate);
    if (held < vcfg.minMs || wav.byteLength < 2000) {
      finishContinuousTurn();
      return;
    }
    void askContinuous(wav);
  }

  function finishContinuousTurn() {
    cont.busy = false;
    cont.speechSeen = false;
    cont.chunks = [];
    cont.preroll = [];
    if (!cont.active) {
      updateAlwaysButton();
      return;
    }
    cont.paused = phase !== 'idle';
    if (phase !== 'idle') setPhase('idle');
    updateAlwaysButton();
  }

  async function askContinuous(wav) {
    const gen = cont.generation;
    const alive = () => cont.active && gen === cont.generation;
    let res;
    try {
      res = await api.voiceAsk(wav);
    } catch (err) {
      if (!alive()) return;
      setPhase('idle');
      playClip('error', true);
      showBubble('出了点问题，您：' + (err && err.message ? err.message : String(err)), 7600);
      window.setTimeout(finishContinuousTurn, 1200);
      return;
    }
    if (!alive()) return;
    if (!res || !res.ok) {
      setPhase('idle');
      playClip('error', true);
      showBubble((res && res.error) || '出了点问题。', 7600);
      window.setTimeout(finishContinuousTurn, 1400);
      return;
    }
    if (!res.reply) {
      setPhase('idle');
      if (res.heard) showBubble('我只听到了「' + res.heard + '」。', 4200);
      window.setTimeout(finishContinuousTurn, 700);
      return;
    }
    speak(res.reply, res.audio, res.mime, finishContinuousTurn);
  }

  alwaysBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleContinuous();
  });
  api.onContinuous((on) => {
    if (on) void startContinuous(false);
    else stopContinuous(false);
  });
  updateAlwaysButton();

  async function ask(wav) {
    setPhase('thinking');
    showBubble('正在检索……', 30000);
    let res;
    try {
      res = await api.voiceAsk(wav);
    } catch (err) {
      setPhase('idle');
      playClip('error', true);
      showBubble('出了点问题，您：' + (err && err.message ? err.message : String(err)), 7600);
      return;
    }
    if (!res || !res.ok) {
      setPhase('idle');
      playClip('error', true);
      showBubble((res && res.error) || '出了点问题。', 7600);
      return;
    }
    if (!res.reply) {
      setPhase('idle');
      showBubble(res.heard ? '我只听到了「' + res.heard + '」。' : '我没听清。', 5200);
      return;
    }
    speak(res.reply, res.audio, res.mime);
  }

  async function finishListening(reason) {
    const session = rec;
    if (!session) return;
    rec = null;
    if (session.noSpeechTimer) {
      window.clearTimeout(session.noSpeechTimer);
      session.noSpeechTimer = null;
    }
    try {
      session.node.onaudioprocess = null;
    } catch {
      /* ignore */
    }
    for (const node of [session.source, session.node, session.mute]) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      session.stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    try {
      await session.ctx.close();
    } catch {
      /* ignore */
    }

    const held = performance.now() - session.startedAt;
    if (reason === 'abort' || held < vcfg.minMs || !session.spoke) {
      setPhase('idle');
      if (reason !== 'abort') showBubble('我没听到声音。', 4200);
      return;
    }
    await ask(toWav(session.chunks, session.sampleRate));
  }

  async function startListening() {
    if (rec || phase === 'thinking') return;
    if (phase === 'speaking') {
      stopSpeaking();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showBubble('这个环境拿不到麦克风接口。', 5600);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      showBubble(micErrorText(err), 7600);
      return;
    }

    // Ask for 16 kHz up front: Chromium resamples the device for us, so the
    // recorder needs no separate resampling step.
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* keep going */
      }
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keeps the graph alive without echoing the mic
    const chunks = [];
    const session = {
      ctx,
      stream,
      source,
      node,
      mute,
      chunks,
      sampleRate: ctx.sampleRate,
      startedAt: performance.now(),
      spoke: false,
      lastLoud: performance.now(),
      noSpeechTimer: null,
    };

    node.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let energy = 0;
      for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
      const rms = Math.sqrt(energy / data.length);
      const now = performance.now();
      if (rms >= vcfg.threshold) {
        session.spoke = true;
        session.lastLoud = now;
      }
      if (now - session.startedAt > vcfg.maxMs) {
        void finishListening('timeout');
        return;
      }
      if (session.spoke && now - session.lastLoud > vcfg.silenceMs) {
        void finishListening('silence');
      }
    };

    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    rec = session;
    setPhase('listening');
    showBubble('我在听。', Math.min(6000, vcfg.maxMs));
    // 一直没开口就自己收：别让麦克风一直开着，也别一直显示「我在听」。
    session.noSpeechTimer = window.setTimeout(() => {
      if (rec !== session || session.spoke) return;
      showBubble('我没听到声音。', 4200);
      void finishListening('abort');
    }, Math.max(2500, Number(vcfg.noSpeechMs) || 8000));
  }

  function toggleVoice() {
    if (cont.active || cont.starting) {
      showBubble('语音常开中，您直接说就行；点「常听」可关闭。', 3600);
      return;
    }
    if (rec) {
      // Second press means "I am done": keep what was captured, do not discard.
      void finishListening('manual');
      return;
    }
    if (phase === 'speaking') {
      stopSpeaking();
      return;
    }
    if (phase === 'thinking') return;
    void startListening();
  }

  api.onVoiceToggle(toggleVoice);
  api.onVoiceSay((text) => {
    if (text) speak(text);
  });
  api.onVoiceSayAudio((payload) => {
    if (payload && payload.text) speak(payload.text, payload.audio, payload.mime);
  });
  api.onVoiceTool((label) => {
    // Only while a turn is in flight; a stale event must not overwrite an answer.
    if (!label || phase !== 'thinking') return;
    showBubble(label + '……', 12000);
  });
  api.onChitchatState((on) => {
    chitchatOn = Boolean(on);
  });
  api.onWorkStatus((status) => {
    applyWorkStatus(status);
  });

  refreshVoices();
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  api
    .voiceConfig()
    .then((cfg) => {
      if (!cfg) return;
      if (cfg.voice) vcfg = Object.assign(vcfg, cfg.voice);
      if (cfg.tts) vcfg.tts = Object.assign(vcfg.tts, cfg.tts);
      if (cfg.name) vcfg.name = cfg.name;
      if (cfg.chitchat) chitchatOn = Boolean(cfg.chitchat.enabled);
      if (cfg.workStatus) applyWorkStatus(cfg.workStatus);
      if (cfg.alwaysListen) {
        // 上次退出时是开着的：稍等启动气泡过去再悄悄恢复。
        window.setTimeout(async () => {
          if (cont.active) return;
          try {
            // 这 1.6 秒里用户可能已经手动关了常开，别再拉起来。
            const now = await api.voiceConfig();
            if (!now || !now.alwaysListen) return;
          } catch {
            /* 取不到就按原设置恢复 */
          }
          void startContinuous(true);
        }, 1600);
      }
      if (cfg.hasBrain === false) {
        window.setTimeout(() => {
          showBubble('语音已就绪，但还没接入大脑。请在 desktop-butler-config.json 填 llm.apiKey。', 9000);
        }, 5200);
      }
    })
    .catch(() => {});

  // Boot: first video carries the idle loop, second is the crossfade buffer.
  vids[0].src = 'assets/webm/idle.webm';
  vids[0].classList.add('front');
  vids[0].addEventListener(
    'loadeddata',
    () => {
      vids[0].play().catch(() => {});
    },
    { once: true },
  );
  vids[0].load();

  window.setTimeout(() => showBubble('系统已上线。', 5200), 1400);

  window.setInterval(() => {
    if (document.hidden || drag) return;
    if (phase !== 'idle') return;
    // 语音常开时麦克风一直听着，静态待机台词不要干扰。
    if (cont.active) return;
    // 闲聊模式开着时，主动开口交给主进程的模型，静态台词不抢话。
    if (chitchatOn) return;
    if (bubble.classList.contains('on')) return;
    showBubble(pick(IDLE_LINES), 6500);
  }, 150000);
})();
