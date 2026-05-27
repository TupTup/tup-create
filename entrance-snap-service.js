/**
 * EntranceSnapService – snap punktu wejścia do obrysu budynku i węzłów OSM entrance=*.
 */
(function (global) {
    const turf = global.turf;
    if (!turf) {
        console.warn("[EntranceSnapService] Brak Turf.js – snap wejścia niedostępny.");
    }

    function EntranceSnapService(options = {}) {
        this.snapMeters = options.snapMeters ?? 12;
        this.detachMeters = options.detachMeters ?? 26;
    }

    function closeRing(coords) {
        if (!coords.length) return coords;
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) return coords;
        return [...coords, first];
    }

    function toPoint(latlng) {
        return turf.point([latlng.lng, latlng.lat]);
    }

    function fromPointFeature(feature) {
        const [lng, lat] = feature.geometry.coordinates;
        return { lat, lng };
    }

    function buildingPolygonFromOutline(outline) {
        const ring = closeRing(outline.map(([lat, lng]) => [lng, lat]));
        return turf.polygon([ring]);
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

        throw new Error("EntranceSnapService: nie udało się przekonwertować polygonu na linię");
    }

    EntranceSnapService.prototype.snapToOutline = function snapToOutline(latlng, buildingOutline) {
        if (!turf) {
            throw new Error("EntranceSnapService wymaga Turf.js");
        }
        if (!buildingOutline?.length) return latlng;

        const polygon = buildingPolygonFromOutline(buildingOutline);
        const outline = outlineLineFromPolygon(polygon);
        const snapped = turf.nearestPointOnLine(outline, toPoint(latlng), { units: "meters" });
        return fromPointFeature(snapped);
    };

    EntranceSnapService.prototype.findNearestOsmEntrance = function findNearestOsmEntrance(
        latlng,
        entrances
    ) {
        if (!turf) {
            throw new Error("EntranceSnapService wymaga Turf.js");
        }
        if (!entrances?.length) return null;

        const target = toPoint(latlng);
        const collection = turf.featureCollection(
            entrances.map((entrance) =>
                turf.point([entrance.lng, entrance.lat], {
                    id: entrance.id,
                    lat: entrance.lat,
                    lng: entrance.lng,
                    entrance: entrance.entrance,
                })
            )
        );

        const nearest = turf.nearestPoint(target, collection);
        const distance = turf.distance(target, nearest, { units: "meters" });
        const props = nearest.properties;

        return {
            entrance: {
                id: props.id,
                lat: props.lat,
                lng: props.lng,
                entrance: props.entrance,
            },
            distance,
        };
    };

    EntranceSnapService.prototype.resolveDragPosition = function resolveDragPosition(ctx) {
        if (!turf) {
            throw new Error("EntranceSnapService wymaga Turf.js");
        }

        const latlng = ctx.latlng;
        const buildingOutline = ctx.buildingOutline;
        const entrances = ctx.osmEntrances;
        let detached = ctx.detached;
        let selectedOsmEntranceId = ctx.selectedOsmEntranceId;

        const nearest = this.findNearestOsmEntrance(latlng, entrances);

        if (nearest && nearest.distance <= this.snapMeters) {
            const snapped = this.snapToOutline(nearest.entrance, buildingOutline);
            return {
                lat: snapped.lat,
                lng: snapped.lng,
                mode: "osm",
                selectedOsmEntranceId: nearest.entrance.id,
                detached: false,
            };
        }

        if (!detached) {
            let reference = null;
            if (selectedOsmEntranceId && entrances?.length) {
                reference =
                    entrances.find((entrance) => entrance.id === selectedOsmEntranceId) || null;
            }
            if (!reference && nearest) reference = nearest.entrance;

            if (reference) {
                const refDist = turf.distance(toPoint(latlng), toPoint(reference), {
                    units: "meters",
                });
                if (refDist > this.detachMeters) {
                    detached = true;
                    selectedOsmEntranceId = null;
                }
            }
        }

        const snapped = this.snapToOutline(latlng, buildingOutline);
        if (detached) {
            selectedOsmEntranceId = null;
        }

        return {
            lat: snapped.lat,
            lng: snapped.lng,
            mode: "outline",
            selectedOsmEntranceId,
            detached,
        };
    };

    global.TupTupEntranceSnap = {
        EntranceSnapService,
        create(options) {
            return new EntranceSnapService(options);
        },
    };
})(typeof window !== "undefined" ? window : globalThis);
