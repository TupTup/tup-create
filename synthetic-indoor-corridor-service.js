/**
 * SyntheticIndoorCorridorService – eksperymentalne heurystyczne prowadzenie indoor.
 *
 * Wejście: buildingPolygon + entrancePoint + destinationPoint.
 * Bez ręcznych korytarzy, BIM ani CAD – generuje synthetic corridors i trasę centerline.
 *
 * Etapy: orientacja → inset polygon → routing po obrysie inset → LineString.
 */
(function (global) {
    const turf = global.turf;
    if (!turf) {
        console.warn("[SyntheticIndoorCorridorService] Brak Turf.js – moduł niedostępny.");
    }

    const DEFAULT_WALL_MARGIN_METERS = 3;
    const MIN_WALL_MARGIN_METERS = 0.55;
    const BUFFER_STEPS = 4;
    const COORD_PRECISION = 7;
    const DEDUPE_TOLERANCE_METERS = 0.05;
    const MIN_TURN_DEGREES = 12;
    const MAX_SNAP_RATIO = 0.45;

    function SyntheticIndoorCorridorService(options = {}) {
        this._wallMarginMeters = options.wallMarginMeters ?? DEFAULT_WALL_MARGIN_METERS;
        this._maxSnapDistanceMeters = options.maxSnapDistanceMeters ?? null;
    }

    SyntheticIndoorCorridorService.prototype.route = function route(input) {
        if (!turf) {
            throw new Error("SyntheticIndoorCorridorService wymaga Turf.js");
        }

        const ctx = buildPipelineContext(input, this);
        const graph = buildSyntheticCorridorGraph(ctx);
        ctx.diagnostics.graphNodeCount = graph.nodes.size;
        ctx.diagnostics.graphEdgeCount = graph.edges.length;
        const entranceNodeId = nodeKey(ctx.entrancePoint.geometry.coordinates);
        const destinationNodeId = nodeKey(ctx.destinationPoint.geometry.coordinates);
        const pathNodeIds = dijkstra(graph, entranceNodeId, destinationNodeId);

        if (!pathNodeIds?.length) {
            throw new Error("SyntheticIndoorCorridorService: nie udało się wyznaczyć trasy");
        }

        const corridorCoords = pathNodeIds.map((id) => graph.nodes.get(id).coord.slice());
        let coords = dedupeCoords(removeCollinearCoords(corridorCoords));
        coords = ensurePathInsideBuilding(coords, ctx.buildingPolygon);

        const segments = buildSegmentList(coords);
        const turnPoints = extractTurnPoints(coords);
        const line = turf.lineString(coords, {
            routing: "synthetic-indoor-corridor",
            lengthMeters: turf.length(turf.lineString(coords), { units: "meters" }),
            segmentCount: segments.length,
            turnPointCount: turnPoints.length,
        });

        line.properties.segments = segments;
        line.properties.turnPoints = turnPoints;
        line.properties.diagnostics = ctx.diagnostics;
        line.properties.insetPolygon = ctx.insetPolygon;
        line.properties.syntheticCorridors = ctx.syntheticCorridors;

        return line;
    };

    SyntheticIndoorCorridorService.prototype.generateCorridors = function generateCorridors(input) {
        if (!turf) {
            throw new Error("SyntheticIndoorCorridorService wymaga Turf.js");
        }

        const ctx = buildPipelineContext(input, this);
        return ctx.syntheticCorridors;
    };

    SyntheticIndoorCorridorService.prototype.generateInsetPolygon = function generateInsetPolygon(input) {
        if (!turf) {
            throw new Error("SyntheticIndoorCorridorService wymaga Turf.js");
        }

        const buildingPolygon = toPolygonFeature(input.buildingPolygon, "buildingPolygon");
        const wallMarginMeters =
            typeof input.wallMarginMeters === "number" ? input.wallMarginMeters : this._wallMarginMeters;
        return buildInsetPolygon(buildingPolygon, wallMarginMeters);
    };

    SyntheticIndoorCorridorService.prototype.analyze = function analyze(input) {
        if (!turf) {
            throw new Error("SyntheticIndoorCorridorService wymaga Turf.js");
        }

        const ctx = buildPipelineContext(input, this);
        return ctx.diagnostics;
    };

    function buildPipelineContext(input, service) {
        const buildingPolygon = toPolygonFeature(input.buildingPolygon, "buildingPolygon");
        const entrancePoint = toPointFeature(input.entrancePoint, "entrancePoint");
        const destinationPoint = toPointFeature(input.destinationPoint, "destinationPoint");
        const center = turf.center(buildingPolygon).geometry.coordinates;
        const primaryBearing = longestEdgeBearing(buildingPolygon);
        const secondaryBearing = normalizeBearing(primaryBearing + 90);
        const orientedBBox = computeOrientedBBox(buildingPolygon, center, primaryBearing, secondaryBearing);
        const wallMarginMeters =
            typeof input.wallMarginMeters === "number" ? input.wallMarginMeters : service._wallMarginMeters;
        const insetResult = buildInsetPolygon(buildingPolygon, wallMarginMeters);
        const maxSnapDistanceMeters =
            typeof input.maxSnapDistanceMeters === "number"
                ? input.maxSnapDistanceMeters
                : service._maxSnapDistanceMeters ??
                  Math.max(
                      insetResult.marginMeters + 12,
                      Math.min(orientedBBox.maxSpanMeters * MAX_SNAP_RATIO, 55)
                  );

        const syntheticCorridors = buildInsetCorridorNetwork(insetResult.polygon);

        const corridorSegments = extractCorridorSegments(syntheticCorridors);
        const entranceSnap = snapPointToCorridors(
            entrancePoint,
            corridorSegments,
            maxSnapDistanceMeters,
            "entrance"
        );
        const destinationSnap = snapPointToCorridors(
            destinationPoint,
            corridorSegments,
            maxSnapDistanceMeters,
            "destination"
        );

        const diagnostics = {
            primaryBearing,
            secondaryBearing,
            orientedBBox,
            insetMarginMeters: insetResult.marginMeters,
            insetFallback: insetResult.fallback,
            insetAreaRatio: computeAreaRatio(insetResult.polygon, buildingPolygon),
            corridorSegmentCount: corridorSegments.length,
            corridorSource: "inset-polygon-outline",
            entranceSnapDistanceMeters: entranceSnap.distanceMeters,
            destinationSnapDistanceMeters: destinationSnap.distanceMeters,
            maxSnapDistanceMeters,
        };

        return {
            buildingPolygon,
            entrancePoint,
            destinationPoint,
            center,
            primaryBearing,
            secondaryBearing,
            orientedBBox,
            insetPolygon: insetResult.polygon,
            syntheticCorridors,
            corridorSegments,
            entranceSnap,
            destinationSnap,
            diagnostics,
        };
    }

    function buildSyntheticCorridorGraph(ctx) {
        return buildCorridorGraph(
            ctx.corridorSegments,
            ctx.entranceSnap,
            ctx.destinationSnap,
            ctx.entrancePoint,
            ctx.destinationPoint
        );
    }

    function toPointFeature(value, label) {
        if (!value) throw new Error(`SyntheticIndoorCorridorService: brak ${label}`);
        if (value.type === "Feature" && value.geometry?.type === "Point") return value;
        if (value.type === "Point") return turf.feature(value);
        if (Array.isArray(value) && value.length >= 2) return turf.point([value[0], value[1]]);
        if (typeof value.lng === "number" && typeof value.lat === "number") {
            return turf.point([value.lng, value.lat]);
        }
        if (typeof value.lon === "number" && typeof value.lat === "number") {
            return turf.point([value.lon, value.lat]);
        }
        throw new Error(`SyntheticIndoorCorridorService: nieobsługiwany format ${label}`);
    }

    function toPolygonFeature(value, label) {
        if (!value) throw new Error(`SyntheticIndoorCorridorService: brak ${label}`);
        if (value.type === "Feature") {
            if (value.geometry?.type === "Polygon") return value;
            throw new Error(`SyntheticIndoorCorridorService: ${label} musi być Polygonem`);
        }
        if (value.type === "Polygon") return turf.feature(value);
        throw new Error(`SyntheticIndoorCorridorService: nieobsługiwany format ${label}`);
    }

    function normalizeBearing(bearing) {
        let value = bearing % 360;
        if (value < 0) value += 360;
        return value;
    }

    function longestEdgeBearing(polygonFeature) {
        const ring = polygonFeature.geometry.coordinates[0];
        let bestBearing = 0;
        let bestLength = -1;

        for (let i = 0; i < ring.length - 1; i++) {
            const start = ring[i];
            const end = ring[i + 1];
            const length = turf.distance(turf.point(start), turf.point(end), { units: "meters" });
            if (length > bestLength) {
                bestLength = length;
                bestBearing = turf.bearing(start, end);
            }
        }

        return normalizeBearing(bestBearing);
    }

    function offsetAlongBearingMeters(originCoord, targetCoord, axisBearing) {
        const origin = turf.point(originCoord);
        const target = turf.point(targetCoord);
        const distance = turf.distance(origin, target, { units: "meters" });
        const targetBearing = turf.bearing(origin, target);
        let diff = targetBearing - axisBearing;

        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;

        return distance * Math.cos((diff * Math.PI) / 180);
    }

    function coordFromAxisOffsets(originCoord, primaryBearing, secondaryBearing, primaryOffset, secondaryOffset) {
        let point = turf.point(originCoord);
        point = turf.rhumbDestination(point, secondaryOffset, secondaryBearing, { units: "meters" });
        point = turf.rhumbDestination(point, primaryOffset, primaryBearing, { units: "meters" });
        return point.geometry.coordinates;
    }

    function computeOrientedBBox(polygonFeature, center, primaryBearing, secondaryBearing) {
        const ring = polygonFeature.geometry.coordinates[0];
        let minPrimary = Infinity;
        let maxPrimary = -Infinity;
        let minSecondary = Infinity;
        let maxSecondary = -Infinity;

        ring.forEach((coord) => {
            const primary = offsetAlongBearingMeters(center, coord, primaryBearing);
            const secondary = offsetAlongBearingMeters(center, coord, secondaryBearing);
            minPrimary = Math.min(minPrimary, primary);
            maxPrimary = Math.max(maxPrimary, primary);
            minSecondary = Math.min(minSecondary, secondary);
            maxSecondary = Math.max(maxSecondary, secondary);
        });

        const widthMeters = maxPrimary - minPrimary;
        const heightMeters = maxSecondary - minSecondary;
        const corners = [
            coordFromAxisOffsets(center, primaryBearing, secondaryBearing, minPrimary, minSecondary),
            coordFromAxisOffsets(center, primaryBearing, secondaryBearing, maxPrimary, minSecondary),
            coordFromAxisOffsets(center, primaryBearing, secondaryBearing, maxPrimary, maxSecondary),
            coordFromAxisOffsets(center, primaryBearing, secondaryBearing, minPrimary, maxSecondary),
            coordFromAxisOffsets(center, primaryBearing, secondaryBearing, minPrimary, minSecondary),
        ];

        return {
            minPrimary,
            maxPrimary,
            minSecondary,
            maxSecondary,
            widthMeters,
            heightMeters,
            maxSpanMeters: Math.max(widthMeters, heightMeters),
            corners,
            polygon: turf.polygon([corners]),
        };
    }

    function buildInsetPolygon(buildingPolygon, wallMarginMeters) {
        let margin = wallMarginMeters;

        while (margin >= MIN_WALL_MARGIN_METERS) {
            try {
                const inset = turf.buffer(buildingPolygon, -margin, {
                    units: "meters",
                    steps: BUFFER_STEPS,
                });
                if (inset?.geometry?.type === "Polygon" && inset.geometry.coordinates[0]?.length >= 4) {
                    return { polygon: inset, marginMeters: margin, fallback: false };
                }
            } catch (_error) {
                /* zbyt agresywne wcięcie */
            }
            margin *= 0.65;
        }

        return { polygon: buildingPolygon, marginMeters: 0, fallback: true };
    }

    function computeAreaRatio(innerPolygon, outerPolygon) {
        const inner = turf.area(innerPolygon);
        const outer = turf.area(outerPolygon);
        if (!outer) return 0;
        return inner / outer;
    }

    function buildInsetCorridorNetwork(insetPolygon) {
        const outline = turf.polygonToLine(insetPolygon);
        const lineFeatures =
            outline.geometry.type === "LineString"
                ? [outline]
                : outline.geometry.coordinates.map((coords) => turf.lineString(coords));

        const corridorCoords = [];
        lineFeatures.forEach((lineFeature) => {
            const coords = lineFeature.geometry.coordinates;
            for (let i = 0; i < coords.length - 1; i++) {
                if (coordsEqual(coords[i], coords[i + 1])) continue;
                corridorCoords.push([coords[i], coords[i + 1]]);
            }
        });

        if (!corridorCoords.length) {
            throw new Error("SyntheticIndoorCorridorService: brak segmentów inset polygon");
        }

        return turf.multiLineString(corridorCoords, {
            source: "inset-polygon-outline",
            segmentCount: corridorCoords.length,
        });
    }

    function insetPolygonOutlineFeature(insetPolygon, properties = {}) {
        const outline = turf.polygonToLine(insetPolygon);
        outline.properties = {
            source: "inset-polygon",
            ...(outline.properties || {}),
            ...properties,
        };
        return outline;
    }

    function extractCorridorSegments(virtualCorridors) {
        const lines =
            virtualCorridors.type === "Feature"
                ? virtualCorridors.geometry.type === "MultiLineString"
                    ? virtualCorridors.geometry.coordinates.map((coords) => turf.lineString(coords))
                    : [virtualCorridors]
                : [];

        const segments = [];
        lines.forEach((lineFeature, lineIndex) => {
            const coords = lineFeature.geometry?.coordinates;
            if (!coords || coords.length < 2) return;
            for (let i = 0; i < coords.length - 1; i++) {
                if (coordsEqual(coords[i], coords[i + 1])) continue;
                segments.push({
                    id: `${lineIndex}:${i}`,
                    coords: [coords[i], coords[i + 1]],
                    line: turf.lineString([coords[i], coords[i + 1]]),
                });
            }
        });
        return segments;
    }

    function snapPointToCorridors(pointFeature, segments, maxSnapDistanceMeters, label) {
        let best = null;

        segments.forEach((segment) => {
            const snap = turf.nearestPointOnLine(segment.line, pointFeature, { units: "meters" });
            const distanceMeters = snap.properties.dist;
            if (distanceMeters > maxSnapDistanceMeters) return;
            if (!best || distanceMeters < best.distanceMeters) {
                best = {
                    coord: snap.geometry.coordinates.slice(),
                    distanceMeters,
                    segment,
                };
            }
        });

        if (!best) {
            throw new Error(
                `SyntheticIndoorCorridorService: ${label} zbyt daleko od synthetic corridors (max ${maxSnapDistanceMeters.toFixed(1)} m)`
            );
        }

        return best;
    }

    function nodeKey(coord) {
        return `${coord[0].toFixed(COORD_PRECISION)},${coord[1].toFixed(COORD_PRECISION)}`;
    }

    function coordsEqual(a, b, toleranceMeters = DEDUPE_TOLERANCE_METERS) {
        return turf.distance(turf.point(a), turf.point(b), { units: "meters" }) <= toleranceMeters;
    }

    function dedupeCoords(coords, toleranceMeters = DEDUPE_TOLERANCE_METERS) {
        const out = [];
        coords.forEach((coord) => {
            if (!out.length || !coordsEqual(out[out.length - 1], coord, toleranceMeters)) {
                out.push(coord);
            }
        });
        return out;
    }

    function normalizeBearingDelta(bearing1, bearing2) {
        let diff = Math.abs(bearing2 - bearing1);
        if (diff > 180) diff = 360 - diff;
        return diff;
    }

    function removeCollinearCoords(coords, minTurnDegrees = MIN_TURN_DEGREES) {
        if (coords.length <= 2) return coords;
        const out = [coords[0]];
        for (let i = 1; i < coords.length - 1; i++) {
            const turn = normalizeBearingDelta(
                turf.bearing(coords[i - 1], coords[i]),
                turf.bearing(coords[i], coords[i + 1])
            );
            if (turn >= minTurnDegrees) out.push(coords[i]);
        }
        out.push(coords[coords.length - 1]);
        return out;
    }

    function createGraph() {
        return { nodes: new Map(), edges: [] };
    }

    function getOrCreateNode(graph, coord, kind) {
        const id = nodeKey(coord);
        let node = graph.nodes.get(id);
        if (!node) {
            node = { id, coord: [coord[0], coord[1]], kind, neighbors: [] };
            graph.nodes.set(id, node);
        }
        return node;
    }

    function addUndirectedEdge(graph, nodeA, nodeB) {
        if (coordsEqual(nodeA.coord, nodeB.coord)) return;
        const weight = turf.distance(turf.point(nodeA.coord), turf.point(nodeB.coord), { units: "meters" });
        if (weight <= DEDUPE_TOLERANCE_METERS) return;
        if (nodeA.neighbors.some((entry) => entry.nodeId === nodeB.id)) return;
        nodeA.neighbors.push({ nodeId: nodeB.id, weight });
        nodeB.neighbors.push({ nodeId: nodeA.id, weight });
        graph.edges.push({ from: nodeA.id, to: nodeB.id, weight });
    }

    function pointOnSegment(pointCoord, segment) {
        const snap = turf.nearestPointOnLine(segment.line, turf.point(pointCoord), { units: "meters" });
        return snap.properties.dist <= DEDUPE_TOLERANCE_METERS;
    }

    function collectIntersectionPoints(segments) {
        const points = [];
        for (let i = 0; i < segments.length; i++) {
            for (let j = i + 1; j < segments.length; j++) {
                const hits = turf.lineIntersect(segments[i].line, segments[j].line);
                hits.features.forEach((feature) => {
                    points.push({ coord: feature.geometry.coordinates.slice() });
                });
            }
        }
        return points;
    }

    function splitPointsForSegment(segment, points) {
        const onSegment = points.filter((point) => pointOnSegment(point.coord, segment));
        onSegment.push(
            { coord: segment.coords[0].slice() },
            { coord: segment.coords[1].slice() }
        );

        const unique = [];
        onSegment.forEach((point) => {
            if (!unique.some((existing) => coordsEqual(existing.coord, point.coord))) {
                unique.push(point);
            }
        });

        unique.sort((a, b) => {
            const locA = turf.nearestPointOnLine(segment.line, turf.point(a.coord), { units: "meters" }).properties
                .location;
            const locB = turf.nearestPointOnLine(segment.line, turf.point(b.coord), { units: "meters" }).properties
                .location;
            return locA - locB;
        });

        return unique;
    }

    function buildCorridorGraph(segments, entranceSnap, destinationSnap, entrancePoint, destinationPoint) {
        const graph = createGraph();
        const intersectionPoints = collectIntersectionPoints(segments);
        const snapPoints = [
            { coord: entranceSnap.coord },
            { coord: destinationSnap.coord },
        ];

        segments.forEach((segment) => {
            const points = splitPointsForSegment(segment, [...intersectionPoints, ...snapPoints]);
            const nodes = points.map((point) => getOrCreateNode(graph, point.coord, "corridor"));
            for (let i = 0; i < nodes.length - 1; i++) {
                addUndirectedEdge(graph, nodes[i], nodes[i + 1]);
            }
        });

        const entranceNode = getOrCreateNode(graph, entrancePoint.geometry.coordinates, "entrance");
        const destinationNode = getOrCreateNode(graph, destinationPoint.geometry.coordinates, "destination");
        const entranceSnapNode = getOrCreateNode(graph, entranceSnap.coord, "snap");
        const destinationSnapNode = getOrCreateNode(graph, destinationSnap.coord, "snap");

        addUndirectedEdge(graph, entranceNode, entranceSnapNode);
        addUndirectedEdge(graph, destinationNode, destinationSnapNode);

        return graph;
    }

    function dijkstra(graph, startId, endId) {
        if (!graph?.nodes?.size || !startId || !endId) return null;
        if (startId === endId) return [startId];

        const dist = new Map();
        const prev = new Map();
        const visited = new Set();
        const queue = [{ id: startId, dist: 0 }];
        dist.set(startId, 0);

        while (queue.length) {
            queue.sort((a, b) => a.dist - b.dist);
            const current = queue.shift();
            if (!current || visited.has(current.id)) continue;
            visited.add(current.id);
            if (current.id === endId) break;

            const node = graph.nodes.get(current.id);
            if (!node) continue;

            node.neighbors.forEach(({ nodeId, weight }) => {
                const nextDist = current.dist + weight;
                if (!dist.has(nodeId) || nextDist < dist.get(nodeId)) {
                    dist.set(nodeId, nextDist);
                    prev.set(nodeId, current.id);
                    queue.push({ id: nodeId, dist: nextDist });
                }
            });
        }

        if (!prev.has(endId) && startId !== endId) return null;

        const path = [];
        let cursor = endId;
        while (cursor) {
            path.unshift(cursor);
            cursor = prev.get(cursor);
        }
        return path.length ? path : null;
    }

    function ensurePathInsideBuilding(coords, buildingPolygon) {
        const validated = [coords[0]];
        for (let i = 1; i < coords.length; i++) {
            const from = validated[validated.length - 1];
            const to = coords[i];
            if (segmentInsideBuilding(from, to, buildingPolygon)) {
                validated.push(to);
                continue;
            }

            const mid = midpointCoord(from, to);
            if (segmentInsideBuilding(from, mid, buildingPolygon)) {
                validated.push(mid);
            }
            if (segmentInsideBuilding(validated[validated.length - 1], to, buildingPolygon)) {
                validated.push(to);
            }
        }
        return dedupeCoords(validated);
    }

    function midpointCoord(from, to) {
        return turf.midpoint(turf.point(from), turf.point(to)).geometry.coordinates;
    }

    function segmentInsideBuilding(from, to, polygonFeature) {
        const line = turf.lineString([from, to]);
        const length = turf.length(line, { units: "meters" });
        if (length <= DEDUPE_TOLERANCE_METERS) {
            return turf.booleanPointInPolygon(turf.point(from), polygonFeature, { ignoreBoundary: true });
        }

        const samples = [0.25, 0.5, 0.75];
        for (let i = 0; i < samples.length; i++) {
            const sample = turf.along(line, length * samples[i], { units: "meters" });
            if (!turf.booleanPointInPolygon(sample, polygonFeature, { ignoreBoundary: true })) {
                return false;
            }
        }

        return true;
    }

    function buildSegmentList(coords) {
        const segments = [];
        for (let i = 0; i < coords.length - 1; i++) {
            const from = coords[i];
            const to = coords[i + 1];
            const line = turf.lineString([from, to]);
            segments.push({
                from: from.slice(),
                to: to.slice(),
                lengthMeters: turf.length(line, { units: "meters" }),
                bearing: normalizeBearing(turf.bearing(from, to)),
            });
        }
        return segments;
    }

    function extractTurnPoints(coords) {
        if (coords.length <= 2) return [];
        const points = [];
        for (let i = 1; i < coords.length - 1; i++) {
            const turn = normalizeBearingDelta(
                turf.bearing(coords[i - 1], coords[i]),
                turf.bearing(coords[i], coords[i + 1])
            );
            if (turn >= MIN_TURN_DEGREES) {
                points.push(
                    turf.point(coords[i], {
                        turnDegrees: Math.round(turn),
                    })
                );
            }
        }
        return points;
    }

    global.TupTupSyntheticIndoorCorridor = {
        DEFAULT_WALL_MARGIN_METERS,
        SyntheticIndoorCorridorService,
        buildInsetPolygon,
        insetPolygonOutlineFeature,
        route: function route(input) {
            return new SyntheticIndoorCorridorService().route(input);
        },
    };
})(typeof window !== "undefined" ? window : globalThis);
