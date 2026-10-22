import { createBody, worldPoints, step, diagnostics, MU0 } from './physics.js';

const $ = id => document.getElementById(id);
const canvas = $('simulation');
const ctx = canvas.getContext('2d');
const colors = { bg: '#101a27', grid: '#233244', text: '#a7b6c6', white: '#e8f1f5', mint: '#79e3c3', copper: '#f3ad78', pink: '#ff91b0' };
const TAU = Math.PI * 2;
const defaults = { wireCurrent: 1500, loopCurrent: 80, mass: 20, duration: 8, vx: 0, vy: 0, omega: 0 };
const limits = { wireCurrent: [0, 10000], loopCurrent: [0, 500], mass: [1, 1000], duration: [0.5, 60], vx: [-5, 5], vy: [-5, 5], omega: [-20, 20] };
const numericIds = Object.keys(defaults);
const camera = { x: .8, y: 0, scale: 220 };
const view = { w: 0, h: 0, dpr: 1 };
let body, state, initialEnergy = 0, energyScale = 1;
let points = [], customPoints = null, drawing = false;
let wireSign = 1, loopSign = 1, playing = false, history = [], collision = null;
let duration = 8, params = { Iwire: 1500, Iloop: 80, wireRadius: .025 };
let lastFrame = null, playbackTime = 0, lastAnnouncement = '', spaceDown = false;
let pointer = null, hover = null, flash = '', flashUntil = 0;
let manualCamera = false;
let simulationValid = false, appliedInputs = '';

const fmt = (v, digits = 2) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
const pointCopy = p => ({ x: p.x, y: p.y });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const setText = (id, value) => { const el = $(id); if (el && el.textContent !== value) el.textContent = value; };
const toScreen = p => ({ x: view.w / 2 + (p.x - camera.x) * camera.scale, y: view.h / 2 - (p.y - camera.y) * camera.scale });
const toWorld = p => ({ x: camera.x + (p.x - view.w / 2) / camera.scale, y: camera.y - (p.y - view.h / 2) / camera.scale });
const pointerPoint = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function announce(message, isError = false) {
  setText('status', message);
  $('status').dataset.state = isError ? 'error' : playing ? 'running' : 'ready';
  lastAnnouncement = message;
}

function toast(message) {
  flash = message;
  flashUntil = performance.now() + 3500;
}

function readInputs() {
  const values = {};
  for (const id of numericIds) {
    const el = $(id), value = Number(el.value);
    const [min, max] = limits[id];
    if (el.value.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
      el.setAttribute('aria-invalid', 'true');
      throw new Error(`${el.dataset.label || ({ wireCurrent: 'Ток провода', loopCurrent: 'Ток контура', mass: 'Масса', duration: 'Длительность', vx: 'Скорость по x', vy: 'Скорость по y', omega: 'Угловая скорость' })[id]}: допустимо от ${min} до ${max}.`);
    }
    el.removeAttribute('aria-invalid');
    values[id] = value;
  }
  return values;
}

function presetPoints(name) {
  if (name === 'rectangle') return [{ x: .47, y: -.22 }, { x: 1.13, y: -.22 }, { x: 1.13, y: .22 }, { x: .47, y: .22 }];
  if (name === 'triangle') return [{ x: .47, y: -.24 }, { x: 1.11, y: -.15 }, { x: .86, y: .34 }];
  if (name === 'custom' && customPoints) return customPoints.map(pointCopy);
  return Array.from({ length: 80 }, (_, i) => ({ x: .8 + .25 * Math.cos(i * TAU / 80), y: .25 * Math.sin(i * TAU / 80) }));
}

