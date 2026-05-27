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
    const MIN_TURN_DEGREES = 10;

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
                const result = plugin.route(ctx);
                if (result) return result;
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
            footwayGraph: input.footwayGraph || null,
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

    function mergeCoords(first, second) {
        if (!first.length) return second.slice();
        if (!second.length) return first.slice();

        const out = first.slice();
        const last = out[out.length - 1];
        const start = turf.distance(turf.point(last), turf.point(second[0]), { units: "meters" })
            <= DEDUPE_TOLERANCE_METERS
            ? 1
            : 0;

        for (let i = start; i < second.length; i++) {
            out.push(second[i]);
        }
        return out;
    }

    function sliceOutlineForward(outline, fromLoc, toLoc, perimeter) {
        if (fromLoc <= toLoc) {
            return turf.lineSliceAlong(outline, fromLoc, toLoc, { units: "meters" }).geometry.coordinates;
        }

        const part1 = turf.lineSliceAlong(outline, fromLoc, perimeter, { units: "meters" }).geometry
            .coordinates;
        const part2 = turf.lineSliceAlong(outline, 0, toLoc, { units: "meters" }).geometry.coordinates;
        return mergeCoords(part1, part2);
    }

    function extractOutlineArc(outline, startLoc, endLoc, clockwise) {
        const perimeter = turf.length(outline, { units: "meters" });

        if (clockwise) {
            return sliceOutlineForward(outline, startLoc, endLoc, perimeter);
        }

        const reverseArc = sliceOutlineForward(outline, endLoc, startLoc, perimeter);
        return reverseArc.slice().reverse();
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

    function segmentCrossesPolygonInterior(from, to, polygon) {
        const line = turf.lineString([from, to]);
        const length = turf.length(line, { units: "meters" });
        if (length <= DEDUPE_TOLERANCE_METERS) return false;

        const mid = turf.along(line, length / 2, { units: "meters" });
        return turf.booleanPointInPolygon(mid, polygon, { ignoreBoundary: true });
    }

    function segmentCrossesPolyline(from, to, polylineCoords) {
        if (!polylineCoords?.length) return false;

        const connector = turf.lineString([from, to]);
        const polyline = turf.lineString(polylineCoords);
        const hits = turf.lineIntersect(connector, polyline);

        return hits.features.some((feature) => {
            const hit = feature.geometry.coordinates;
            return (
                turf.distance(turf.point(hit), turf.point(from), { units: "meters" }) >
                    DEDUPE_TOLERANCE_METERS &&
                turf.distance(turf.point(hit), turf.point(to), { units: "meters" }) >
                    DEDUPE_TOLERANCE_METERS
            );
        });
    }

    function hasSelfIntersection(line) {
        return turf.kinks(line).features.length > 0;
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

    function buildPathCoords(parking, entrance, arcCoords, buildingPolygon) {
        let coords = [];

        const arcStart = arcCoords[0];
        const arcEnd = arcCoords[arcCoords.length - 1];
        const parkingCoord = parking.geometry.coordinates;
        const entranceCoord = entrance.geometry.coordinates;

        if (
            arcStart &&
            !segmentCrossesPolygonInterior(parkingCoord, arcStart, buildingPolygon) &&
            !segmentCrossesPolyline(parkingCoord, arcStart, arcCoords)
        ) {
            coords.push(parkingCoord);
        }

        coords = mergeCoords(coords, arcCoords);

        if (
            arcEnd &&
            !segmentCrossesPolygonInterior(arcEnd, entranceCoord, buildingPolygon) &&
            !segmentCrossesPolyline(arcEnd, entranceCoord, arcCoords)
        ) {
            coords.push(entranceCoord);
        }

        coords = dedupeCoords(coords);
        coords = removeCollinearCoords(coords);
        return coords;
    }

    function buildPerimeterPath(parking, entrance, outline, parkingSnap, entranceSnap, buildingPolygon, clockwise) {
        const locA = parkingSnap.properties.location;
        const locB = entranceSnap.properties.location;
        const arcCoords = extractOutlineArc(outline, locA, locB, clockwise);
        const coords = buildPathCoords(parking, entrance, arcCoords, buildingPolygon);

        return turf.lineString(coords, {
            direction: clockwise ? "clockwise" : "counterclockwise",
        });
    }

    function choosePerimeterPath(parking, entrance, outline, parkingSnap, entranceSnap, buildingPolygon) {
        const pathCw = buildPerimeterPath(
            parking,
            entrance,
            outline,
            parkingSnap,
            entranceSnap,
            buildingPolygon,
            true
        );
        const pathCcw = buildPerimeterPath(
            parking,
            entrance,
            outline,
            parkingSnap,
            entranceSnap,
            buildingPolygon,
            false
        );

        const candidates = [pathCw, pathCcw].sort(
            (a, b) => turf.length(a, { units: "meters" }) - turf.length(b, { units: "meters" })
        );

        for (let i = 0; i < candidates.length; i++) {
            if (!hasSelfIntersection(candidates[i])) {
                return candidates[i];
            }
        }

        const arcOnlyCw = extractOutlineArc(
            outline,
            parkingSnap.properties.location,
            entranceSnap.properties.location,
            true
        );
        const arcOnlyCcw = extractOutlineArc(
            outline,
            parkingSnap.properties.location,
            entranceSnap.properties.location,
            false
        );
        const fallbackCoords = dedupeCoords(
            turf.length(turf.lineString(arcOnlyCw), { units: "meters" }) <=
                turf.length(turf.lineString(arcOnlyCcw), { units: "meters" })
                ? arcOnlyCw
                : arcOnlyCcw
        );

        return turf.lineString(removeCollinearCoords(dedupeCoords(fallbackCoords)), {
            direction: "fallback-arc",
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
        const outline = outlineLineFromPolygon(bufferedPolygon);

        if (!outline.geometry.coordinates?.length) {
            return directLine(parkingPoint, entrancePoint);
        }

        const parkingSnap = turf.nearestPointOnLine(outline, parkingPoint, { units: "meters" });
        const entranceSnap = turf.nearestPointOnLine(outline, entrancePoint, { units: "meters" });

        const chosen = choosePerimeterPath(
            parkingPoint,
            entrancePoint,
            outline,
            parkingSnap,
            entranceSnap,
            buildingPolygon
        );

        chosen.properties = {
            ...(chosen.properties || {}),
            routing: "perimeter-buffer",
            bufferMeters,
            lengthMeters: turf.length(chosen, { units: "meters" }),
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
