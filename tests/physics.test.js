import test from 'node:test';
import assert from 'node:assert/strict';
import { createBody, worldPoints, computeLoads, step, diagnostics, MU0 } from '../dist/physics.js';

const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} (tol ${tolerance})`);
const rectangle = (x0 = 0.4, x1 = 0.8, y0 = -0.3, y1 = 0.3) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

test('uniform line mass gives the wire centroid and exact rod-integrated inertia', () => {
  const body = createBody(rectangle(), { mass: 0.02 });
  close(body.initialState.x, 0.6);
  close(body.initialState.y, 0);
  close(body.perimeter, 2);
  // For rectangle width w, height h: I/m = (w+h)^2 / 12.
  close(body.inertia, 0.02 * (0.4 + 0.6) ** 2 / 12);
  const triangle = createBody([[0.3, 0], [1.2, 0], [0.3, 0.6]]);
  const lengths = [0.9, Math.hypot(0.9, 0.6), 0.6];
  close(triangle.initialState.x, (lengths[0] * 0.75 + lengths[1] * 0.75 + lengths[2] * 0.3) / lengths.reduce((a, b) => a + b));
});

test('rectangle force and potential match the closed analytical expressions', () => {
  const body = createBody(rectangle());
  const params = { Iwire: 1500, Iloop: 80 };
  const kI = MU0 * params.Iwire * params.Iloop / (2 * Math.PI);
  const loads = computeLoads(body, body.initialState, params);
  close(loads.fx, kI * 0.6 * (1 / 0.4 - 1 / 0.8));
  close(loads.fy, 0);
  close(loads.torque, 0);
  close(loads.potential, kI * 0.6 * Math.log(0.8 / 0.4));
  assert.ok(loads.fx > 0, 'positive CCW current to the right repels');
  close(computeLoads(body, body.initialState, { ...params, Iloop: -80 }).fx, -loads.fx);
});

test('left-side loop uses the signed field and CCW current convention', () => {
  const body = createBody(rectangle(-0.8, -0.4));
  const loads = computeLoads(body);
  assert.ok(loads.fx > 0, 'CCW loop to the left attracts toward wire');
  assert.ok(loads.potential < 0);
});

test('CW gestures normalize to CCW and repeated closure coordinates are accepted', () => {
  const ccw = rectangle(), cw = [...ccw].reverse();
  const a = createBody(ccw), b = createBody([...cw, cw[0], cw[0]]);
  close(computeLoads(a).fx, computeLoads(b).fx);
  close(a.area, b.area);
});

test('rejects self intersections, degenerate shapes, overlaps and conductor crossings', () => {
  assert.throws(() => createBody([[0.3, 0], [0.9, 1], [0.3, 1], [0.9, 0]]), /самого себя/);
  assert.throws(() => createBody([[0.3, 0], [0.6, 0], [0.9, 0]]));
  assert.throws(() => createBody([[0.3, 0], [0.8, 0], [0.6, 0], [0.6, 1]]));
  assert.throws(() => createBody(rectangle(-0.1, 0.3)), /стороны провода/);
  assert.throws(() => createBody(rectangle(0.01, 0.3)), /стороны провода/);
  assert.throws(() => createBody(rectangle(), { mass: 0 }), /Масса/);
});

test('exact loads are negative gradients of potential for irregular rotated loop', () => {
  const body = createBody([[0.5, -0.3], [1.1, -0.1], [0.85, 0.5], [0.4, 0.3]]);
  const state = { ...body.initialState, angle: 0.37 };
  const h = 1e-5, loads = computeLoads(body, state);
  const energy = s => computeLoads(body, s).potential;
  const dUdx = (energy({ ...state, x: state.x + h }) - energy({ ...state, x: state.x - h })) / (2 * h);
  const dUda = (energy({ ...state, angle: state.angle + h }) - energy({ ...state, angle: state.angle - h })) / (2 * h);
  close(loads.fx, -dUdx, 1e-10);
  close(loads.torque, -dUda, 1e-10);
});

test('near-vertical segment limits remain finite and agree with potential gradient', () => {
  const body = createBody([[0.4, -0.3], [0.400000000001, 0.3], [0.8, 0.3], [0.8, -0.3]]);
  const loads = computeLoads(body);
  assert.ok(Object.values(loads).every(Number.isFinite));
  const h = 1e-5, s = body.initialState;
  close(loads.fx, -(computeLoads(body, { ...s, x: s.x + h }).potential - computeLoads(body, { ...s, x: s.x - h }).potential) / (2 * h), 1e-10);
});

test('zero field produces free translation and rotation, with no gravity', () => {
  const body = createBody(rectangle(1, 1.4), { vx: 0.2, vy: 0.3, omega: 0.4 });
  const { state, collision } = step(body, body.initialState, { Iwire: 0 }, 2);
  assert.equal(collision, null);
  close(state.x, 1.6);
  close(state.y, 0.6);
  close(state.angle, 0.8);
  close(state.vy, 0.3);
  close(state.time, 2);
});

test('RK4 conserves energy and y momentum for an irregular moving loop', () => {
  const body = createBody([[0.6, -0.15], [1.1, -0.1], [0.9, 0.45], [0.45, 0.2]], { vx: 0.1, vy: 0.15, omega: 0.25 });
  let state = body.initialState;
  const initial = diagnostics(body, state);
  for (let i = 0; i < 200; i++) {
    const result = step(body, state, {}, 0.01);
    assert.equal(result.collision, null);
    state = result.state;
  }
  const final = diagnostics(body, state);
  close(final.totalEnergy, initial.totalEnergy, 1e-9);
  close(final.momentumY, initial.momentumY, 1e-12);
});

test('contact stops at the conductor surface even for a long requested step', () => {
  const body = createBody(rectangle(0.1, 0.3, -0.05, 0.05), { vx: -1 });
  const { state, collision } = step(body, body.initialState, { Iwire: 0 }, 1);
  assert.equal(collision.type, 'wire');
  close(state.time, 0.075, 2e-7);
  const min = Math.min(...worldPoints(body, state).map(p => p.x));
  assert.ok(min >= 0.025);
  assert.ok(min <= 0.02500011);
});

test('fast rotation cannot tunnel through the excluded conductor strip', () => {
  const body = createBody(rectangle(0.15, 0.25, -0.35, 0.35), { omega: 50 });
  const { state, collision } = step(body, body.initialState, { Iwire: 0 }, 0.5);
  assert.equal(collision.type, 'wire');
  assert.ok(state.time < 0.02);
  assert.ok(Math.min(...worldPoints(body, state).map(p => p.x)) >= 0.025);
});
