/**
 * SyntheticIndoorCorridorService – heurystyczne prowadzenie indoor.
 *
 * Wejście: buildingPolygon + entrancePoint + destinationPoint.
 * Routing: linia prosta wejście → cel, z walidacją wewnątrz polygonu budynku.
 * Inset polygon (bufor wewnętrzny) służy wyłącznie wizualizacji strefy korytarza na mapie.
 */
(function (global) {
    const turf = global.turf;
    if (!turf) {
        console.warn("[SyntheticIndoorCorridorService] Brak Turf.js – moduł niedostępny.");
    }

    const DEFAULT_WALL_MARGIN_METERS = 3;
    const MIN_WALL_MARGIN_METERS = 0.55;
    const BUFFER_STEPS = 4;
    const DEDUPE_TOLERANCE_METERS = 0.05;

    function assertTurf() {
        if (!turf) {
            throw new Error("SyntheticIndoorCorridorService wymaga Turf.js");
        }
    }

    function SyntheticIndoorCorridorService(options = {}) {
        this._wallMarginMeters = options.wallMarginMeters ?? DEFAULT_WALL_MARGIN_METERS;
    }

    SyntheticIndoorCorridorService.prototype.route = function route(input) {
        assertTurf();

        const buildingPolygon = toPolygonFeature(input.buildingPolygon, "buildingPolygon");
        const entrance = toPointFeature(input.entrancePoint, "entrancePoint").geometry.coordinates;
        const destination = toPointFeature(input.destinationPoint, "destinationPoint").geometry.coordinates;
        const coords = ensurePathInsideBuilding(dedupeCoords([entrance, destination]), buildingPolygon);
        const line = turf.lineString(coords, {
            routing: "synthetic-indoor-corridor",
            lengthMeters: turf.length(turf.lineString(coords), { units: "meters" }),
        });

        return line;
    };

    SyntheticIndoorCorridorService.prototype.generateInsetPolygon = function generateInsetPolygon(input) {
        assertTurf();

        const buildingPolygon = toPolygonFeature(input.buildingPolygon, "buildingPolygon");
        const wallMarginMeters =
            typeof input.wallMarginMeters === "number" ? input.wallMarginMeters : this._wallMarginMeters;
        return buildInsetPolygon(buildingPolygon, wallMarginMeters);
    };

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

    function insetPolygonOutlineFeature(insetPolygon, properties = {}) {
        const outline = turf.polygonToLine(insetPolygon);
        outline.properties = {
            source: "inset-polygon",
            ...(outline.properties || {}),
            ...properties,
        };
        return outline;
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

    global.TupTupSyntheticIndoorCorridor = {
        DEFAULT_WALL_MARGIN_METERS,
        SyntheticIndoorCorridorService,
        insetPolygonOutlineFeature,
    };
})(typeof window !== "undefined" ? window : globalThis);
