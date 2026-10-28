(function (globalScope) {
  'use strict';

  const route_data_unavailable = 'route_data_unavailable';

  const DEFAULT_THRESHOLDS = Object.freeze({
    minTracePoints: 2,
    minRoutePoints: 2,
    maxDistanceMeters: 80,
    requiredCoverageRatio: 0.55,
    minConfidence: 0.58,
    ambiguityGap: 0.06,
    minDirectionConsistency: 0.35,
    maxTimestampGapMinutes: 10,
    maxNearestDistanceMeters: 80,
    minRouteLengthMeters: 60
  });

  function mergeThresholds(overrides) {
    return Object.assign({}, DEFAULT_THRESHOLDS, overrides || {});
  }

  function getThreshold(config, key, fallback) {
    const value = config && Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined;
    return Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function safeNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function normalizePoint(rawPoint) {
    if (!rawPoint || typeof rawPoint !== 'object') {
      return null;
    }

    let lat = null;
    let lng = null;

    if (Array.isArray(rawPoint) && rawPoint.length >= 2) {
      lat = safeNumber(rawPoint[0]);
      lng = safeNumber(rawPoint[1]);
    } else {
      lat = safeNumber(rawPoint.lat ?? rawPoint.latitude);
      lng = safeNumber(rawPoint.lng ?? rawPoint.lon ?? rawPoint.longitude);
    }

    if (lat === null || lng === null) {
      return null;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }

    const timestampSource = rawPoint.timestamp ?? rawPoint.time ?? rawPoint.ts ?? null;
    let timestamp = null;
    let hasValidTimestamp = false;

    if (typeof timestampSource === 'number' && Number.isFinite(timestampSource)) {
      const parsed = new Date(timestampSource);
      if (!Number.isNaN(parsed.getTime())) {
        timestamp = parsed.toISOString();
        hasValidTimestamp = true;
      }
    } else if (typeof timestampSource === 'string') {
      const parsed = Date.parse(timestampSource);
      if (Number.isFinite(parsed)) {
        timestamp = new Date(parsed).toISOString();
        hasValidTimestamp = true;
      }
    }

    return {
      lat,
      lng,
      timestamp,
      hasValidTimestamp
    };
  }

  function sanitizeTrace(trace, thresholds) {
    const config = mergeThresholds(thresholds);
    if (!Array.isArray(trace) || trace.length === 0) {
      return {
        points: [],
        diagnostics: {
          status: 'insufficient_gps_data',
          reason: 'empty_trace',
          invalidGpsCount: 0,
          invalidTimestampCount: 0,
          validSamples: 0
        }
      };
    }

    const validPoints = [];
    const diagnostics = {
      status: 'insufficient_gps_data',
      reason: 'invalid_trace',
      invalidGpsCount: 0,
      invalidTimestampCount: 0,
      validSamples: 0,
      missingTimestampCount: 0
    };

    let previousPoint = null;
    for (const sample of trace) {
      const point = normalizePoint(sample);
      if (!point) {
        diagnostics.invalidGpsCount += 1;
        continue;
      }

      if (sample && sample.timestamp !== undefined && sample.timestamp !== null) {
        const parsed = Date.parse(sample.timestamp);
        if (!Number.isFinite(parsed)) {
          diagnostics.invalidTimestampCount += 1;
        }
      } else {
        diagnostics.missingTimestampCount += 1;
      }

      if (previousPoint && previousPoint.timestamp && point.timestamp) {
        const previousMs = Date.parse(previousPoint.timestamp);
        const currentMs = Date.parse(point.timestamp);
        const gapMinutes = Math.abs((currentMs - previousMs) / 60000);
        const maxGap = getThreshold(config, 'maxTimestampGapMinutes', DEFAULT_THRESHOLDS.maxTimestampGapMinutes);
        if (Number.isFinite(gapMinutes) && gapMinutes > maxGap) {
          diagnostics.reason = 'timestamp_gap_too_large';
        }
      }

      validPoints.push({ lat: point.lat, lng: point.lng, timestamp: point.timestamp });
      previousPoint = point;
    }

    diagnostics.validSamples = validPoints.length;

    if (validPoints.length < getThreshold(config, 'minTracePoints', DEFAULT_THRESHOLDS.minTracePoints)) {
      diagnostics.reason = 'insufficient_trace_points';
      return { points: [], diagnostics };
    }

    diagnostics.status = 'ok';
    diagnostics.reason = 'trace_valid';
    return { points: validPoints, diagnostics };
  }

  function sanitizeRoute(route, thresholds) {
    const config = mergeThresholds(thresholds);
    if (!route || typeof route !== 'object') {
      return null;
    }

    const geometry = Array.isArray(route.geometry)
      ? route.geometry
      : Array.isArray(route.points)
        ? route.points
        : [];

    if (!geometry || geometry.length < getThreshold(config, 'minRoutePoints', DEFAULT_THRESHOLDS.minRoutePoints)) {
      return null;
    }

    const points = [];
    for (const candidate of geometry) {
      const point = normalizePoint(candidate);
      if (!point) {
        continue;
      }
      points.push({ lat: point.lat, lng: point.lng, timestamp: point.timestamp || null });
    }

    if (points.length < getThreshold(config, 'minRoutePoints', DEFAULT_THRESHOLDS.minRoutePoints)) {
      return null;
    }

    return {
      id: route.id || route.routeId || route.name || 'route',
      name: route.name || route.routeName || route.id || 'route',
      geometry: points,
      metadata: route.metadata || {}
    };
  }

  function degreesToRadians(value) {
    return (value * Math.PI) / 180;
  }

  function haversineMeters(a, b) {
    const earthRadiusMeters = 6371000;
    const lat1 = degreesToRadians(a.lat);
    const lat2 = degreesToRadians(b.lat);
    const deltaLat = degreesToRadians(b.lat - a.lat);
    const deltaLng = degreesToRadians(b.lng - a.lng);

    const hav =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

    return 2 * earthRadiusMeters * Math.asin(Math.sqrt(hav));
  }

  function bearingBetween(a, b) {
    const lat1 = degreesToRadians(a.lat);
    const lat2 = degreesToRadians(b.lat);
    const deltaLng = degreesToRadians(b.lng - a.lng);

    const y = Math.sin(deltaLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
    const angle = Math.atan2(y, x);
    return (angle * 180) / Math.PI;
  }

  function normalizeBearingDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function smallAngleDifferenceDegrees(a, b) {
    const diff = Math.abs(normalizeBearingDegrees(a) - normalizeBearingDegrees(b));
    return Math.min(diff, 360 - diff);
  }

  function pointToSegmentDistance(point, a, b) {
    // Local tangent-plane projection: stable for short city-scale routes, but not a geodesic solution
    // for long-range travel, near-poles, or routes spanning large geographic extents.
    const earthRadiusMeters = 6371000;
    const meanLat = (a.lat + b.lat) / 2;
    const latScale = Math.cos(degreesToRadians(meanLat)) || 1;

    const ax = earthRadiusMeters * degreesToRadians(a.lng - point.lng) * latScale;
    const ay = earthRadiusMeters * degreesToRadians(a.lat - point.lat);
    const bx = earthRadiusMeters * degreesToRadians(b.lng - point.lng) * latScale;
    const by = earthRadiusMeters * degreesToRadians(b.lat - point.lat);

    const segmentX = bx - ax;
    const segmentY = by - ay;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;

    if (segmentLengthSquared === 0) {
      return Math.hypot(bx - ax, by - ay);
    }

    const projection = ((0 - ax) * segmentX + (0 - ay) * segmentY) / segmentLengthSquared;
    const t = clamp(projection, 0, 1);

    const closestX = ax + segmentX * t;
    const closestY = ay + segmentY * t;
    return Math.hypot(0 - closestX, 0 - closestY);
  }

  function routeGeometryLengthMeters(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 2) {
      return 0;
    }

    let total = 0;
    for (let index = 1; index < geometry.length; index += 1) {
      total += haversineMeters(geometry[index - 1], geometry[index]);
    }
    return total;
  }

  function nearestDistanceToRoute(point, routeGeometry) {
    if (!Array.isArray(routeGeometry) || routeGeometry.length < 2) {
      return Number.POSITIVE_INFINITY;
    }

    let minimumDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < routeGeometry.length; index += 1) {
      const distance = pointToSegmentDistance(point, routeGeometry[index - 1], routeGeometry[index]);
      if (distance < minimumDistance) {
        minimumDistance = distance;
      }
    }

    return Number.isFinite(minimumDistance) ? minimumDistance : Number.POSITIVE_INFINITY;
  }

  function evaluateRouteCoverage(routeGeometry, trace, thresholds) {
    const config = mergeThresholds(thresholds);
    if (!Array.isArray(routeGeometry) || routeGeometry.length < 2 || !Array.isArray(trace) || trace.length === 0) {
      return {
        coverageRatio: 0,
        averageDistanceMeters: Number.POSITIVE_INFINITY,
        withinThresholdCount: 0,
        score: 0
      };
    }

    const maxDistance = getThreshold(config, 'maxDistanceMeters', DEFAULT_THRESHOLDS.maxDistanceMeters);
    let withinThresholdCount = 0;
    let totalDistance = 0;

    for (const point of trace) {
      const nearest = nearestDistanceToRoute(point, routeGeometry);
      totalDistance += nearest;
      if (nearest <= maxDistance) {
        withinThresholdCount += 1;
      }
    }

    const coverageRatio = trace.length > 0 ? withinThresholdCount / trace.length : 0;
    const averageDistanceMeters = trace.length > 0 ? totalDistance / trace.length : Number.POSITIVE_INFINITY;
    const distanceScore = 1 - clamp(averageDistanceMeters / maxDistance, 0, 1);
    const score = clamp((coverageRatio * 0.7) + (distanceScore * 0.3), 0, 1);

    return {
      coverageRatio,
      averageDistanceMeters,
      withinThresholdCount,
      score
    };
  }

  function evaluateDirection(routeGeometry, trace, thresholds) {
    const config = mergeThresholds(thresholds);
    if (!Array.isArray(routeGeometry) || routeGeometry.length < 2 || !Array.isArray(trace) || trace.length < 2) {
      return {
        routeBearing: null,
        traceBearing: null,
        headingDifference: 180,
        score: 0,
        isReverse: false,
        status: 'insufficient_geometry'
      };
    }

    const routeStart = routeGeometry[0];
    const routeEnd = routeGeometry[routeGeometry.length - 1];
    const traceStart = trace[0];
    const traceEnd = trace[trace.length - 1];

    const routeBearing = normalizeBearingDegrees(bearingBetween(routeStart, routeEnd));
    const traceBearing = normalizeBearingDegrees(bearingBetween(traceStart, traceEnd));
    const headingDifference = smallAngleDifferenceDegrees(routeBearing, traceBearing);
    const score = clamp(1 - (headingDifference / 180), 0, 1);
    const isReverse = headingDifference >= 150;
    const minDirectionConsistency = getThreshold(
      config,
      'minDirectionConsistency',
      DEFAULT_THRESHOLDS.minDirectionConsistency
    );

    return {
      routeBearing,
      traceBearing,
      headingDifference,
      score,
      isReverse,
      status: isReverse || score < minDirectionConsistency ? 'reverse_direction_confirmation_required' : 'matching_direction'
    };
  }

  function scoreCandidate(route, trace, thresholds) {
    const config = mergeThresholds(thresholds);
    if (!route || !Array.isArray(route.geometry) || route.geometry.length < getThreshold(config, 'minRoutePoints', DEFAULT_THRESHOLDS.minRoutePoints)) {
      return null;
    }

    const coverage = evaluateRouteCoverage(route.geometry, trace, config);
    const minCoverage = getThreshold(config, 'requiredCoverageRatio', DEFAULT_THRESHOLDS.requiredCoverageRatio);
    if (coverage.coverageRatio < minCoverage) {
      return null;
    }

    const direction = evaluateDirection(route.geometry, trace, config);
    const routeLengthMeters = routeGeometryLengthMeters(route.geometry);
    const minRouteLength = getThreshold(config, 'minRouteLengthMeters', DEFAULT_THRESHOLDS.minRouteLengthMeters);
    if (routeLengthMeters < minRouteLength) {
      return null;
    }

    const confidence = clamp(
      (coverage.score * 0.7) + (direction.score * 0.25) + ((routeLengthMeters / (routeLengthMeters + 500)) * 0.05),
      0,
      1
    );

    return {
      routeId: route.id,
      routeName: route.name,
      coverage,
      direction,
      routeLengthMeters,
      confidence,
      reason: direction.isReverse ? 'reverse_direction_confirmation_required' : 'route_match',
      requires_confirmation: Boolean(direction.isReverse)
    };
  }

  function detectRoute(trace, routeCatalog, options) {
    const config = mergeThresholds(options && options.thresholds ? options.thresholds : options);

    const traceAnalysis = sanitizeTrace(trace, config);
    if (traceAnalysis.points.length < getThreshold(config, 'minTracePoints', DEFAULT_THRESHOLDS.minTracePoints)) {
      return {
        status: 'insufficient_gps_data',
        route_data: null,
        diagnostics: traceAnalysis.diagnostics
      };
    }

    const catalog = Array.isArray(routeCatalog) ? routeCatalog : [];
    const validRoutes = [];
    for (const route of catalog) {
      const sanitized = sanitizeRoute(route, config);
      if (sanitized) {
        validRoutes.push(sanitized);
      }
    }

    if (!validRoutes.length) {
      return route_data_unavailable;
    }

    const candidates = [];
    for (const route of validRoutes) {
      const candidate = scoreCandidate(route, traceAnalysis.points, config);
      if (!candidate) {
        continue;
      }
      if (candidate.confidence < getThreshold(config, 'minConfidence', DEFAULT_THRESHOLDS.minConfidence)) {
        continue;
      }
      candidates.push(candidate);
    }

    if (!candidates.length) {
      return {
        status: 'insufficient_confidence',
        route_data: null,
        diagnostics: {
          reason: 'gps_too_far_from_all_routes_or_confidence_below_threshold',
          traceSamples: traceAnalysis.points.length,
          candidateCount: 0,
          bestCoverage: 0
        }
      };
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidate = candidates[0];
    const secondCandidate = candidates[1] || null;
    const gap = secondCandidate ? topCandidate.confidence - secondCandidate.confidence : 1;
    const ambiguous =
      secondCandidate &&
      gap <= getThreshold(config, 'ambiguityGap', DEFAULT_THRESHOLDS.ambiguityGap) &&
      secondCandidate.confidence >= getThreshold(config, 'minConfidence', DEFAULT_THRESHOLDS.minConfidence);

    if (ambiguous) {
      return {
        status: 'ambiguous_route',
        ambiguous: true,
        confidence: topCandidate.confidence,
        candidates: [topCandidate, secondCandidate],
        route_data: null,
        reason: 'two_or_more_routes_overlap_or_run_parallel',
        requires_confirmation: true
      };
    }

    if (topCandidate.requires_confirmation || topCandidate.direction.isReverse) {
      return {
        status: 'reverse_direction_confirmation_required',
        ambiguous: false,
        confidence: topCandidate.confidence,
        routeId: topCandidate.routeId,
        routeName: topCandidate.routeName,
        route_data: {
          routeId: topCandidate.routeId,
          routeName: topCandidate.routeName,
          confidence: topCandidate.confidence,
          coverage: topCandidate.coverage,
          direction: topCandidate.direction,
          routeLengthMeters: topCandidate.routeLengthMeters
        },
        reason: 'route_matches_in_reverse_direction',
        requires_confirmation: true
      };
    }

    return {
      status: 'detected',
      ambiguous: false,
      confidence: topCandidate.confidence,
      routeId: topCandidate.routeId,
      routeName: topCandidate.routeName,
      route_data: topCandidate,
      reason: topCandidate.reason,
      coverage: topCandidate.coverage,
      direction: topCandidate.direction
    };
  }

  const api = {
    route_data_unavailable,
    DEFAULT_THRESHOLDS,
    mergeThresholds,
    normalizePoint,
    sanitizeTrace,
    sanitizeRoute,
    distanceToSegment: pointToSegmentDistance,
    haversineMeters,
    evaluateRouteCoverage,
    evaluateDirection,
    scoreCandidate,
    detectRoute
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof globalScope !== 'undefined') {
    globalScope.TobisRouteDetection = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