function syncButtons() {
  $('run').disabled = drawing || !body || !simulationValid || numericIds.some(id => $(id).getAttribute('aria-invalid') === 'true');
  $('run').textContent = playing ? 'Пауза' : playbackTime >= duration - 1e-8 || (collision && playbackTime >= collision.time - 1e-8) ? 'Повторить' : playbackTime > 0 ? 'Продолжить' : 'Запустить';
  $('run').setAttribute('aria-pressed', String(playing));
  $('drawToggle').classList.toggle('active', drawing);
  $('drawToggle').setAttribute('aria-pressed', String(drawing));
  $('drawToggle').textContent = drawing ? 'Отменить рисование' : 'Нарисовать контур';
  $('finishDrawing').disabled = !drawing || points.length < 3;
  $('undoPoint').disabled = !drawing || !points.length;
  $('timeline').disabled = history.length < 2 || drawing;
  $('export').disabled = history.length < 2;
  canvas.classList.toggle('is-drawing', drawing);
  canvas.style.cursor = pointer?.pan ? 'grabbing' : drawing ? 'crosshair' : spaceDown ? 'grab' : 'default';
  setText('wireDirection', wireSign > 0 ? 'Вверх ↑' : 'Вниз ↓');
  setText('loopDirection', loopSign > 0 ? 'Против часовой ↺' : 'По часовой ↻');
  setText('modeHint', drawing ? 'Ставьте точки кликами или нарисуйте контур одним движением.' : 'Колесо — масштаб · пробел + перетаскивание — обзор');
}

function resetSimulation(message = 'Готово к запуску') {
  playing = false;
  let success = false;
  try {
    const v = readInputs();
    const nextParams = { Iwire: v.wireCurrent * wireSign, Iloop: v.loopCurrent * loopSign, wireRadius: .025 };
    const nextBody = createBody(presetPoints($('preset').value), { mass: v.mass / 1000, vx: v.vx, vy: v.vy, omega: v.omega, wireRadius: .025 });
    const d = diagnostics(nextBody, nextBody.initialState, nextParams);
    duration = v.duration;
    params = nextParams;
    body = nextBody;
    state = { ...body.initialState };
    history = [{ ...state }];
    playbackTime = 0;
    collision = null;
    initialEnergy = d.totalEnergy;
    energyScale = Math.max(Math.abs(initialEnergy), Math.abs(d.potential), d.kinetic, 1e-10);
    setText('durationValue', fmt(duration, 1));
    setText('shapeInfo', `${$('preset').value === 'circle' ? 'Круг' : $('preset').value === 'rectangle' ? 'Прямоугольник' : $('preset').value === 'triangle' ? 'Треугольник' : 'Свой контур'} · ${fmt(body.perimeter, 2)} м · ${fmt(body.mass * 1000, 0)} г`);
    appliedInputs = JSON.stringify(v);
    simulationValid = true;
    success = true;
    announce(message);
  } catch (e) {
    // Keep the last valid drawing visible, but disable execution until every
    // parameter has been repaired. Its cached trajectory stays internally
    // consistent with its old body and currents.
    simulationValid = false;
    announce(e.message, true);
  }
  syncButtons();
  updateMetrics();
  return success;
}

function resetView() {
  manualCamera = false;
  camera.x = .8;
  camera.y = 0;
  camera.scale = Math.max(30, Math.min(view.w / 3.2, view.h / 2.15));
  if (body && $('preset').value === 'custom') {
    const p = worldPoints(body, body.initialState);
    const minX = Math.min(0, ...p.map(v => v.x)), maxX = Math.max(0, ...p.map(v => v.x));
    const minY = Math.min(-.3, ...p.map(v => v.y)), maxY = Math.max(.3, ...p.map(v => v.y));
    camera.x = (minX + maxX) / 2 + .12;
    camera.y = (minY + maxY) / 2;
    camera.scale = Math.min(view.w / Math.max(2, (maxX - minX) * 1.7), view.h / Math.max(1.8, (maxY - minY) * 1.6));
  }
}

function setPreset(name) {
  if (!['circle', 'rectangle', 'triangle', 'custom'].includes(name)) return;
  $('preset').value = name;
  if (name === 'custom' && !customPoints) { startDrawing(); return; }
  drawing = false;
  points = [];
  resetSimulation();
  resetView();
}

function startDrawing() {
  playing = false;
  drawing = true;
  points = [];
  hover = null;
  announce('Нарисуйте замкнутый контур с одной стороны провода.');
  syncButtons();
}

