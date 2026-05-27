/**
 * OSM footway routing – pobieranie chodników z Overpass, graf lokalny, plugin dla OutdoorRoutingService.
 */
(function (global) {
    const turf = global.turf;
    const outlineApi = global.TupTupBuildingOutline;

    const OVERPASS_URL = outlineApi?.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
    const DEFAULT_RADIUS_METERS = 80;
    const MIN_RADIUS_METERS = 60;
    const MAX_SNAP_METERS = 28;
    const COORD_PRECISION = 7;
    const DEDUPE_TOLERANCE_METERS = 0.05;
    const MIN_TURN_DEGREES = 10;

    const networkCache = new Map();

    function nodeKey(coord) {
        return `${coord[0].toFixed(COORD_PRECISION)},${coord[1].toFixed(COORD_PRECISION)}`;
    }

    function coordsEqual(a, b) {
        return (
            turf.distance(turf.point(a), turf.point(b), { units: "meters" }) <= DEDUPE_TOLERANCE_METERS
        );
    }

    function dedupeCoords(coords) {
        const out = [];
        coords.forEach((coord) => {
            if (!out.length || !coordsEqual(out[out.length - 1], coord)) {
                out.push(coord);
            }
        });
        return out;
    }

    function removeCollinearCoords(coords, minTurnDegrees = MIN_TURN_DEGREES) {
        if (coords.length <= 2) return coords;

        const out = [coords[0]];
        for (let i = 1; i < coords.length - 1; i++) {
            const b1 = turf.bearing(coords[i - 1], coords[i]);
            const b2 = turf.bearing(coords[i], coords[i + 1]);
            let diff = Math.abs(b2 - b1);
            if (diff > 180) diff = 360 - diff;
            if (diff >= minTurnDegrees) out.push(coords[i]);
        }
        out.push(coords[coords.length - 1]);
        return out;
    }

    function segmentCrossesPolygonInterior(from, to, polygon) {
        const line = turf.lineString([from, to]);
        const length = turf.length(line, { units: "meters" });
        if (length <= DEDUPE_TOLERANCE_METERS) return false;

        const mid = turf.along(line, length / 2, { units: "meters" });
        return turf.booleanPointInPolygon(mid, polygon, { ignoreBoundary: true });
    }

    function buildFootwaysOverpassQuery(lat, lng, radiusMeters) {
        const radius = Math.round(Math.max(radiusMeters, MIN_RADIUS_METERS));
        return `[out:json][timeout:25];
(
  way["highway"~"^(footway|path|pedestrian|steps|living_street|corridor)$"](around:${radius},${lat},${lng});
  way["highway"]["footway"](around:${radius},${lat},${lng});
);
out geom;`;
    }

    async function postOverpass(query) {
        const response = await fetch(OVERPASS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                "User-Agent": "TupTup/1.0",
            },
            body: `data=${encodeURIComponent(query)}`,
        });

        if (!response.ok) {
            throw new Error(`Overpass HTTP ${response.status}`);
        }

        return response.json();
    }

    function wayToSegments(element) {
        if (!element?.geometry?.length || element.geometry.length < 2) return [];

        const coords = element.geometry.map(({ lon, lat }) => [lon, lat]);
        const segments = [];

        for (let i = 0; i < coords.length - 1; i++) {
            if (coordsEqual(coords[i], coords[i + 1])) continue;
            segments.push({
                coords: [coords[i], coords[i + 1]],
                line: turf.lineString([coords[i], coords[i + 1]]),
            });
        }

        return segments;
    }

    function createGraph() {
        return {
            nodes: new Map(),
            segments: [],
            edgeCount: 0,
        };
    }

    function getOrCreateNode(graph, coord) {
        const key = nodeKey(coord);
        let node = graph.nodes.get(key);
        if (!node) {
            node = { id: key, coord: [coord[0], coord[1]], neighbors: [] };
            graph.nodes.set(key, node);
        }
        return node;
    }

    function addUndirectedEdge(graph, coordA, coordB) {
        if (coordsEqual(coordA, coordB)) return;

        const weight = turf.distance(turf.point(coordA), turf.point(coordB), { units: "meters" });
        if (weight <= DEDUPE_TOLERANCE_METERS) return;

        const nodeA = getOrCreateNode(graph, coordA);
        const nodeB = getOrCreateNode(graph, coordB);

        if (!nodeA.neighbors.some((n) => n.nodeId === nodeB.id)) {
            nodeA.neighbors.push({ nodeId: nodeB.id, weight });
            nodeB.neighbors.push({ nodeId: nodeA.id, weight });
            graph.edgeCount += 1;
        }
    }

    function buildGraphFromOverpass(data) {
        const graph = createGraph();
        const elements = data?.elements || [];

        elements.forEach((element) => {
            if (element.type !== "way") return;

            const segments = wayToSegments(element);
            segments.forEach((segment) => {
                graph.segments.push(segment);
                addUndirectedEdge(graph, segment.coords[0], segment.coords[1]);
            });
        });

        return graph;
    }

    function radiusForPolygon(polygonFeature) {
        const bbox = turf.bbox(polygonFeature);
        const diagonal = turf.distance(turf.point([bbox[0], bbox[1]]), turf.point([bbox[2], bbox[3]]), {
            units: "meters",
        });
        return Math.max(diagonal / 2 + 40, DEFAULT_RADIUS_METERS);
    }

    function cacheKeyForPolygon(polygonFeature) {
        const center = turf.center(polygonFeature).geometry.coordinates;
        const radius = Math.round(radiusForPolygon(polygonFeature));
        return `${center[0].toFixed(5)},${center[1].toFixed(5)}:${radius}`;
    }

    function snapPointToGraph(graph, pointFeature, maxSnapMeters = MAX_SNAP_METERS) {
        if (!graph?.segments?.length) return null;

        let best = null;

        graph.segments.forEach((segment) => {
            const snap = turf.nearestPointOnLine(segment.line, pointFeature, { units: "meters" });
            const dist = snap.properties.dist;
            if (dist > maxSnapMeters) return;

            if (!best || dist < best.distance) {
                best = {
                    distance: dist,
                    coord: snap.geometry.coordinates,
                    segment: segment,
                    location: snap.properties.location,
                };
            }
        });

        if (!best) return null;

        const snapCoord = best.coord;
        const [a, b] = best.segment.coords;

        if (coordsEqual(snapCoord, a)) {
            return { nodeId: nodeKey(a), coord: a, distance: best.distance };
        }
        if (coordsEqual(snapCoord, b)) {
            return { nodeId: nodeKey(b), coord: b, distance: best.distance };
        }

        const snapNode = getOrCreateNode(graph, snapCoord);
        addUndirectedEdge(graph, snapCoord, a);
        addUndirectedEdge(graph, snapCoord, b);

        return { nodeId: snapNode.id, coord: snapCoord, distance: best.distance };
    }

    function dijkstra(graph, startId, endId) {
        if (!graph?.nodes?.size || !startId || !endId) return null;
        if (startId === endId) {
            const node = graph.nodes.get(startId);
            return node ? [node.coord] : null;
        }

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
                if (dist.has(nodeId) && nextDist >= dist.get(nodeId)) return;

                dist.set(nodeId, nextDist);
                prev.set(nodeId, current.id);
                queue.push({ id: nodeId, dist: nextDist });
            });
        }

        if (!prev.has(endId) && startId !== endId) return null;

        const path = [];
        let cursor = endId;
        while (cursor) {
            const node = graph.nodes.get(cursor);
            if (!node) return null;
            path.unshift(node.coord);
            cursor = prev.get(cursor);
        }

        return path.length ? path : null;
    }

    function buildRouteCoords(parkingPoint, entrancePoint, pathCoords, buildingPolygon) {
        if (!pathCoords?.length) return null;

        const parkingCoord = parkingPoint.geometry.coordinates;
        const entranceCoord = entrancePoint.geometry.coordinates;
        let coords = [];

        const pathStart = pathCoords[0];
        const pathEnd = pathCoords[pathCoords.length - 1];

        if (!segmentCrossesPolygonInterior(parkingCoord, pathStart, buildingPolygon)) {
            coords.push(parkingCoord);
        }

        coords = dedupeCoords(coords.concat(pathCoords));

        if (!segmentCrossesPolygonInterior(pathEnd, entranceCoord, buildingPolygon)) {
            coords.push(entranceCoord);
        }

        coords = dedupeCoords(removeCollinearCoords(coords));
        return coords.length >= 2 ? coords : null;
    }

    function routeOnGraph(graph, parkingPoint, entrancePoint, buildingPolygon) {
        const start = snapPointToGraph(graph, parkingPoint);
        const end = snapPointToGraph(graph, entrancePoint);
        if (!start || !end) return null;

        const pathCoords = dijkstra(graph, start.nodeId, end.nodeId);
        if (!pathCoords) return null;

        const coords = buildRouteCoords(parkingPoint, entrancePoint, pathCoords, buildingPolygon);
        if (!coords) return null;

        const line = turf.lineString(coords, { routing: "osm-footway" });
        if (turf.kinks(line).features.length > 0) return null;

        line.properties.lengthMeters = turf.length(line, { units: "meters" });
        return line;
    }

    async function loadNetwork(buildingPolygon) {
        if (!turf) throw new Error("TupTupOsmFootwayRouting wymaga Turf.js");

        const polygon =
            buildingPolygon.type === "Feature"
                ? buildingPolygon
                : turf.feature(buildingPolygon);

        const key = cacheKeyForPolygon(polygon);
        if (networkCache.has(key)) {
            return networkCache.get(key);
        }

        const center = turf.center(polygon).geometry.coordinates;
        const [lng, lat] = center;
        const radius = radiusForPolygon(polygon);
        const query = buildFootwaysOverpassQuery(lat, lng, radius);
        const data = await postOverpass(query);
        const graph = buildGraphFromOverpass(data);

        networkCache.set(key, graph);
        return graph;
    }

    function createPlugin(options = {}) {
        const getGraph = options.getGraph || (() => null);

        return {
            canRoute(ctx) {
                const graph = ctx.footwayGraph || getGraph();
                return Boolean(graph?.edgeCount);
            },

            route(ctx) {
                const graph = ctx.footwayGraph || getGraph();
                if (!graph?.edgeCount) return null;

                return routeOnGraph(
                    graph,
                    ctx.parkingPoint,
                    ctx.entrancePoint,
                    ctx.buildingPolygon
                );
            },
        };
    }

    global.TupTupOsmFootwayRouting = {
        DEFAULT_RADIUS_METERS,
        MAX_SNAP_METERS,
        loadNetwork,
        createPlugin,
        buildGraphFromOverpass,
        routeOnGraph,
        snapPointToGraph,
        clearCache() {
            networkCache.clear();
        },
    };
})(typeof window !== "undefined" ? window : globalThis);
