/**
 * Planar rigid current loop in the field of an infinite, fixed y-directed wire.
 * SI units throughout. Positive loop current follows the CCW vertex order.
 * The currents are maintained externally: no induction, gravity or damping.
 */
export const MU0 = 4 * Math.PI * 1e-7;
export const DEFAULT_PARAMS = Object.freeze({ Iwire: 1500, Iloop: 80, wireRadius: 0.025 });

const EPS = 1e-10;
const CONTACT_EPS = 1e-7;
const finite = Number.isFinite;
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function intersects(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  const on = (p, q, r) => Math.abs(cross(p, q, r)) < EPS &&
    r.x >= Math.min(p.x, q.x) - EPS && r.x <= Math.max(p.x, q.x) + EPS &&
    r.y >= Math.min(p.y, q.y) - EPS && r.y <= Math.max(p.y, q.y) + EPS;
  return (abC * abD < 0 && cdA * cdB < 0) ||
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

/** Accepts {x,y} objects or [x,y] pairs. The closing point is optional. */
export function createBody(input, options = {}) {
  if (!Array.isArray(input)) throw new Error('Нарисуйте замкнутый контур.');
  let points = input.map(p => ({ x: Number(p.x ?? p[0]), y: Number(p.y ?? p[1]) }));
  if (points.some(p => !finite(p.x) || !finite(p.y))) throw new Error('Координаты должны быть конечными числами.');
  // Pointer gestures often contain repeated consecutive coordinates.
  points = points.filter((p, i) => i === 0 || distance(p, points[i - 1]) > EPS);
  if (points.length > 1 && distance(points[0], points.at(-1)) < EPS) points.pop();
  if (points.length < 3) throw new Error('Для контура нужны хотя бы три разные точки.');
  if (points.length > 2000) throw new Error('В контуре слишком много точек.');
  const mass = Number(options.mass ?? 0.02);
  const wireRadius = Number(options.wireRadius ?? DEFAULT_PARAMS.wireRadius);
  if (!finite(mass) || mass <= 0) throw new Error('Масса должна быть положительной.');
  if (!finite(wireRadius) || wireRadius <= 0) throw new Error('Радиус провода должен быть положительным.');
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) {
        throw new Error('Контур не должен пересекать или касаться самого себя.');
      }
    }
  }
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    twiceArea += a.x * b.y - b.x * a.y;
    // Adjacent segments cannot double back and overlap, either.
    const c = points[(i + 2) % points.length];
    if (Math.abs(cross(a, b, c)) < EPS &&
      (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > EPS) {
      throw new Error('Участки контура не должны накладываться друг на друга.');
    }
  }
  if (Math.abs(twiceArea) < 1e-8) throw new Error('У контура должна быть ненулевая площадь.');
  if (twiceArea < 0) points.reverse();
  const side = Math.sign(points[0].x);
  if (points.some(p => side * p.x <= wireRadius)) {
    throw new Error('Нарисуйте весь контур с одной стороны провода, за пределами его поверхности.');
  }

  let perimeter = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], length = distance(a, b);
    perimeter += length;
    cx += length * (a.x + b.x) / 2;
    cy += length * (a.y + b.y) / 2;
  }
  cx /= perimeter;
  cy /= perimeter;
  const vertices = points.map(p => ({ x: p.x - cx, y: p.y - cy }));
  let inertia = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    inertia += distance(a, b) * (a.x * a.x + a.y * a.y + a.x * b.x + a.y * b.y + b.x * b.x + b.y * b.y) / 3;
  }
  inertia *= mass / perimeter;
  const initialState = { x: cx, y: cy, vx: Number(options.vx ?? 0), vy: Number(options.vy ?? 0), angle: 0, omega: Number(options.omega ?? 0), time: 0 };
  if (Object.values(initialState).some(v => !finite(v))) throw new Error('Начальная скорость должна быть конечным числом.');
  return { vertices, mass, inertia, perimeter, area: Math.abs(twiceArea) / 2,
    maxRadius: Math.max(...vertices.map(p => Math.hypot(p.x, p.y))), side, wireRadius, initialState };
}

export function worldPoints(body, state = body.initialState) {
  const c = Math.cos(state.angle), s = Math.sin(state.angle);
  return body.vertices.map(p => ({ x: state.x + c * p.x - s * p.y, y: state.y + s * p.x + c * p.y }));
}

/** Segment integrals of 1/x, t/x and log|x|, with stable near-vertical limits. */
function segmentIntegrals(x0, dx) {
  const q = dx / x0;
  if (Math.abs(q) < 1e-4) {
    let A = 0, D = 0, L = Math.log(Math.abs(x0)), power = 1;
    for (let n = 0; n < 8; n++) {
      A += power / (n + 1) / x0;
      D += power / (n + 2) / x0;
      if (n > 0) L -= power / (n * (n + 1));
      power *= -q;
    }
    return { A, D, L };
  }
  const log = Math.log1p(q), A = log / dx;
  return { A, D: (1 - x0 * A) / dx,
    L: Math.log(Math.abs(x0)) + ((1 + q) * log - q) / q };
}

