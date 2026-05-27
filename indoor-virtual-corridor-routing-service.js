/**
 * IndoorVirtualCorridorRoutingService – routing indoor po sieci virtualCorridors.
 *
 * buildingPolygon: wyłącznie walidacja i ograniczenie.
 * virtualCorridors: GeoJSON LineString / MultiLineString – centerline korytarzy.
 *
 * Przepływ: walidacja → snap (nearestPointOnLine) → graf korytarzy → Dijkstra → LineString.
 */
(function (global) {
    const turf = global.turf;
    if (!turf) {
        console.warn("[IndoorVirtualCorridorRoutingService] Brak Turf.js – routing indoor niedostępny.");
    }

    const DEFAULT_MAX_SNAP_DISTANCE_METERS = 25;
    const DEFAULT_MAX_EDGE_DISTANCE_FROM_BUILDING_METERS = 3;
    const DEFAULT_MAX_POINT_EDGE_DISTANCE_METERS = 8;
    const COORD_PRECISION = 7;
    const DEDUPE_TOLERANCE_METERS = 0.05;
    const MIN_TURN_DEGREES = 12;

    const NodeKind = {
        ENDPOINT: "endpoint",
        INTERSECTION: "intersection",
        SNAP: "snap",
        ENTRANCE: "entrance",
        DESTINATION: "destination",
    };

    function IndoorVirtualCorridorRoutingService(options = {}) {
        this._maxSnapDistanceMeters = options.maxSnapDistanceMeters ?? DEFAULT_MAX_SNAP_DISTANCE_METERS;
        this._maxEdgeDistanceFromBuildingMeters =
            options.maxEdgeDistanceFromBuildingMeters ?? DEFAULT_MAX_EDGE_DISTANCE_FROM_BUILDING_METERS;
        this._maxPointEdgeDistanceMeters =
            options.maxPointEdgeDistanceMeters ?? DEFAULT_MAX_POINT_EDGE_DISTANCE_METERS;
    }

    IndoorVirtualCorridorRoutingService.prototype.route = function route(input) {
        if (!turf) {
            throw new Error("IndoorVirtualCorridorRoutingService wymaga Turf.js");
        }

        const ctx = normalizeContext(input, this);
        validateContext(ctx);

        const segments = extractCorridorSegments(ctx.virtualCorridors);
        if (!segments.length) {
            throw new Error("IndoorVirtualCorridorRoutingService: brak segmentów w virtualCorridors");
        }

        const entranceSnap = snapPointToCorridors(ctx.entrancePoint, segments, ctx.maxSnapDistanceMeters, "entrance");
        const destinationSnap = snapPointToCorridors(
            ctx.destinationPoint,
            segments,
            ctx.maxSnapDistanceMeters,
            "destination"
        );

        const graph = buildCorridorGraph(segments, entranceSnap, destinationSnap, ctx);
        const entranceNodeId = nodeKey(ctx.entrancePoint.geometry.coordinates);
        const destinationNodeId = nodeKey(ctx.destinationPoint.geometry.coordinates);
        const pathNodeIds = dijkstra(graph, entranceNodeId, destinationNodeId);

        if (!pathNodeIds?.length) {
            throw new Error("IndoorVirtualCorridorRoutingService: nie znaleziono trasy po korytarzach");
        }

        const corridorCoords = pathNodeIds.map((id) => graph.nodes.get(id).coord.slice());
        const fullCoords = buildRenderablePath(
            ctx.entrancePoint.geometry.coordinates,
            corridorCoords,
            ctx.destinationPoint.geometry.coordinates
        );

        const simplified = dedupeCoords(removeCollinearCoords(fullCoords));
        const decisionPoints = extractDecisionPoints(simplified);

        const line = turf.lineString(simplified, {
            routing: "indoor-virtual-corridor",
            lengthMeters: turf.length(turf.lineString(simplified), { units: "meters" }),
            entranceSnapDistanceMeters: entranceSnap.distanceMeters,
            destinationSnapDistanceMeters: destinationSnap.distanceMeters,
            decisionPointCount: decisionPoints.length,
            corridorNodeCount: pathNodeIds.length,
        });

        line.properties.decisionPoints = decisionPoints;

        return line;
    };

    IndoorVirtualCorridorRoutingService.prototype.buildGraph = function buildGraph(input) {
        if (!turf) {
            throw new Error("IndoorVirtualCorridorRoutingService wymaga Turf.js");
        }

        const ctx = normalizeContext(input, this);
        validateContext(ctx);

        const segments = extractCorridorSegments(ctx.virtualCorridors);
        const entranceSnap = snapPointToCorridors(ctx.entrancePoint, segments, ctx.maxSnapDistanceMeters, "entrance");
        const destinationSnap = snapPointToCorridors(
            ctx.destinationPoint,
            segments,
            ctx.maxSnapDistanceMeters,
            "destination"
        );

        return buildCorridorGraph(segments, entranceSnap, destinationSnap, ctx);
    };

    function normalizeContext(input, service) {
        return {
            entrancePoint: toPointFeature(input.entrancePoint, "entrancePoint"),
            destinationPoint: toPointFeature(input.destinationPoint, "destinationPoint"),
            buildingPolygon: toPolygonFeature(input.buildingPolygon, "buildingPolygon"),
            virtualCorridors: input.virtualCorridors,
            maxSnapDistanceMeters:
                typeof input.maxSnapDistanceMeters === "number"
                    ? input.maxSnapDistanceMeters
                    : service._maxSnapDistanceMeters,
            maxEdgeDistanceFromBuildingMeters:
                typeof input.maxEdgeDistanceFromBuildingMeters === "number"
                    ? input.maxEdgeDistanceFromBuildingMeters
                    : service._maxEdgeDistanceFromBuildingMeters,
            maxPointEdgeDistanceMeters:
                typeof input.maxPointEdgeDistanceMeters === "number"
                    ? input.maxPointEdgeDistanceMeters
                    : service._maxPointEdgeDistanceMeters,
        };
    }

    function toPointFeature(value, label) {
        if (!value) {
            throw new Error(`IndoorVirtualCorridorRoutingService: brak ${label}`);
        }

        if (value.type === "Feature" && value.geometry?.type === "Point") {
            return value;
        }

        if (value.type === "Point") {
            return turf.feature(value);
        }

        if (Array.isArray(value) && value.length >= 2) {
            return turf.point([value[0], value[1]]);
        }

        if (typeof value.lng === "number" && typeof value.lat === "number") {
            return turf.point([value.lng, value.lat]);
        }

        if (typeof value.lon === "number" && typeof value.lat === "number") {
            return turf.point([value.lon, value.lat]);
        }

        throw new Error(`IndoorVirtualCorridorRoutingService: nieobsługiwany format ${label}`);
    }

    function toPolygonFeature(value, label) {
        if (!value) {
            throw new Error(`IndoorVirtualCorridorRoutingService: brak ${label}`);
        }

        if (value.type === "Feature") {
            if (value.geometry?.type === "Polygon") return value;
            throw new Error(`IndoorVirtualCorridorRoutingService: ${label} musi być Polygonem`);
        }

        if (value.type === "Polygon") {
            return turf.feature(value);
        }

        throw new Error(`IndoorVirtualCorridorRoutingService: nieobsługiwany format ${label}`);
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
            if (turn >= minTurnDegrees) {
                out.push(coords[i]);
            }
        }
        out.push(coords[coords.length - 1]);
        return out;
    }

    function pointInsideOrNearBoundary(pointFeature, polygonFeature, maxEdgeMeters) {
        if (turf.booleanPointInPolygon(pointFeature, polygonFeature, { ignoreBoundary: false })) {
            return true;
        }

        const outline = turf.polygonToLine(polygonFeature);
        const lines =
            outline.geometry.type === "LineString"
                ? [outline]
                : outline.geometry.coordinates.map((coords) => turf.lineString(coords));

        let minDist = Infinity;
        lines.forEach((line) => {
            const snap = turf.nearestPointOnLine(line, pointFeature, { units: "meters" });
            minDist = Math.min(minDist, snap.properties.dist);
        });

        return minDist <= maxEdgeMeters;
    }

    function segmentInsideBuilding(from, to, polygonFeature, maxOutsideMeters) {
        const line = turf.lineString([from, to]);
        const length = turf.length(line, { units: "meters" });
        if (length <= DEDUPE_TOLERANCE_METERS) {
            return turf.booleanPointInPolygon(turf.point(from), polygonFeature, { ignoreBoundary: true });
        }

        const samples = [0.25, 0.5, 0.75];
        for (let i = 0; i < samples.length; i++) {
            const sample = turf.along(line, length * samples[i], { units: "meters" });
            if (turf.booleanPointInPolygon(sample, polygonFeature, { ignoreBoundary: true })) {
                continue;
            }

            const outline = turf.polygonToLine(polygonFeature);
            const snap = turf.nearestPointOnLine(outline, sample, { units: "meters" });
            if (snap.properties.dist > maxOutsideMeters) {
                return false;
            }
        }

        return true;
    }

    function validateContext(ctx) {
        if (!ctx.virtualCorridors) {
            throw new Error("IndoorVirtualCorridorRoutingService: brak virtualCorridors");
        }

        if (
            !pointInsideOrNearBoundary(
                ctx.entrancePoint,
                ctx.buildingPolygon,
                ctx.maxPointEdgeDistanceMeters
            )
        ) {
            throw new Error(
                "IndoorVirtualCorridorRoutingService: entrancePoint poza budynkiem i zbyt daleko od krawędzi"
            );
        }

        if (
            !pointInsideOrNearBoundary(
                ctx.destinationPoint,
                ctx.buildingPolygon,
                ctx.maxPointEdgeDistanceMeters
            )
        ) {
            throw new Error(
                "IndoorVirtualCorridorRoutingService: destinationPoint poza budynkiem i zbyt daleko od krawędzi"
            );
        }

        const segments = extractCorridorSegments(ctx.virtualCorridors);
        if (!segments.length) {
            throw new Error("IndoorVirtualCorridorRoutingService: virtualCorridors nie zawiera segmentów");
        }

        segments.forEach((segment, index) => {
            if (
                !segmentInsideBuilding(
                    segment.coords[0],
                    segment.coords[1],
                    ctx.buildingPolygon,
                    ctx.maxEdgeDistanceFromBuildingMeters
                )
            ) {
                throw new Error(
                    `IndoorVirtualCorridorRoutingService: segment korytarza ${index} wychodzi poza buildingPolygon`
                );
            }
        });
    }

    function extractCorridorLines(virtualCorridors) {
        if (!virtualCorridors) return [];

        if (virtualCorridors.type === "Feature") {
            return extractCorridorLines(virtualCorridors.geometry);
        }

        if (virtualCorridors.type === "FeatureCollection") {
            const lines = [];
            (virtualCorridors.features || []).forEach((feature) => {
                lines.push(...extractCorridorLines(feature));
            });
            return lines;
        }

        if (virtualCorridors.type === "LineString") {
            return [turf.feature(virtualCorridors)];
        }

        if (virtualCorridors.type === "MultiLineString") {
            return virtualCorridors.coordinates.map((coords) => turf.lineString(coords));
        }

        if (virtualCorridors.type === "GeometryCollection") {
            const lines = [];
            (virtualCorridors.geometries || []).forEach((geometry) => {
                lines.push(...extractCorridorLines(geometry));
            });
            return lines;
        }

        throw new Error("IndoorVirtualCorridorRoutingService: nieobsługiwany format virtualCorridors");
    }

    function extractCorridorSegments(virtualCorridors) {
        const lines = extractCorridorLines(virtualCorridors);
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
                    location: snap.properties.location,
                    segmentId: segment.id,
                    segment,
                    nodeId: null,
                };
            }
        });

        if (!best) {
            throw new Error(
                `IndoorVirtualCorridorRoutingService: ${label} zbyt daleko od virtualCorridors (max ${maxSnapDistanceMeters} m)`
            );
        }

        best.nodeId = `${label}:${nodeKey(best.coord)}`;
        return best;
    }

    function createGraph() {
        return { nodes: new Map(), edges: [] };
    }

    function getOrCreateNode(graph, coord, kind, metadata = null) {
        const id = nodeKey(coord);
        let node = graph.nodes.get(id);
        if (!node) {
            node = {
                id,
                coord: [coord[0], coord[1]],
                kind,
                metadata,
                neighbors: [],
            };
            graph.nodes.set(id, node);
        } else if (kind && node.kind === NodeKind.ENDPOINT) {
            node.kind = kind;
        }
        return node;
    }

    function addUndirectedEdge(graph, nodeA, nodeB) {
        if (coordsEqual(nodeA.coord, nodeB.coord)) return;

        const weight = turf.distance(turf.point(nodeA.coord), turf.point(nodeB.coord), { units: "meters" });
        if (weight <= DEDUPE_TOLERANCE_METERS) return;

        const exists = nodeA.neighbors.some((entry) => entry.nodeId === nodeB.id);
        if (exists) return;

        nodeA.neighbors.push({ nodeId: nodeB.id, weight });
        nodeB.neighbors.push({ nodeId: nodeA.id, weight });
        graph.edges.push({ from: nodeA.id, to: nodeB.id, weight });
    }

    function pointOnSegment(pointCoord, segment, toleranceMeters = DEDUPE_TOLERANCE_METERS) {
        const snap = turf.nearestPointOnLine(segment.line, turf.point(pointCoord), { units: "meters" });
        return snap.properties.dist <= toleranceMeters;
    }

    function collectIntersectionPoints(segments) {
        const points = [];

        for (let i = 0; i < segments.length; i++) {
            for (let j = i + 1; j < segments.length; j++) {
                const hits = turf.lineIntersect(segments[i].line, segments[j].line);
                hits.features.forEach((feature) => {
                    points.push({
                        coord: feature.geometry.coordinates.slice(),
                        kind: NodeKind.INTERSECTION,
                    });
                });
            }
        }

        return points;
    }

    function splitPointsForSegment(segment, points) {
        const onSegment = [];

        points.forEach((point) => {
            if (!pointOnSegment(point.coord, segment)) return;
            onSegment.push(point);
        });

        onSegment.push(
            { coord: segment.coords[0].slice(), kind: NodeKind.ENDPOINT },
            { coord: segment.coords[1].slice(), kind: NodeKind.ENDPOINT }
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

    function buildCorridorGraph(segments, entranceSnap, destinationSnap, ctx) {
        const graph = createGraph();
        const intersectionPoints = collectIntersectionPoints(segments);

        const snapPoints = [
            {
                coord: entranceSnap.coord,
                kind: NodeKind.SNAP,
                nodeId: entranceSnap.nodeId,
            },
            {
                coord: destinationSnap.coord,
                kind: NodeKind.SNAP,
                nodeId: destinationSnap.nodeId,
            },
        ];

        segments.forEach((segment) => {
            const points = splitPointsForSegment(segment, [...intersectionPoints, ...snapPoints]);
            const nodes = points.map((point) => getOrCreateNode(graph, point.coord, point.kind));

            for (let i = 0; i < nodes.length - 1; i++) {
                addUndirectedEdge(graph, nodes[i], nodes[i + 1]);
            }
        });

        const entranceNode = getOrCreateNode(
            graph,
            ctx.entrancePoint.geometry.coordinates,
            NodeKind.ENTRANCE
        );
        const destinationNode = getOrCreateNode(
            graph,
            ctx.destinationPoint.geometry.coordinates,
            NodeKind.DESTINATION
        );
        const entranceSnapNode = getOrCreateNode(graph, entranceSnap.coord, NodeKind.SNAP, {
            snapFor: "entrance",
        });
        const destinationSnapNode = getOrCreateNode(graph, destinationSnap.coord, NodeKind.SNAP, {
            snapFor: "destination",
        });

        entranceSnap.nodeId = entranceSnapNode.id;
        destinationSnap.nodeId = destinationSnapNode.id;

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

    function buildRenderablePath(entranceCoord, corridorCoords, destinationCoord) {
        let coords = corridorCoords.slice();

        if (!coords.length) {
            return dedupeCoords([entranceCoord, destinationCoord]);
        }

        if (!coordsEqual(entranceCoord, coords[0])) {
            coords.unshift(entranceCoord.slice());
        }

        if (!coordsEqual(destinationCoord, coords[coords.length - 1])) {
            coords.push(destinationCoord.slice());
        }

        return dedupeCoords(coords);
    }

    function extractDecisionPoints(coords) {
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
                        kind: NodeKind.INTERSECTION,
                        turnDegrees: Math.round(turn),
                    })
                );
            }
        }

        return points;
    }

    function normalizeAnchorCoord(value) {
        if (!value) return null;

        if (Array.isArray(value) && value.length >= 2) {
            return [value[0], value[1]];
        }

        if (typeof value.lng === "number" && typeof value.lat === "number") {
            return [value.lng, value.lat];
        }

        if (typeof value.lon === "number" && typeof value.lat === "number") {
            return [value.lon, value.lat];
        }

        return null;
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

    function collectAxisOffsetRange(polygonFeature, originCoord, axisBearing) {
        const ring = polygonFeature.geometry.coordinates[0];
        let min = Infinity;
        let max = -Infinity;

        ring.forEach((coord) => {
            const offset = offsetAlongBearingMeters(originCoord, coord, axisBearing);
            min = Math.min(min, offset);
            max = Math.max(max, offset);
        });

        return { min, max };
    }

    function buildOrientedAxisLine(originCoord, lineBearing, crossBearing, crossOffsetMeters, halfLengthMeters) {
        const origin = turf.point(originCoord);
        const base = turf.rhumbDestination(origin, crossOffsetMeters, crossBearing, { units: "meters" });
        const start = turf.rhumbDestination(base, halfLengthMeters, lineBearing, { units: "meters" });
        const end = turf.rhumbDestination(base, halfLengthMeters, lineBearing + 180, { units: "meters" });

        return turf.lineString([start.geometry.coordinates, end.geometry.coordinates]);
    }

    function clipLineChordsToPolygon(axisLine, polygon) {
        const boundary = turf.polygonToLine(polygon);
        const hits = turf.lineIntersect(axisLine, boundary);
        if (hits.features.length < 2) return [];

        const sorted = hits.features
            .map((feature) => ({
                coord: feature.geometry.coordinates,
                location: turf.nearestPointOnLine(axisLine, feature, { units: "meters" }).properties
                    .location,
            }))
            .sort((a, b) => a.location - b.location);

        const chords = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const slice = turf.lineSlice(
                turf.point(sorted[i].coord),
                turf.point(sorted[i + 1].coord),
                axisLine
            );
            const sliceLength = turf.length(slice, { units: "meters" });
            if (sliceLength <= DEDUPE_TOLERANCE_METERS) continue;

            const mid = turf.along(slice, sliceLength / 2, { units: "meters" });
            if (turf.booleanPointInPolygon(mid, polygon, { ignoreBoundary: true })) {
                chords.push(slice.geometry.coordinates);
            }
        }

        return chords;
    }

    function addAxisOffsets(target, range, divisions, extraOffsets) {
        target.add(0);

        for (let i = 1; i < divisions; i++) {
            const t = i / divisions;
            target.add(range.min + (range.max - range.min) * t);
        }

        extraOffsets.forEach((value) => {
            if (Number.isFinite(value)) target.add(value);
        });
    }

    function bboxDiagonalMeters(bbox) {
        return turf.distance(turf.point([bbox[0], bbox[1]]), turf.point([bbox[2], bbox[3]]), {
            units: "meters",
        });
    }

    function dedupeCorridorCoords(allCoords) {
        const out = [];

        allCoords.forEach((coords) => {
            if (!coords || coords.length < 2) return;

            const duplicate = out.some((existing) => {
                if (existing.length !== coords.length) return false;
                return existing.every((coord, index) => coordsEqual(coord, coords[index]));
            });

            if (!duplicate) out.push(coords);
        });

        return out;
    }

    /**
     * Helper danych – buduje virtualCorridors (nie trasę).
     * Osie obrócone względem dłuższej krawędzi budynku + siatka i anchorPoints.
     */
    function createAxisCorridorNetwork(buildingPolygon, options = {}) {
        if (!turf) {
            throw new Error("createAxisCorridorNetwork wymaga Turf.js");
        }

        const polygon = toPolygonFeature(buildingPolygon, "buildingPolygon");
        const center = turf.center(polygon).geometry.coordinates;
        const bbox = turf.bbox(polygon);
        const divisions = Math.max(2, options.gridDivisions || 3);
        const primaryBearing = normalizeBearing(
            typeof options.primaryBearing === "number"
                ? options.primaryBearing
                : longestEdgeBearing(polygon)
        );
        const secondaryBearing = normalizeBearing(primaryBearing + 90);
        const halfLengthMeters = bboxDiagonalMeters(bbox) * 0.75 + 8;

        const primaryRange = collectAxisOffsetRange(polygon, center, primaryBearing);
        const secondaryRange = collectAxisOffsetRange(polygon, center, secondaryBearing);

        const parallelPrimaryOffsets = new Set();
        const parallelSecondaryOffsets = new Set();
        const anchorPrimaryOffsets = [];
        const anchorSecondaryOffsets = [];

        (options.anchorPoints || []).forEach((anchor) => {
            const coord = normalizeAnchorCoord(anchor);
            if (!coord) return;
            anchorPrimaryOffsets.push(offsetAlongBearingMeters(center, coord, primaryBearing));
            anchorSecondaryOffsets.push(offsetAlongBearingMeters(center, coord, secondaryBearing));
        });

        addAxisOffsets(parallelPrimaryOffsets, secondaryRange, divisions, anchorSecondaryOffsets);
        addAxisOffsets(parallelSecondaryOffsets, primaryRange, divisions, anchorPrimaryOffsets);

        const corridorCoords = [];
        const axisCount = parallelPrimaryOffsets.size + parallelSecondaryOffsets.size;

        parallelPrimaryOffsets.forEach((crossOffsetMeters) => {
            const axisLine = buildOrientedAxisLine(
                center,
                primaryBearing,
                secondaryBearing,
                crossOffsetMeters,
                halfLengthMeters
            );
            corridorCoords.push(...clipLineChordsToPolygon(axisLine, polygon));
        });

        parallelSecondaryOffsets.forEach((crossOffsetMeters) => {
            const axisLine = buildOrientedAxisLine(
                center,
                secondaryBearing,
                primaryBearing,
                crossOffsetMeters,
                halfLengthMeters
            );
            corridorCoords.push(...clipLineChordsToPolygon(axisLine, polygon));
        });

        const uniqueCoords = dedupeCorridorCoords(corridorCoords);
        if (!uniqueCoords.length) {
            throw new Error("createAxisCorridorNetwork: nie udało się wyznaczyć osi korytarzy");
        }

        return turf.multiLineString(uniqueCoords, {
            source: options.source || "axis-corridor-network",
            axisCount,
            segmentCount: uniqueCoords.length,
            primaryBearing,
            secondaryBearing,
        });
    }

    global.TupTupIndoorVirtualCorridorRouting = {
        NodeKind,
        DEFAULT_MAX_SNAP_DISTANCE_METERS,
        IndoorVirtualCorridorRoutingService,
        createAxisCorridorNetwork,
        longestEdgeBearing,
        route: function route(input) {
            return new IndoorVirtualCorridorRoutingService().route(input);
        },
    };
})(typeof window !== "undefined" ? window : globalThis);