function simplify(input, tolerance = .004) {
  if (input.length < 4) return input;
  const sq = tolerance * tolerance;
  function rdp(a) {
    let best = sq, index = 0;
    const start = a[0], end = a.at(-1), dx = end.x - start.x, dy = end.y - start.y, length2 = dx * dx + dy * dy;
    for (let i = 1; i < a.length - 1; i++) {
      const t = length2 ? clamp(((a[i].x - start.x) * dx + (a[i].y - start.y) * dy) / length2, 0, 1) : 0;
      const d = (a[i].x - start.x - t * dx) ** 2 + (a[i].y - start.y - t * dy) ** 2;
      if (d > best) { best = d; index = i; }
    }
    return index ? [...rdp(a.slice(0, index + 1)).slice(0, -1), ...rdp(a.slice(index))] : [start, end];
  }
  return rdp(input);
}

function finishDrawing(freehand = false) {
  if (!drawing || points.length < 3) return;
  let candidate = (freehand ? simplify(points, 2.5 / camera.scale) : points).map(pointCopy);
  if (candidate.length > 3 && Math.hypot(candidate[0].x - candidate.at(-1).x, candidate[0].y - candidate.at(-1).y) < 8 / camera.scale) candidate.pop();
  try {
    const v = readInputs();
    createBody(candidate, { mass: v.mass / 1000, wireRadius: .025 });
    customPoints = candidate;
    drawing = false;
    points = [];
    hover = null;
    $('preset').value = 'custom';
    resetSimulation('Контур готов. Можно запускать.');
  } catch (e) { announce(e.message, true); toast(e.message); syncButtons(); }
}