function paramsFor(body, params) {
  const Iwire = Number(params.Iwire ?? DEFAULT_PARAMS.Iwire);
  const Iloop = Number(params.Iloop ?? DEFAULT_PARAMS.Iloop);
  const wireRadius = Number(params.wireRadius ?? body.wireRadius ?? DEFAULT_PARAMS.wireRadius);
  if (!finite(Iwire) || !finite(Iloop) || !finite(wireRadius) || wireRadius <= 0) {
    throw new Error('Токи должны быть конечными числами, радиус провода — положительным.');
  }
  return { Iwire, Iloop, wireRadius };
}

/** Exact integrated Lorentz force and torque for every straight contour segment. */
export function computeLoads(body, state = body.initialState, params = {}) {
  const p = paramsFor(body, params), points = worldPoints(body, state);
  const minDistance = Math.min(...points.map(v => body.side * v.x));
  if (minDistance <= 0) throw new Error('Контур пересёк ось бесконечного провода.');
  const kI = MU0 * p.Iwire * p.Iloop / (2 * Math.PI);
  let fx = 0, torque = 0, potential = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y;
    const { A, D, L } = segmentIntegrals(a.x, dx);
    fx -= kI * dy * A;
    torque += kI * (((a.x - state.x) * dx + (a.y - state.y) * dy) * A + (dx * dx + dy * dy) * D);
    potential += kI * dy * L;
  }
  // Fy = kI ∮d(log|x|) = 0 analytically, for every closed contour.
  return { fx, fy: 0, torque, potential, minDistance, gap: minDistance - p.wireRadius };
}

function derivative(body, state, params) {
  const load = computeLoads(body, state, params);
  return { x: state.vx, y: state.vy, vx: load.fx / body.mass, vy: 0,
    angle: state.omega, omega: load.torque / body.inertia, time: 1 };
}

const STATE_KEYS = ['x', 'y', 'vx', 'vy', 'angle', 'omega', 'time'];
function offset(state, d, amount) {
  return Object.fromEntries(STATE_KEYS.map(k => [k, state[k] + d[k] * amount]));
}
function rk4(body, state, params, dt) {
  const k1 = derivative(body, state, params);
  const k2 = derivative(body, offset(state, k1, dt / 2), params);
  const k3 = derivative(body, offset(state, k2, dt / 2), params);
  const k4 = derivative(body, offset(state, k3, dt), params);
  return Object.fromEntries(STATE_KEYS.map(k => [k, state[k] + dt * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]) / 6]));
}

/**
 * Advance by dt seconds, using RK4 and contact-aware substeps (<= 5 ms).
 * Contact stops the trajectory immediately outside the conductor. The returned
 * velocity is the incoming velocity; the UI should pause when collision is set.
 */
export function step(body, initialState, params = {}, dt) {
  if (!finite(dt) || dt < 0) throw new Error('Шаг времени должен быть неотрицательным.');
  const p = paramsFor(body, params);
  let state = { ...initialState }, remaining = dt;
  let iterations = 0;
  while (remaining > 1e-12) {
    const load = computeLoads(body, state, p), gap = load.minDistance - p.wireRadius;
    if (gap <= CONTACT_EPS) return { state, collision: { type: 'wire', time: state.time, minDistance: load.minDistance } };
    const speedBound = Math.hypot(state.vx, state.vy) + Math.abs(state.omega) * body.maxRadius;
    const accelBound = Math.abs(load.fx) / body.mass + Math.abs(load.torque) / body.inertia * body.maxRadius + state.omega ** 2 * body.maxRadius;
    let h = Math.min(remaining, 0.005,
      0.25 * gap / Math.max(speedBound, 1e-12),
      Math.sqrt(0.25 * gap / Math.max(accelBound, 1e-12)),
      0.03 / Math.max(Math.abs(state.omega), 1e-12));
    let next;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        next = rk4(body, state, p, h);
        const nextGap = Math.min(...worldPoints(body, next).map(v => body.side * v.x)) - p.wireRadius;
        if (nextGap >= 0 && Object.values(next).every(finite)) break;
      } catch { /* Retry before a stage can cross the singular wire axis. */ }
      next = undefined;
      h /= 2;
    }
    if (!next || h < 1e-14 || ++iterations > 100000) throw new Error('Не удалось подобрать устойчивый шаг интегрирования.');
    state = next;
    remaining -= h;
  }
  const load = computeLoads(body, state, p);
  return { state, collision: load.gap <= CONTACT_EPS ? { type: 'wire', time: state.time, minDistance: load.minDistance } : null };
}

export function diagnostics(body, state = body.initialState, params = {}) {
  const loads = computeLoads(body, state, params);
  const speed = Math.hypot(state.vx, state.vy);
  const kinetic = body.mass * speed * speed / 2 + body.inertia * state.omega * state.omega / 2;
  return { ...loads, kinetic, totalEnergy: kinetic + loads.potential, speed,
    angularMomentum: body.inertia * state.omega, momentumY: body.mass * state.vy };
}
