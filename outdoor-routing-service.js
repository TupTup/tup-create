/**
 * OutdoorRoutingService – routing outdoor parking → wejście wokół budynku z buforem.
 *
 * Rozszerzalność: przekaż `plugins` w konstruktorze – każdy plugin może obsłużyć
 * kontekst (np. chodniki OSM, waypointy, korytarze indoor, centerline) zanim
 * zadziała domyślna logika obejścia polygonu.
 */
(function (global) {
    const turf = global.turf;
    if (!turf) {
        console.warn("[OutdoorRoutingService] Brak Turf.js – routing outdoor niedostępny.");
    }

    const DEFAULT_BUFFER_METERS = 4;
    const BUFFER_STEPS = 4;
    const DEDUPE_TOLERANCE_METERS = 0.05;

    function OutdoorRoutingService(options = {}) {
        this._plugins = options.plugins || [];
        this._bufferMeters = options.bufferMeters ?? DEFAULT_BUFFER_METERS;
    }

    OutdoorRoutingService.prototype.route = function route(input) {
        if (!turf) {
            throw new Error("OutdoorRoutingService wymaga Turf.js");
        }

        const ctx = normalizeContext(input, this._bufferMeters);

        for (let i = 0; i < this._plugins.length; i++) {
            const plugin = this._plugins[i];
            if (typeof plugin.canRoute === "function" && plugin.canRoute(ctx)) {
                return plugin.route(ctx);
            }
        }

        return routeAroundBuildingMain(ctx);
    };

    function normalizeContext(input, defaultBufferMeters) {
        const bufferMeters =
            typeof input.bufferMeters === "number" ? input.bufferMeters : defaultBufferMeters;

        return {
            parkingPoint: toPointFeature(input.parkingPoint, "parkingPoint"),
            entrancePoint: toPointFeature(input.entrancePoint, "entrancePoint"),
            buildingPolygon: toPolygonFeature(input.buildingPolygon, "buildingPolygon"),
            bufferMeters,
        };
    }

    function toPointFeature(value, label) {
        if (!value) {
            throw new Error(`OutdoorRoutingService: brak ${label}`);
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

        throw new Error(`OutdoorRoutingService: nieobsługiwany format ${label}`);
    }

    function toPolygonFeature(value, label) {
        if (!value) {
            throw new Error(`OutdoorRoutingService: brak ${label}`);
        }

        if (value.type === "Feature") {
            if (value.geometry?.type === "Polygon") return value;
            throw new Error(`OutdoorRoutingService: ${label} musi być Polygonem`);
        }

        if (value.type === "Polygon") {
            return turf.feature(value);
        }

        throw new Error(`OutdoorRoutingService: nieobsługiwany format ${label}`);
    }

    function getOuterRing(polygonFeature) {
        const ring = polygonFeature.geometry.coordinates[0];
        if (!ring?.length) return [];

        const last = ring[ring.length - 1];
        const first = ring[0];
        if (last[0] === first[0] && last[1] === first[1]) {
            return ring.slice(0, -1);
        }
        return ring.slice();
    }

    function outlineLineFromPolygon(polygonFeature) {
        const outline = turf.polygonToLine(polygonFeature);
        if (outline.geometry.type === "LineString") {
            return outline;
        }

        if (outline.geometry.type === "MultiLineString") {
            const lines = outline.geometry.coordinates.map((coords) => turf.lineString(coords));
            lines.sort(
                (a, b) => turf.length(b, { units: "meters" }) - turf.length(a, { units: "meters" })
            );
            return lines[0];
        }

        throw new Error("OutdoorRoutingService: nie udało się przekonwertować polygonu na linię");
    }

    function buildBufferedPolygon(buildingPolygon, bufferMeters) {
        if (bufferMeters <= 0) {
            return buildingPolygon;
        }

        return turf.buffer(buildingPolygon, bufferMeters, {
            units: "meters",
            steps: BUFFER_STEPS,
        });
    }

    function buildCornerDistances(ring) {
        const corners = [];
        let dist = 0;

        for (let i = 0; i < ring.length; i++) {
            corners.push({ coord: ring[i], dist });
            const next = ring[(i + 1) % ring.length];
            dist += turf.distance(turf.point(ring[i]), turf.point(next), { units: "meters" });
        }

        return corners;
    }

    function collectCornersBetween(fromLoc, toLoc, cornerDists, clockwise) {
        const points = [];

        if (clockwise) {
            if (fromLoc <= toLoc) {
                cornerDists.forEach(({ coord, dist }) => {
                    if (dist > fromLoc && dist <= toLoc) points.push(coord);
                });
            } else {
                cornerDists.forEach(({ coord, dist }) => {
                    if (dist > fromLoc || dist <= toLoc) points.push(coord);
                });
            }
            return points;
        }

        if (fromLoc >= toLoc) {
            for (let i = cornerDists.length - 1; i >= 0; i--) {
                const { coord, dist } = cornerDists[i];
                if (dist < fromLoc && dist >= toLoc) points.push(coord);
            }
        } else {
            for (let i = cornerDists.length - 1; i >= 0; i--) {
                const { coord, dist } = cornerDists[i];
                if (dist < fromLoc || dist >= toLoc) points.push(coord);
            }
        }

        return points;
    }

    function dedupeCoords(coords, toleranceMeters = DEDUPE_TOLERANCE_METERS) {
        const out = [];

        coords.forEach((coord) => {
            if (!out.length) {
                out.push(coord);
                return;
            }
            const prev = out[out.length - 1];
            if (turf.distance(turf.point(prev), turf.point(coord), { units: "meters" }) > toleranceMeters) {
                out.push(coord);
            }
        });

        return out;
    }

    function buildPerimeterPath(parking, entrance, ring, parkingSnap, entranceSnap, clockwise) {
        const locA = parkingSnap.properties.location;
        const locB = entranceSnap.properties.location;
        const coordA = parkingSnap.geometry.coordinates;
        const coordB = entranceSnap.geometry.coordinates;
        const corners = buildCornerDistances(ring);
        const mid = collectCornersBetween(locA, locB, corners, clockwise);

        const coords = dedupeCoords([
            parking.geometry.coordinates,
            coordA,
            ...mid,
            coordB,
            entrance.geometry.coordinates,
        ]);

        return turf.lineString(coords, {
            direction: clockwise ? "clockwise" : "counterclockwise",
        });
    }

    function directLine(from, to) {
        return turf.lineString([from.geometry.coordinates, to.geometry.coordinates], {
            routing: "direct",
        });
    }

    function routeAroundBuilding(ctx) {
        const { parkingPoint, entrancePoint, buildingPolygon, bufferMeters } = ctx;
        const bufferedPolygon = buildBufferedPolygon(buildingPolygon, bufferMeters);
        const ring = getOuterRing(bufferedPolygon);

        if (ring.length < 3) {
            return directLine(parkingPoint, entrancePoint);
        }

        const outline = outlineLineFromPolygon(bufferedPolygon);
        const parkingSnap = turf.nearestPointOnLine(outline, parkingPoint, { units: "meters" });
        const entranceSnap = turf.nearestPointOnLine(outline, entrancePoint, { units: "meters" });

        const pathCw = buildPerimeterPath(
            parkingPoint,
            entrancePoint,
            ring,
            parkingSnap,
            entranceSnap,
            true
        );
        const pathCcw = buildPerimeterPath(
            parkingPoint,
            entrancePoint,
            ring,
            parkingSnap,
            entranceSnap,
            false
        );

        const lenCw = turf.length(pathCw, { units: "meters" });
        const lenCcw = turf.length(pathCcw, { units: "meters" });

        const chosen = lenCw <= lenCcw ? pathCw : pathCcw;
        chosen.properties = {
            ...(chosen.properties || {}),
            routing: "perimeter-buffer",
            bufferMeters,
            lengthMeters: Math.min(lenCw, lenCcw),
        };

        return chosen;
    }

    function routeAroundBuildingMain(ctx) {
        const direct = directLine(ctx.parkingPoint, ctx.entrancePoint);

        if (!turf.booleanIntersects(direct, ctx.buildingPolygon)) {
            return direct;
        }

        return routeAroundBuilding(ctx);
    }

    global.TupTupOutdoorRouting = {
        DEFAULT_BUFFER_METERS,
        OutdoorRoutingService,
        route: function route(input) {
            return new OutdoorRoutingService().route(input);
        },
    };
})(typeof window !== "undefined" ? window : globalThis);
