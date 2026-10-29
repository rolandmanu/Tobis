const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectRoute,
  sanitizeTrace,
  evaluateDirection
} = require('../js/route-detection.js');

function makeTrace(points) {
  return points.map((point, index) => ({
    ...point,
    timestamp: new Date(Date.UTC(2024, 0, 1, 8, 0, index * 2)).toISOString()
  }));
}

test('rejects trace samples with invalid coordinates', () => {
  const trace = [
    { lat: 91, lng: 0, timestamp: '2024-01-01T08:00:00Z' },
    { lat: 0, lng: 181, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'insufficient_gps_data');
  assert.equal(result.diagnostics.reason, 'insufficient_trace_points');
});

test('rejects trace samples with invalid timestamps', () => {
  const trace = [
    { lat: 0, lng: 0, timestamp: 'not-a-date' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'invalid_timestamp');
});

test('rejects trace samples with invalid time values', () => {
  const trace = [
    { lat: 0, lng: 0, time: 'not-a-date' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'invalid_timestamp');
});

test('rejects trace samples with invalid ts values', () => {
  const trace = [
    { lat: 0, lng: 0, ts: 'not-a-date' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'invalid_timestamp');
});

test('rejects traces with missing timestamps', () => {
  const trace = [
    { lat: 0, lng: 0 },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'missing_timestamp');
});

test('rejects traces with timestamps in reverse chronological order', () => {
  const trace = [
    { lat: 0, lng: 0, timestamp: '2024-01-01T08:02:00Z' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:00:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'timestamp_out_of_order');
});

test('rejects traces with timestamp gaps over 10 minutes', () => {
  const trace = [
    { lat: 0, lng: 0, timestamp: '2024-01-01T08:00:00Z' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:11:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.points.length, 0);
  assert.equal(result.diagnostics.status, 'invalid_trace');
  assert.equal(result.diagnostics.reason, 'timestamp_gap_too_large');
  assert.ok(result.diagnostics.gapMinutes > 10);
});

test('accepts valid traces using timestamp', () => {
  const trace = [
    { lat: 0, lng: 0, timestamp: '2024-01-01T08:00:00Z' },
    { lat: 0.0001, lng: 0.0001, timestamp: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.diagnostics.status, 'ok');
  assert.equal(result.diagnostics.reason, 'trace_valid');
  assert.equal(result.points.length, 2);
});

test('accepts valid traces using time alias', () => {
  const trace = [
    { lat: 0, lng: 0, time: '2024-01-01T08:00:00Z' },
    { lat: 0.0001, lng: 0.0001, time: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.diagnostics.status, 'ok');
  assert.equal(result.diagnostics.reason, 'trace_valid');
  assert.equal(result.points.length, 2);
});

test('accepts valid traces using ts alias', () => {
  const trace = [
    { lat: 0, lng: 0, ts: '2024-01-01T08:00:00Z' },
    { lat: 0.0001, lng: 0.0001, ts: '2024-01-01T08:02:00Z' }
  ];

  const result = sanitizeTrace(trace, {});

  assert.equal(result.diagnostics.status, 'ok');
  assert.equal(result.diagnostics.reason, 'trace_valid');
  assert.equal(result.points.length, 2);
});

test('detects routes that follow a curved geometry', () => {
  const route = {
    id: 'curved-route',
    name: 'Curved route',
    geometry: [
      { lat: 0, lng: 0 },
      { lat: 0.0007, lng: 0.0012 },
      { lat: 0.0015, lng: 0.0038 },
      { lat: 0.0023, lng: 0.0072 }
    ]
  };

  const trace = makeTrace([
    { lat: 0.0001, lng: 0.0002 },
    { lat: 0.0008, lng: 0.0016 },
    { lat: 0.0018, lng: 0.0045 },
    { lat: 0.0024, lng: 0.0075 }
  ]);

  const result = detectRoute(trace, [route], {});

  assert.equal(result.status, 'detected');
  assert.equal(result.routeId, 'curved-route');
  assert.equal(result.routeName, 'Curved route');
  assert.ok(result.confidence > 0.58);
});

test('flags uncertain direction as direction confirmation required', () => {
  const routeGeometry = [
    { lat: 0, lng: 0 },
    { lat: 0.001, lng: 0.009 }
  ];

  const trace = [
    { lat: 0.0009, lng: 0.0088 },
    { lat: 0.0002, lng: 0.0002 }
  ];

  const result = evaluateDirection(routeGeometry, trace, {});

  assert.equal(result.status, 'direction_confirmation_required');
  assert.ok(result.headingDifference >= 90);
});

test('returns route_data_unavailable when a route is missing geometry', () => {
  const trace = makeTrace([
    { lat: 0.0001, lng: 0.0001 },
    { lat: 0.0003, lng: 0.0002 }
  ]);

  const result = detectRoute(trace, [{ id: 'no-geometry', name: 'Broken route' }], {});

  assert.equal(result.status, 'route_data_unavailable');
  assert.equal(result.route_data, null);
});

test('flags overlapping routes as ambiguous', () => {
  const routeGeometry = [
    { lat: 0, lng: 0 },
    { lat: 0.001, lng: 0.001 },
    { lat: 0.002, lng: 0.003 },
    { lat: 0.003, lng: 0.005 }
  ];

  const trace = makeTrace([
    { lat: 0.0002, lng: 0.0002 },
    { lat: 0.0013, lng: 0.0018 },
    { lat: 0.0028, lng: 0.0043 }
  ]);

  const routeA = {
    id: 'route-a',
    name: 'Route A',
    geometry: routeGeometry
  };

  const routeB = {
    id: 'route-b',
    name: 'Route B',
    geometry: routeGeometry.map((point, index) => ({
      lat: point.lat + 0.00005,
      lng: point.lng + 0.00005 * (index % 2 === 0 ? 1 : -1)
    }))
  };

  const result = detectRoute(trace, [routeA, routeB], {});

  assert.equal(result.status, 'ambiguous_route');
  assert.equal(result.ambiguous, true);
  assert.ok(Array.isArray(result.candidates));
});