function interpolateAt(t) {
  if (history.length === 1 || t <= 0) return { ...history[0] };
  let lo = 0, hi = history.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (history[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = history[lo], b = history[hi];
  if (t >= b.time - 1e-10) return { ...b };
  if (t <= a.time + 1e-10) return { ...a };
  // Evaluate between recorded samples with the same integrator, so the energy
  // readout is not polluted by linear interpolation of position and velocity.
  return step(body, a, params, t - a.time).state;
}

function ensureHistory(t) {
  let latest = history.at(-1);
  let steps = 0;
  while (!collision && latest.time < t - 1e-10 && steps++ < 300) {
    const dt = Math.min(.02, duration - latest.time);
    if (dt <= 1e-10) break;
    const result = step(body, latest, params, dt);
    latest = result.state;
    history.push({ ...latest });
    collision = result.collision;
  }
}

function toggleRun() {
  if (drawing) return;
  if (playing) { playing = false; announce('Пауза'); syncButtons(); return; }
  try {
    const currentInputs = readInputs();
    if (!simulationValid || JSON.stringify(currentInputs) !== appliedInputs) {
      if (!resetSimulation()) return;
    }
  } catch (e) { simulationValid = false; announce(e.message, true); syncButtons(); return; }
  if (!body || !simulationValid) return;
  if (playbackTime >= duration - 1e-8 || (collision && playbackTime >= collision.time - 1e-8)) resetSimulation();
  playing = true;
  lastFrame = null;
  announce('Моделирование');
  syncButtons();
}

function updateMetrics() {
  if (!body || !state) return;
  const d = diagnostics(body, state, params);
  const relative = Math.abs(d.totalEnergy - initialEnergy) / energyScale * 100;
  setText('timeValue', fmt(playbackTime, 2));
  setText('progressLabel', `${fmt(playbackTime, 2)} / ${fmt(duration, 1)} с`);
  setText('statSpeed', `${fmt(d.speed, 3)} м/с`);
  setText('statForce', `${fmt(Math.abs(d.fx) * 1000, 3)} мН`);
  setText('statRotation', `${fmt(state.omega, 3)} рад/с`);
  setText('statEnergy', `${relative < .001 ? '< 0,001' : fmt(relative, 3)} %`);
  $('statEnergy').title = `Отклонение K + U от начального значения; U — эффективный потенциал взаимодействия постоянных токов. K + U = ${d.totalEnergy.toExponential(6)} Дж`;
  $('timeline').value = String(Math.round(playbackTime / duration * 1000));
  setText('timelineHint', history.length > 1 ? `Записано ${fmt(history.at(-1).time, 2)} с · перетащите ползунок для просмотра` : 'Траектория появится после запуска');
}

function exportCSV() {
  if (history.length < 2) return;
  const rows = ['time_s,x_m,y_m,vx_m_s,vy_m_s,angle_rad,omega_rad_s,force_x_N,torque_N_m,total_energy_J'];
  for (const s of history) {
    const d = diagnostics(body, s, params);
    rows.push([s.time, s.x, s.y, s.vx, s.vy, s.angle, s.omega, d.fx, d.torque, d.totalEnergy].map(v => v.toPrecision(12)).join(','));
  }
  const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'current-loop-trajectory.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Траектория сохранена в CSV');
}

function pathWorld(p, close = false) {
  if (!p.length) return;
  ctx.beginPath();
  p.forEach((point, i) => { const s = toScreen(point); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
  if (close) ctx.closePath();
}

function arrow(x, y, dx, dy, color, width = 2, head = 7) {
  const length = Math.hypot(dx, dy);
  if (length < 1) return;
  const ux = dx / length, uy = dy / length;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + dx, y + dy);
  ctx.lineTo(x + dx - head * ux + head * .48 * uy, y + dy - head * uy - head * .48 * ux);
  ctx.lineTo(x + dx - head * ux - head * .48 * uy, y + dy - head * uy + head * .48 * ux);
  ctx.closePath(); ctx.fill();
}

function roundRect(x, y, w, h, r = 8) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}

function label(text, x, y, color = colors.text, align = 'left') {
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function drawGrid() {
  const target = 70 / camera.scale;
  const base = 10 ** Math.floor(Math.log10(target));
  const spacing = [1, 2, 5, 10].map(v => v * base).find(v => v >= target);
  const a = toWorld({ x: 0, y: view.h }), b = toWorld({ x: view.w, y: 0 });
  ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(a.x / spacing) * spacing; x <= b.x + 1e-8; x += spacing) {
    const s = toScreen({ x, y: 0 }); ctx.moveTo(Math.round(s.x) + .5, 0); ctx.lineTo(Math.round(s.x) + .5, view.h);
  }
  for (let y = Math.ceil(a.y / spacing) * spacing; y <= b.y + 1e-8; y += spacing) {
    const s = toScreen({ x: 0, y }); ctx.moveTo(0, Math.round(s.y) + .5); ctx.lineTo(view.w, Math.round(s.y) + .5);
  }
  ctx.stroke();
  const axisY = toScreen({ x: 0, y: 0 }).y;
  ctx.strokeStyle = '#3c4b5a'; ctx.setLineDash([3, 6]); ctx.beginPath(); ctx.moveTo(0, axisY); ctx.lineTo(view.w, axisY); ctx.stroke(); ctx.setLineDash([]);
  if (axisY > 20 && axisY < view.h - 40) {
    for (let x = Math.ceil(a.x / spacing) * spacing; x <= b.x + 1e-8; x += spacing) {
      const s = toScreen({ x, y: 0 });
      if (Math.abs(x) > spacing * .1 && s.x > 24 && s.x < view.w - 35) label(fmt(x, spacing < .1 ? 2 : 1), s.x, axisY + 16, '#6d8093', 'center');
    }
  }
  label('x, м', view.w - 20, clamp(axisY + 16, 25, view.h - 35), '#8092a3', 'right');
  label('y, м', 17, 25, '#8092a3');
  for (let y = Math.ceil(a.y / spacing) * spacing; y <= b.y + 1e-8; y += spacing) {
    const s = toScreen({ x: 0, y });
    if (Math.abs(y) > spacing * .1 && s.y > 60 && s.y < view.h - 70) label(fmt(y, spacing < .1 ? 2 : 1), 17, s.y, '#647a8f');
  }
  const scalePx = spacing * camera.scale;
  ctx.strokeStyle = '#7f90a2'; ctx.lineWidth = 1.3; ctx.beginPath();
  ctx.moveTo(24, view.h - 30); ctx.lineTo(24 + scalePx, view.h - 30);
  ctx.moveTo(24, view.h - 34); ctx.lineTo(24, view.h - 26); ctx.moveTo(24 + scalePx, view.h - 34); ctx.lineTo(24 + scalePx, view.h - 26); ctx.stroke();
  label(`${fmt(spacing, spacing < .1 ? 2 : 1)} м`, 24 + scalePx / 2, view.h - 45, '#91a2b3', 'center');
}

function drawField() {
  if (!$('showField').checked || !params.Iwire) return;
  const wireX = toScreen({ x: 0, y: 0 }).x;
  const spacing = 76;
  for (let x = ((wireX % spacing) + spacing) % spacing; x < view.w; x += spacing) {
    const wx = toWorld({ x, y: 0 }).x;
    if (Math.abs(wx) < .06) continue;
    const alpha = clamp(.16 + .14 / Math.max(.5, Math.abs(wx)), .15, .36);
    ctx.strokeStyle = `rgba(143,169,197,${alpha})`; ctx.fillStyle = `rgba(143,169,197,${alpha})`; ctx.lineWidth = 1;
    for (let y = 50; y < view.h - 60; y += spacing) {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.stroke();
      if (wireSign * wx > 0) {
        ctx.beginPath(); ctx.moveTo(x - 2.5, y - 2.5); ctx.lineTo(x + 2.5, y + 2.5); ctx.moveTo(x + 2.5, y - 2.5); ctx.lineTo(x - 2.5, y + 2.5); ctx.stroke();
      } else { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, TAU); ctx.fill(); }
    }
  }
}

