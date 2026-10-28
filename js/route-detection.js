(function (globalScope) {
  'use strict';

  const route_data_unavailable = 'route_data_unavailable';

  const DEFAULT_THRESHOLDS = Object.freeze({
    minTracePoints: 2,
    minRoutePoints: 2,
    maxDistanceMeters: 80,
    requiredCoverageRatio: 0.6,
    minConfidence: 0.55,
    ambiguityGap: 0.08,
    minDirectionConsistency: 0.5,
    maxTimestampGapMinutes: 10,
    maxNearestDistanceMeters: 80,
    minRouteLengthMeters: 40
  });

  function mergeThresholds(overrides) {
    return Object.assign({}, DEFAULT_THRESHOLDS, overrides || {});
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

    const lat = safeNumber(rawPoint.lat ?? rawPoint.latitude);
    const lng = safeNumber(rawPoint.lng ?? rawPoint.lon ?? rawPoint.longitude);
    if (lat === null || lng === null) {
      return null;
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }

    const timestamp = rawPoint.timestamp || rawPoint.time || rawPoint.ts || null;
    const timeMs = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);

    return {
      lat,
      lng,
      timestamp: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null
    };
  }

  function sanitizeTrace(trace, thresholds) {
    if (!Array.isArray(trace) || trace.length === 0) {
      return [];
    }

    const validTrace = [];
    const comp = thresholds || DEFAULT_THRESHOLDS;
    const minPoints = Math.max(1, Number(comp.minTracePoints) || 1);

    let previousPoint = null;
    for (const candidate of trace) {
      const point = normalizePoint(candidate);
      if (!point) {
        continue;
      }

      if (previousPoint) {
        const gapMinutes = Math.abs(
          (Date.parse(point.timestamp || new Date().toISOString()) - Date.parse(previousPoint.timestamp || new Date().toISOString())) /
            60000
        );
        if (Number.isFinite(gapMinutes) && gapMinutes > (Number(comp.maxTimestampGapMinutes) || 10)) {
          continue;
        }
      }

      previousPoint = point;
      validTrace.push(point);
    }

    if (validTrace.length < minPoints) {
      return [];
    }

    return validTrace;
  }

  function sanitizeRoute(route, thresholds) {
    if (!route || typeof route !== 'object') {
      return null;
    }

    const geometry = Array.isArray(route.geometry) ? route.geometry : Array.isArray(route.points) ? route.points : [];
    if (!geometry || geometry.length < (Number(thresholds.minRoutePoints) || 2)) {
      return null;
    }

    const points = [];
    for (const candidate of geometry) {
      const point = normalizePoint(candidate);
      if (!point) {
        continue;
      }
      points.push(point);
    }

    if (points.length < (Number(thresholds.minRoutePoints) || 2)) {
      return null;
    }

    const routeId = route.id || route.routeId || route.name || 'route';
    return {
      id: routeId,
      name: route.name || route.routeName || routeId,
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
    const normalized = ((value % 360) + 360) % 360;
    return normalized;
  }

  function smallAngleDifferenceDegrees(a, b) {
    const diff = Math.abs(normalizeBearingDegrees(a) - normalizeBearingDegrees(b));
    return Math.min(diff, 360 - diff);
  }

  function pointToSegmentDistance(point, a, b) {
    const ap = { lat: point.lat - a.lat, lng: point.lng - a.lng };
    const ab = { lat: b.lat - a.lat, lng: b.lng - a.lng };
    const ab2 = ab.lat * ab.lat + ab.lng * ab.lng;
    if (ab2 === 0) {
      return haversineMeters(point, a);
    }

    const projection = (ap.lat * ab.lat + ap.lng * ab.lng) / ab2;
    const clamped = clamp(projection, 0, 1);
    const closestLat = a.lat + ab.lat * clamped;
    const closestLng = a.lng + ab.lng * clamped;
    return haversineMeters(point, { lat: closestLat, lng: closestLng });
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
    let minimumDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < routeGeometry.length; index += 1) {
      const segmentDistance = pointToSegmentDistance(point, routeGeometry[index - 1], routeGeometry[index]);
      if (segmentDistance < minimumDistance) {
        minimumDistance = segmentDistance;
      }
    }
    return Number.isFinite(minimumDistance) ? minimumDistance : Number.POSITIVE_INFINITY;
  }

  function evaluateRouteCoverage(routeGeometry, trace, thresholds) {
    if (!Array.isArray(routeGeometry) || routeGeometry.length < 2 || !Array.isArray(trace) || trace.length === 0) {
      return {
        coverageRatio: 0,
        averageDistanceMeters: Number.POSITIVE_INFINITY,
        withinThresholdCount: 0,
        score: 0
      };
    }

    const maxDistance = Number(thresholds.maxDistanceMeters) || DEFAULT_THRESHOLDS.maxDistanceMeters;
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
    const averageDistanceMeters = trace.length > 0 ? totalDistance / trace.length : 0;
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
    const score = 1 - (headingDifference / 180);
    const isReverse = headingDifference >= 150;

    return {
      routeBearing,
      traceBearing,
      headingDifference,
      score: clamp(score, 0, 1),
      isReverse,
      status: isReverse ? 'reverse_direction' : 'matching_direction'
    };
  }

  function scoreCandidate(route, trace, thresholds) {
    if (!route || !Array.isArray(route.geometry) || route.geometry.length < (Number(thresholds.minRoutePoints) || 2)) {
      return null;
    }

    const coverage = evaluateRouteCoverage(route.geometry, trace, thresholds);
    if (coverage.coverageRatio < (Number(thresholds.requiredCoverageRatio) || DEFAULT_THRESHOLDS.requiredCoverageRatio)) {
      return null;
    }

    const direction = evaluateDirection(route.geometry, trace, thresholds);
    const routeLengthMeters = routeGeometryLengthMeters(route.geometry);
    const isValidGeometry = routeLengthMeters >= (Number(thresholds.minRouteLengthMeters) || DEFAULT_THRESHOLDS.minRouteLengthMeters);
    if (!isValidGeometry) {
      return null;
    }

    const directionWeight = 0.25;
    const coverageWeight = 0.65;
    const consistencyWeight = 0.1;
    const directionContribution = direction.score * directionWeight;
    const coverageContribution = coverage.score * coverageWeight;
    const routeLengthContribution = clamp(routeLengthMeters / (routeLengthMeters + 500), 0, 1) * consistencyWeight;
    const confidence = clamp(coverageContribution + directionContribution + routeLengthContribution, 0, 1);

    return {
      routeId: route.id,
      routeName: route.name,
      coverage,
      direction,
      routeLengthMeters,
      confidence,
      reason: direction.isReverse ? 'reverse_direction' : 'route_match'
    };
  }

  function detectRoute(trace, routeCatalog, options) {
    const thresholds = mergeThresholds(options && options.thresholds ? options.thresholds : options);
    const sanitizedTrace = sanitizeTrace(trace, thresholds);
    if (!sanitizedTrace.length) {
      return route_data_unavailable;
    }

    const catalog = Array.isArray(routeCatalog) ? routeCatalog : [];
    const candidates = [];

    for (const route of catalog) {
      const sanitizedRoute = sanitizeRoute(route, thresholds);
      if (!sanitizedRoute) {
        continue;
      }

      const candidate = scoreCandidate(sanitizedRoute, sanitizedTrace, thresholds);
      if (!candidate) {
        continue;
      }

      if (candidate.confidence < (Number(thresholds.minConfidence) || DEFAULT_THRESHOLDS.minConfidence)) {
        continue;
      }

      candidates.push(candidate);
    }

    if (!candidates.length) {
      return route_data_unavailable;
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const topCandidate = candidates[0];
    const secondCandidate = candidates[1] || null;
    const gap = secondCandidate ? topCandidate.confidence - secondCandidate.confidence : 1;
    const ambiguous = secondCandidate && gap <= (Number(thresholds.ambiguityGap) || DEFAULT_THRESHOLDS.ambiguityGap) &&
      secondCandidate.confidence >= (Number(thresholds.minConfidence) || DEFAULT_THRESHOLDS.minConfidence);

    if (ambiguous) {
      return {
        status: 'ambiguous',
        ambiguous: true,
        confidence: topCandidate.confidence,
        candidates: [topCandidate, secondCandidate],
        route_data: null,
        reason: 'ambiguous_route_match'
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