function drawWire(now) {
  const x = toScreen({ x: 0, y: 0 }).x;
  const radius = Math.max(3, params.wireRadius * camera.scale);
  const g = ctx.createLinearGradient(x - radius, 0, x + radius, 0);
  g.addColorStop(0, '#986e51'); g.addColorStop(.35, '#f5b580'); g.addColorStop(.65, '#e49a66'); g.addColorStop(1, '#8f634c');
  ctx.fillStyle = 'rgba(243,173,120,.035)'; ctx.fillRect(x - radius * 3, 0, radius * 6, view.h);
  ctx.fillStyle = g; ctx.fillRect(x - radius, 0, radius * 2, view.h);
  if (params.Iwire) {
    const offset = (now * .025 * wireSign) % 90;
    for (let y = -90 + offset; y < view.h + 90; y += 90) arrow(x, y + (wireSign > 0 ? 13 : -13), 0, -wireSign * 26, '#2c2521', 1.8, 5);
  }
  if (x >= 0 && x <= view.w) {
    const lx = clamp(x + radius + 14, 15, view.w - 145);
    ctx.fillStyle = 'rgba(16,26,39,.9)'; roundRect(lx - 7, 16, 143, 46, 7); ctx.fill();
    label('БЕСКОНЕЧНЫЙ ПРОВОД', lx, 31, colors.copper);
    label(`I₁ = ${fmt(Math.abs(params.Iwire), 0)} A ${wireSign > 0 ? '↑' : '↓'}`, lx, 48, '#d9bca5');
  }
}

function drawCurrentArrows(p, now) {
  if (!p.length || !params.Iloop) return;
  const lengths = p.map((a, i) => Math.hypot(p[(i + 1) % p.length].x - a.x, p[(i + 1) % p.length].y - a.y));
  const total = lengths.reduce((a, b) => a + b, 0);
  const count = clamp(Math.floor(total * camera.scale / 135), 2, 8);
  for (let a = 0; a < count; a++) {
    let distance = (((a / count + now * .000055 * loopSign) % 1 + 1) % 1) * total, i = 0;
    while (i < lengths.length - 1 && distance > lengths[i]) { distance -= lengths[i]; i++; }
    const from = p[i], to = p[(i + 1) % p.length], t = distance / lengths[i];
    const s = toScreen({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    const dx = (to.x - from.x) / lengths[i] * loopSign, dy = -(to.y - from.y) / lengths[i] * loopSign;
    // A dark underlay keeps the moving arrowheads legible on the contour itself.
    arrow(s.x - dx * 9, s.y - dy * 9, dx * 18, dy * 18, colors.bg, 5, 9);
    arrow(s.x - dx * 9, s.y - dy * 9, dx * 18, dy * 18, colors.mint, 2, 6);
  }
}

function drawForces(p) {
  if (!$('showForces').checked || !body) return;
  const k = MU0 * params.Iwire * params.Iloop / (2 * Math.PI);
  const samples = Math.min(16, p.length);
  for (let n = 0; n < samples; n++) {
    const i = Math.floor(n * p.length / samples), a = p[i], b = p[(i + 1) % p.length];
    const s = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    const fx = -k * (b.y - a.y) / ((a.x + b.x) / 2), fy = k * (b.x - a.x) / ((a.x + b.x) / 2);
    const forceDensity = Math.hypot(fx, fy) / Math.max(segmentLength, 1e-10);
    const length = clamp(Math.sqrt(forceDensity) * 100, 0, 42);
    if (Math.hypot(fx, fy) > 1e-12) arrow(s.x, s.y, fx / Math.hypot(fx, fy) * length, -fy / Math.hypot(fx, fy) * length, 'rgba(255,145,176,.62)', 1.3, 5);
  }
  const d = diagnostics(body, state, params), center = toScreen(state);
  if (Math.abs(d.fx) > 1e-12) {
    const length = clamp(35 + Math.log1p(Math.abs(d.fx) * 1000) * 12, 35, 110);
    arrow(center.x, center.y, Math.sign(d.fx) * length, 0, colors.pink, 2.8, 9);
    label('F', center.x + Math.sign(d.fx) * (length + 12), center.y - 12, colors.pink, 'center');
  }
}

function drawLoop(now) {
  if (!body || !state) return;
  const p = worldPoints(body, state);
  if ($('showTrail').checked && history.length > 1) {
    const trail = history.filter((s, i) => s.time <= playbackTime + 1e-8 && i % 3 === 0);
    if (!trail.length || trail.at(-1).time < playbackTime) trail.push(state);
    pathWorld(trail); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(121,227,195,.36)'; ctx.setLineDash([3, 5]); ctx.stroke(); ctx.setLineDash([]);
    if (playbackTime > .02) { pathWorld(worldPoints(body, body.initialState), true); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(121,227,195,.18)'; ctx.stroke(); }
  }
  if (!drawing) {
    pathWorld(p, true); ctx.fillStyle = 'rgba(121,227,195,.035)'; ctx.fill();
    ctx.shadowColor = 'rgba(121,227,195,.35)'; ctx.shadowBlur = 14; ctx.strokeStyle = colors.mint; ctx.lineWidth = 3; ctx.stroke(); ctx.shadowBlur = 0;
    drawCurrentArrows(p, now);
    drawForces(p);
    const center = toScreen(state);
    ctx.fillStyle = colors.mint; ctx.beginPath(); ctx.arc(center.x, center.y, 3, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(121,227,195,.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(center.x, center.y, 8, 0, TAU); ctx.stroke();
    const top = Math.min(...p.map(v => toScreen(v).y)), right = Math.max(...p.map(v => toScreen(v).x));
    if (right > -30 && right < view.w + 100 && top > -30 && top < view.h) label(`I₂ = ${fmt(Math.abs(params.Iloop), 0)} A`, clamp(center.x, 65, view.w - 65), Math.max(25, top - 19), colors.mint, 'center');
  } else {
    pathWorld(p, true); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(121,227,195,.16)'; ctx.setLineDash([4, 5]); ctx.stroke(); ctx.setLineDash([]);
  }
  if (!drawing && (p.every(v => toScreen(v).x > view.w) || p.every(v => toScreen(v).x < 0) || p.every(v => toScreen(v).y > view.h) || p.every(v => toScreen(v).y < 0))) {
    const c = toScreen(state), s = { x: clamp(c.x, 30, view.w - 30), y: clamp(c.y, 86, view.h - 80) };
    const dx = c.x - view.w / 2, dy = c.y - view.h / 2, d = Math.hypot(dx, dy);
    arrow(s.x - dx / d * 17, s.y - dy / d * 17, dx / d * 22, dy / d * 22, colors.mint, 2, 7);
    label('контур за кадром · уменьшите масштаб', view.w / 2, view.h - 24, colors.mint, 'center');
  }
}

function drawDraft() {
  if (!drawing) return;
  const draft = hover && points.length ? [...points, hover] : points;
  if (points.length >= 3) { pathWorld(points, true); ctx.fillStyle = 'rgba(121,227,195,.055)'; ctx.fill(); }
  pathWorld(draft); ctx.strokeStyle = colors.mint; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
  points.forEach((p, i) => {
    if (points.length > 40 && i % 4 && i !== points.length - 1) return;
    const s = toScreen(p); ctx.beginPath(); ctx.arc(s.x, s.y, i === 0 ? 5 : 3, 0, TAU); ctx.fillStyle = i === 0 ? colors.white : colors.mint; ctx.fill();
  });
  const text = points.length ? `${points.length} точек · ${points.length < 3 ? 'добавьте ещё точки' : 'замкните контур кнопкой или двойным кликом'}` : 'Нарисуйте контур справа или слева от провода';
  ctx.font = '13px system-ui, sans-serif'; const width = Math.min(view.w - 30, ctx.measureText(text).width + 30);
  ctx.fillStyle = 'rgba(16,26,39,.94)'; roundRect((view.w - width) / 2, view.h - 76, width, 36, 8); ctx.fill();
  ctx.fillStyle = colors.mint; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, view.w / 2, view.h - 58, width - 20);
}

function drawOverlay(now) {
  ctx.fillStyle = 'rgba(16,26,39,.8)'; roundRect(view.w - 104, 17, 85, 26, 6); ctx.fill();
  label('g = 0', view.w - 62, 30, '#95a6b7', 'center');
  if (flash && now < flashUntil) {
    ctx.font = '12px system-ui, sans-serif'; const width = Math.min(view.w - 30, ctx.measureText(flash).width + 32);
    ctx.fillStyle = 'rgba(41,56,73,.96)'; roundRect((view.w - width) / 2, view.h - 122, width, 36); ctx.fill();
    ctx.fillStyle = colors.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(flash, view.w / 2, view.h - 104, width - 20);
  }
}

function render(now) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, view.w, view.h);
  drawGrid(); drawField(); drawWire(now); drawLoop(now); drawDraft(); drawOverlay(now);
}

function keepLoopInView() {
  if (manualCamera || !body || !state) return;
  const p = worldPoints(body, state), screen = p.map(toScreen);
  const nearEdge = screen.some(s => s.x < view.w * .12 || s.x > view.w * .88 || s.y < view.h * .16 || s.y > view.h * .84);
  if (!nearEdge) return;
  const minX = Math.min(0, ...p.map(v => v.x)), maxX = Math.max(0, ...p.map(v => v.x));
  const minY = Math.min(-.4, ...p.map(v => v.y)), maxY = Math.max(.4, ...p.map(v => v.y));
  const padding = Math.max(.25, body.maxRadius);
  const targetScale = Math.min(camera.scale, view.w / ((maxX - minX + padding * 2) * 1.3), view.h / ((maxY - minY + padding * 2) * 1.3));
  camera.scale += (targetScale - camera.scale) * .12;
  camera.x += ((minX + maxX) / 2 - camera.x) * .12;
  camera.y += ((minY + maxY) / 2 - camera.y) * .12;
}

function frame(now) {
  if (playing && body && !drawing) {
    const delta = lastFrame == null ? 0 : Math.min((now - lastFrame) / 1000, .12) * Number($('speed').value);
    try {
      const target = Math.min(playbackTime + delta, duration);
      ensureHistory(target);
      playbackTime = Math.min(target, history.at(-1).time);
      state = interpolateAt(playbackTime);
      keepLoopInView();
      if (collision && playbackTime >= collision.time - 1e-8) {
        playing = false; announce('Контакт с проводом — расчёт остановлен.'); toast('Контур достиг поверхности провода'); syncButtons();
      } else if (playbackTime >= duration - 1e-8) {
        playing = false; announce('Расчёт завершён'); syncButtons();
      }
      updateMetrics();
    } catch (e) { playing = false; announce(e.message, true); syncButtons(); }
  }
  lastFrame = now;
  render(now);
  requestAnimationFrame(frame);
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const first = !view.w;
  view.w = rect.width;
  view.h = rect.height;
  view.dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  if (first) resetView();
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
  const screen = pointerPoint(e);
  canvas.focus({ preventScroll: true });
  if (e.button !== 0 || spaceDown || !drawing && e.pointerType === 'touch') {
    manualCamera = true;
    pointer = { id: e.pointerId, pan: true, screen, camera: { ...camera } };
  } else if (drawing) {
    const world = toWorld(screen);
    if (points.length >= 3 && Math.hypot(toScreen(points[0]).x - screen.x, toScreen(points[0]).y - screen.y) < 12) { finishDrawing(); return; }
    pointer = { id: e.pointerId, pan: false, start: screen, last: screen, originalCount: points.length, moved: 0 };
    points.push(world);
    syncButtons();
  }
  if (pointer) canvas.setPointerCapture(e.pointerId);
  syncButtons();
});

canvas.addEventListener('pointermove', e => {
  const screen = pointerPoint(e);
  hover = drawing ? toWorld(screen) : null;
  if (!pointer || pointer.id !== e.pointerId) return;
  if (pointer.pan) {
    camera.x = pointer.camera.x - (screen.x - pointer.screen.x) / camera.scale;
    camera.y = pointer.camera.y + (screen.y - pointer.screen.y) / camera.scale;
  } else {
    const distance = Math.hypot(screen.x - pointer.last.x, screen.y - pointer.last.y);
    pointer.moved = Math.max(pointer.moved, Math.hypot(screen.x - pointer.start.x, screen.y - pointer.start.y));
    if (pointer.moved > 8 && distance > 4 && points.length < 1500) {
      points.push(toWorld(screen)); pointer.last = screen; syncButtons();
    }
  }
});

function endPointer(e) {
  if (!pointer || pointer.id !== e.pointerId) return;
  const finished = pointer;
  pointer = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (e.type !== 'pointercancel' && !finished.pan && finished.originalCount === 0 && finished.moved > 25 && points.length >= 6) finishDrawing(true);
  syncButtons();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!pointer) hover = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('dblclick', e => { if (drawing) { e.preventDefault(); finishDrawing(); } });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  manualCamera = true;
  const p = pointerPoint(e), before = toWorld(p);
  camera.scale = clamp(camera.scale * Math.exp(-e.deltaY * .0012), .2, 2500);
  const after = toWorld(p);
  camera.x += before.x - after.x; camera.y += before.y - after.y;
}, { passive: false });

document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); spaceDown = true; syncButtons(); }
  if (e.code === 'Enter' && drawing) { e.preventDefault(); finishDrawing(); }
  if ((e.code === 'Backspace' || e.code === 'Delete') && drawing) { e.preventDefault(); points.pop(); syncButtons(); }
  if (e.code === 'Escape' && drawing) { drawing = false; points = []; announce('Рисование отменено'); syncButtons(); }
});
document.addEventListener('keyup', e => { if (e.code === 'Space') { spaceDown = false; syncButtons(); } });
window.addEventListener('blur', () => { spaceDown = false; pointer = null; syncButtons(); });

$('preset').addEventListener('change', e => setPreset(e.target.value));
$('drawToggle').addEventListener('click', () => {
  if (drawing) { drawing = false; points = []; hover = null; announce('Рисование отменено'); syncButtons(); }
  else startDrawing();
});
$('finishDrawing').addEventListener('click', () => finishDrawing());
$('undoPoint').addEventListener('click', () => { points.pop(); syncButtons(); });
$('run').addEventListener('click', toggleRun);
$('reset').addEventListener('click', () => { drawing = false; points = []; resetSimulation('Начальное состояние восстановлено'); });
$('resetView').addEventListener('click', resetView);
$('reverseWire').addEventListener('click', () => { wireSign *= -1; resetSimulation('Направление тока провода изменено'); });
$('reverseLoop').addEventListener('click', () => { loopSign *= -1; resetSimulation('Направление тока контура изменено'); });
$('export').addEventListener('click', exportCSV);
numericIds.forEach(id => {
  $(id).addEventListener('input', () => resetSimulation('Параметры изменены. Готово к запуску.'));
  $(id).addEventListener('change', () => {
    try { if (JSON.stringify(readInputs()) === appliedInputs && simulationValid) return; } catch { /* reset shows the validation message */ }
    resetSimulation('Параметры изменены. Готово к запуску.');
  });
});
$('timeline').addEventListener('input', e => {
  playing = false;
  playbackTime = Math.min(Number(e.target.value) / 1000 * duration, history.at(-1).time);
  state = interpolateAt(playbackTime);
  announce('Просмотр траектории'); updateMetrics(); syncButtons();
});

new ResizeObserver(resize).observe(canvas);
resetSimulation();
resize();
requestAnimationFrame(frame);

window.currentLoopLab = Object.freeze({
  getState: () => ({ ...state, playing, drawing, duration, collision: collision ? { ...collision } : null, params: { ...params }, camera: { ...camera } }),
  getHistory: () => history.map(s => ({ ...s })),
  getBody: () => structuredClone(body),
  setPreset,
  reset: () => resetSimulation(),
  run: toggleRun,
  finishDrawing,
});
