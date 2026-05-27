(function () {
    const mapArea = document.querySelector(".map-area");
    const mapCanvas = document.querySelector(".map-canvas");
    if (!mapArea || !mapCanvas || typeof maplibregl === "undefined") return;
    if (mapArea.dataset.mapMode !== "all") return;

    const outlineApi = window.TupTupBuildingOutline;
    const MAP_FALLBACK_CENTER = [52.2297, 21.0122];
    const MAP_FALLBACK_ZOOM = 16;

    let buildingOutline = [];
    const points = {
        parking: null,
        entrance: null,
        delivery: null,
    };
    let markersInitialized = false;
    let wizardStarted = false;
    let mapStarted = false;
    let pendingBuilding = null;
    let buildingOsm = null;
    let outlineLoading = Boolean(outlineApi?.parseOsmFromPage?.());
    let resizeLayoutTimer = null;

    let osmEntrancesCache = null;
    let osmEntrancesCacheKey = null;
    let osmEntrancesLoading = false;
    let selectedOsmEntranceId = null;
    let entranceSnapDetached = false;

    const ENTRANCE_SNAP_METERS = 12;
    const ENTRANCE_DETACH_METERS = 26;

    const markers = {};
    const routeLines = {};
    let wizardStep = "parking";

    const wizardConfig = {
        parking: {
            markers: ["parking"],
            routes: [],
            draggable: ["parking"],
            active: "parking",
        },
        entrance: {
            markers: ["parking", "entrance"],
            routes: ["parking-entrance"],
            draggable: ["entrance"],
            active: "entrance",
        },
        destination: {
            markers: ["parking", "entrance", "delivery"],
            routes: ["parking-entrance", "entrance-delivery"],
            draggable: ["delivery"],
            active: "delivery",
        },
        print: {
            markers: ["parking", "entrance", "delivery"],
            routes: ["parking-entrance", "entrance-delivery"],
            draggable: [],
            active: null,
        },
    };

    const BUILDING_FILL_MAX_ZOOM = 22;
    const BUILDING_FILL_INSET = 0.88;
    const PARKING_MAX_ZOOM = 19;

    let buildingBounds = null;
    const lastValidDrag = {};
    function latLng(lat, lng) {
        return { lat, lng };
    }

    function latLngFromCoords(coords) {
        return latLng(coords[0], coords[1]);
    }

    function toLngLat(coords) {
        return [coords[1], coords[0]];
    }

    function distanceMeters(a, b) {
        const R = 6371000;
        const dLat = ((b.lat - a.lat) * Math.PI) / 180;
        const dLng = ((b.lng - a.lng) * Math.PI) / 180;
        const lat1 = (a.lat * Math.PI) / 180;
        const lat2 = (b.lat * Math.PI) / 180;
        const x =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(x));
    }

    function latLngBoundsFromCoords(coords) {
        const bounds = new maplibregl.LngLatBounds();
        coords.forEach(([lat, lng]) => bounds.extend([lng, lat]));
        return {
            isValid() {
                return !bounds.isEmpty();
            },
            getCenter() {
                const center = bounds.getCenter();
                return latLng(center.lat, center.lng);
            },
            getNorth() {
                return bounds.getNorth();
            },
            getSouth() {
                return bounds.getSouth();
            },
            getEast() {
                return bounds.getEast();
            },
            getWest() {
                return bounds.getWest();
            },
            toMapBounds() {
                return bounds;
            },
        };
    }

    function closeRing(coords) {
        if (!coords.length) return coords;
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) return coords;
        return [...coords, first];
    }

    function buildingPolygonGeoJson(outline) {
        const ring = closeRing(outline.map(([lat, lng]) => [lng, lat]));
        return {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [ring],
            },
        };
    }

    function emptyFeatureCollection() {
        return { type: "FeatureCollection", features: [] };
    }

    const map = new maplibregl.Map({
        container: mapCanvas,
        style: {
            version: 8,
            sources: {
                osm: {
                    type: "raster",
                    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    maxzoom: 19,
                    attribution:
                        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                },
                building: {
                    type: "geojson",
                    data: emptyFeatureCollection(),
                },
                routes: {
                    type: "geojson",
                    data: emptyFeatureCollection(),
                },
                "osm-entrances": {
                    type: "geojson",
                    data: emptyFeatureCollection(),
                },
                "user-location": {
                    type: "geojson",
                    data: emptyFeatureCollection(),
                },
            },
            layers: [
                {
                    id: "osm-tiles",
                    type: "raster",
                    source: "osm",
                    maxzoom: BUILDING_FILL_MAX_ZOOM,
                },
                {
                    id: "building-fill",
                    type: "fill",
                    source: "building",
                    paint: {
                        "fill-color": "#ffffff",
                        "fill-opacity": 0.72,
                    },
                },
                {
                    id: "building-outline",
                    type: "line",
                    source: "building",
                    paint: {
                        "line-color": "#111111",
                        "line-width": 3,
                    },
                },
                {
                    id: "routes",
                    type: "line",
                    source: "routes",
                    paint: {
                        "line-color": "#111111",
                        "line-width": 3,
                        "line-dasharray": [2, 2],
                    },
                    layout: {
                        "line-cap": "round",
                    },
                },
                {
                    id: "osm-entrances",
                    type: "circle",
                    source: "osm-entrances",
                    paint: {
                        "circle-radius": ["case", ["get", "selected"], 10, 8],
                        "circle-color": [
                            "case",
                            ["get", "selected"],
                            "#111111",
                            "#ffffff",
                        ],
                        "circle-stroke-color": "#111111",
                        "circle-stroke-width": ["case", ["get", "selected"], 3, 2],
                    },
                },
                {
                    id: "user-location",
                    type: "circle",
                    source: "user-location",
                    paint: {
                        "circle-radius": 7,
                        "circle-color": "#ffffff",
                        "circle-stroke-color": "#111111",
                        "circle-stroke-width": 2,
                    },
                },
            ],
        },
        center: toLngLat(MAP_FALLBACK_CENTER),
        zoom: MAP_FALLBACK_ZOOM,
        maxZoom: BUILDING_FILL_MAX_ZOOM,
        attributionControl: true,
    });

    function markerOnMap(marker) {
        return Boolean(marker._map);
    }

    function getMarkerLatLng(marker) {
        const { lat, lng } = marker.getLngLat();
        return latLng(lat, lng);
    }

    function setMarkerLatLng(marker, coords) {
        const point = Array.isArray(coords) ? latLngFromCoords(coords) : coords;
        marker.setLngLat([point.lng, point.lat]);
    }

    function hasBuilding() {
        return buildingOutline.length >= 3 && buildingBounds?.isValid();
    }

    function awaitingBuilding() {
        return Boolean(pendingBuilding) || outlineLoading;
    }

    function updateBuildingSource() {
        const source = map.getSource("building");
        if (!source || !buildingOutline.length) return;
        source.setData(buildingPolygonGeoJson(buildingOutline));
    }

    function updateRoutesSource(visibleRouteIds = null) {
        const source = map.getSource("routes");
        if (!source) return;

        const features = Object.entries(routeLines)
            .filter(([id]) => !visibleRouteIds || visibleRouteIds.includes(id))
            .map(([id, route]) => {
                const from = getLatLng(route.tuptupFrom);
                const to = getLatLng(route.tuptupTo);
                return {
                    type: "Feature",
                    properties: { id },
                    geometry: {
                        type: "LineString",
                        coordinates: [
                            [from.lng, from.lat],
                            [to.lng, to.lat],
                        ],
                    },
                };
            });

        source.setData({ type: "FeatureCollection", features });
    }

    function defaultPointsForOutline(outline) {
        const bounds = latLngBoundsFromCoords(outline);
        const center = bounds.getCenter();

        let entrance = latLngFromCoords(outline[0]);
        let longest = -1;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
            const [lat1, lng1] = outline[j];
            const [lat2, lng2] = outline[i];
            const a = latLng(lat1, lng1);
            const b = latLng(lat2, lng2);
            const len = distanceMeters(a, b);
            if (len > longest) {
                longest = len;
                entrance = latLng((lat1 + lat2) / 2, (lng1 + lng2) / 2);
            }
        }
        entrance = closestPointOnBuildingOutline(entrance);

        const c = bounds.getCenter();
        const dLat = entrance.lat - c.lat;
        const dLng = entrance.lng - c.lng;
        const len = Math.hypot(dLat, dLng) || 1e-9;
        let parking = latLng(
            entrance.lat + (dLat / len) * 0.00022,
            entrance.lng + (dLng / len) * 0.00022
        );
        parking = pushOutsideBuilding(parking);

        let delivery = center;
        if (!pointInBuilding(delivery)) {
            delivery = latLng(
                entrance.lat + (c.lat - entrance.lat) * 0.45,
                entrance.lng + (c.lng - entrance.lng) * 0.45
            );
        }
        if (!pointInBuilding(delivery)) {
            delivery = latLng(
                (bounds.getNorth() + bounds.getSouth()) / 2,
                (bounds.getEast() + bounds.getWest()) / 2
            );
        }

        return {
            parking: [parking.lat, parking.lng],
            entrance: [entrance.lat, entrance.lng],
            delivery: [delivery.lat, delivery.lng],
        };
    }

    function repositionMarkersForBuilding() {
        const defaults = defaultPointsForOutline(buildingOutline);
        Object.entries(defaults).forEach(([key, coords]) => {
            points[key] = coords;
            const marker = markers[key];
            if (!marker) return;
            setMarkerLatLng(marker, coords);
            lastValidDrag[key] = getMarkerLatLng(marker);
        });
        updateRoutes();
        syncCoords();
    }

    function applyBuildingOutline(outline) {
        if (!outline?.length) return;
        buildingOutline = outline;
        buildingBounds = latLngBoundsFromCoords(buildingOutline);
        updateBuildingSource();
        if (buildingBounds?.isValid()) {
            map.fitBounds(buildingBounds.toMapBounds(), {
                padding: 20,
                maxZoom: PARKING_MAX_ZOOM,
                animate: false,
            });
        }
        repositionMarkersForBuilding();
        if (!markersInitialized) {
            initMarkersAndRoutes();
            markersInitialized = true;
        }
        ensureWizardStarted();
        scheduleMapLayoutRetries();
    }

    function scheduleMapLayoutRetries() {
        refreshMapLayout();
        requestAnimationFrame(refreshMapLayout);
        [120, 400, 800, 1500].forEach((ms) => setTimeout(refreshMapLayout, ms));
    }

    function ensureWizardStarted() {
        if (wizardStarted || !markersInitialized) return;
        wizardStarted = true;
        applyWizardStep("parking");
    }

    function createMarkerElement(type, label, active) {
        const host = document.createElement("div");
        host.className = "map-marker-host";
        const activeClass = active ? " map-marker--active" : "";
        host.innerHTML = `<div class="map-marker map-marker--${type} map-marker--draggable${activeClass}" role="img" aria-label="${label}">${label === "entry" ? "" : label}</div>`;
        return host;
    }

    function updateMarkerAppearance(marker, type, label, active) {
        const el = marker.getElement()?.querySelector(".map-marker");
        if (!el) return;
        el.className = `map-marker map-marker--${type} map-marker--draggable${active ? " map-marker--active" : ""}`;
        el.setAttribute("aria-label", label);
        el.textContent = label === "entry" ? "" : label;
    }

    function getLatLng(key) {
        if (markers[key]) {
            const point = getMarkerLatLng(markers[key]);
            points[key] = [point.lat, point.lng];
            return point;
        }
        if (points[key]) return latLngFromCoords(points[key]);
        return hasBuilding()
            ? buildingBounds.getCenter()
            : latLngFromCoords(MAP_FALLBACK_CENTER);
    }

    function syncCoords() {
        document.dispatchEvent(
            new CustomEvent("tuptup:coords", {
                detail: {
                    parking: [...points.parking],
                    entrance: [...points.entrance],
                    delivery: [...points.delivery],
                },
            })
        );
    }

    function updateRoutes() {
        const config = wizardConfig[wizardStep];
        updateRoutesSource(config?.routes || Object.keys(routeLines));
        syncCoords();
    }

    function addMarker(key, type, label) {
        const element = createMarkerElement(type, label, false);
        const marker = new maplibregl.Marker({
            element,
            anchor: "bottom",
            draggable: true,
            pitchAlignment: "map",
            rotationAlignment: "map",
        })
            .setLngLat(toLngLat(points[key]))
            .addTo(map);

        markers[key] = marker;
        return marker;
    }

    function addRoute(id, from, to) {
        routeLines[id] = { tuptupFrom: from, tuptupTo: to };
    }

    function isBuildingFillStep() {
        return wizardStep === "entrance" || wizardStep === "destination";
    }

    function pointInBuilding(latlng) {
        if (!hasBuilding()) return false;
        const x = latlng.lng;
        const y = latlng.lat;
        let inside = false;

        for (let i = 0, j = buildingOutline.length - 1; i < buildingOutline.length; j = i++) {
            const yi = buildingOutline[i][0];
            const xi = buildingOutline[i][1];
            const yj = buildingOutline[j][0];
            const xj = buildingOutline[j][1];
            const intersect =
                yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
            if (intersect) inside = !inside;
        }

        return inside;
    }

    function closestPointOnSegment(lat, lng, lat1, lng1, lat2, lng2) {
        const dx = lng2 - lng1;
        const dy = lat2 - lat1;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq === 0) return latLng(lat1, lng1);

        let t = ((lng - lng1) * dx + (lat - lat1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return latLng(lat1 + t * dy, lng1 + t * dx);
    }

    function closestPointOnBuildingOutline(latlng) {
        if (!hasBuilding()) return latlng;
        let best = latLngFromCoords(buildingOutline[0]);
        let bestDist = Infinity;

        for (let i = 0, j = buildingOutline.length - 1; i < buildingOutline.length; j = i++) {
            const [lat1, lng1] = buildingOutline[j];
            const [lat2, lng2] = buildingOutline[i];
            const candidate = closestPointOnSegment(
                latlng.lat,
                latlng.lng,
                lat1,
                lng1,
                lat2,
                lng2
            );
            const dist = distanceMeters(candidate, latlng);
            if (dist < bestDist) {
                bestDist = dist;
                best = candidate;
            }
        }

        return best;
    }

    function pushOutsideBuilding(latlng) {
        if (!pointInBuilding(latlng)) return latlng;

        const center = buildingBounds.getCenter();
        const onOutline = closestPointOnBuildingOutline(latlng);
        const dLat = onOutline.lat - center.lat;
        const dLng = onOutline.lng - center.lng;
        const len = Math.hypot(dLat, dLng) || 1e-9;
        let margin = 0.00012;

        let candidate = latLng(
            onOutline.lat + (dLat / len) * margin,
            onOutline.lng + (dLng / len) * margin
        );

        for (let attempt = 0; pointInBuilding(candidate) && attempt < 8; attempt++) {
            margin *= 1.5;
            candidate = latLng(
                onOutline.lat + (dLat / len) * margin,
                onOutline.lng + (dLng / len) * margin
            );
        }

        return candidate;
    }

    function snapEntranceToOutline(marker) {
        const snapped = closestPointOnBuildingOutline(getMarkerLatLng(marker));
        setMarkerLatLng(marker, snapped);
        points.entrance = [snapped.lat, snapped.lng];
        lastValidDrag.entrance = snapped;
        return snapped;
    }

    function setEntranceFromLatLng(lat, lng) {
        if (!markers.entrance) return;
        const snapped = closestPointOnBuildingOutline(latLng(lat, lng));
        setMarkerLatLng(markers.entrance, snapped);
        points.entrance = [snapped.lat, snapped.lng];
        lastValidDrag.entrance = snapped;
        updateRoutes();
    }

    function nearestOsmEntrance(latlng) {
        const entrances = osmEntrancesCache;
        if (!entrances?.length) return null;

        let best = null;
        let bestDist = Infinity;
        entrances.forEach((entrance) => {
            const dist = distanceMeters(latlng, latLng(entrance.lat, entrance.lng));
            if (dist < bestDist) {
                bestDist = dist;
                best = entrance;
            }
        });
        return best ? { entrance: best, distance: bestDist } : null;
    }

    function snapEntranceToOsmNode(entrance) {
        setEntranceFromLatLng(entrance.lat, entrance.lng);
        selectedOsmEntranceId = entrance.id;
        entranceSnapDetached = false;
        updateOsmEntranceMarkerStyles();
    }

    function snapEntranceToOutlineOnly(marker) {
        const snapped = closestPointOnBuildingOutline(getMarkerLatLng(marker));
        setMarkerLatLng(marker, snapped);
        points.entrance = [snapped.lat, snapped.lng];
        lastValidDrag.entrance = snapped;
    }

    function constrainEntranceMarker(marker) {
        const latlng = getMarkerLatLng(marker);
        const nearest = nearestOsmEntrance(latlng);

        if (nearest && nearest.distance <= ENTRANCE_SNAP_METERS) {
            snapEntranceToOsmNode(nearest.entrance);
            lastValidDrag.entrance = getMarkerLatLng(markers.entrance);
            return;
        }

        if (!entranceSnapDetached) {
            let reference = null;
            if (selectedOsmEntranceId && osmEntrancesCache) {
                reference =
                    osmEntrancesCache.find((entrance) => entrance.id === selectedOsmEntranceId) ||
                    null;
            }
            if (!reference && nearest) reference = nearest.entrance;

            if (reference) {
                const refDist = distanceMeters(latlng, latLng(reference.lat, reference.lng));
                if (refDist > ENTRANCE_DETACH_METERS) {
                    entranceSnapDetached = true;
                    selectedOsmEntranceId = null;
                    updateOsmEntranceMarkerStyles();
                }
            }
        }

        snapEntranceToOutlineOnly(marker);
        if (entranceSnapDetached) {
            selectedOsmEntranceId = null;
            updateOsmEntranceMarkerStyles();
        }
    }

    function osmEntrancesGeoJson(entrances) {
        return {
            type: "FeatureCollection",
            features: entrances.map((entrance) => ({
                type: "Feature",
                properties: {
                    id: entrance.id,
                    selected: entrance.id === selectedOsmEntranceId,
                },
                geometry: {
                    type: "Point",
                    coordinates: [entrance.lng, entrance.lat],
                },
            })),
        };
    }

    function updateOsmEntranceMarkerStyles() {
        const source = map.getSource("osm-entrances");
        if (!source || !osmEntrancesCache?.length) return;
        source.setData(osmEntrancesGeoJson(osmEntrancesCache));
    }

    function showOsmEntranceMarkers(entrances) {
        const source = map.getSource("osm-entrances");
        if (!source) return;
        source.setData(osmEntrancesGeoJson(entrances));
        map.setLayoutProperty("osm-entrances", "visibility", "visible");
    }

    function hideOsmEntrances() {
        const source = map.getSource("osm-entrances");
        if (!source) return;
        source.setData(emptyFeatureCollection());
        map.setLayoutProperty("osm-entrances", "visibility", "none");
    }

    function pickMainOsmEntrance(entrances) {
        if (!entrances?.length) return null;
        return (
            entrances.find((entrance) => String(entrance.entrance || "").toLowerCase() === "main") ||
            null
        );
    }

    function applyDefaultOsmEntrance(entrances) {
        if (entranceSnapDetached) return;
        const main = pickMainOsmEntrance(entrances);
        if (!main) return;
        snapEntranceToOsmNode(main);
    }

    function finishOsmEntrancesLoad(entrances) {
        if (wizardStep === "entrance") {
            showOsmEntranceMarkers(entrances);
        }
        applyDefaultOsmEntrance(entrances);
    }

    async function loadOsmEntrances() {
        if (!buildingOsm?.id || !outlineApi?.fetchEntrances) return;

        const cacheKey = `${buildingOsm.type}:${buildingOsm.id}`;
        if (osmEntrancesCacheKey === cacheKey && osmEntrancesCache) {
            finishOsmEntrancesLoad(osmEntrancesCache);
            return;
        }

        if (osmEntrancesLoading) return;
        osmEntrancesLoading = true;

        try {
            const entrances = await outlineApi.fetchEntrances(buildingOsm.type, buildingOsm.id);
            osmEntrancesCacheKey = cacheKey;
            osmEntrancesCache = entrances;
            finishOsmEntrancesLoad(entrances);
        } catch (error) {
            console.warn("[TupTup] Błąd pobierania wejść z OSM:", error);
        } finally {
            osmEntrancesLoading = false;
        }
    }

    function snapParkingOutside(marker) {
        const snapped = pushOutsideBuilding(getMarkerLatLng(marker));
        setMarkerLatLng(marker, snapped);
        points.parking = [snapped.lat, snapped.lng];
        lastValidDrag.parking = snapped;
        return snapped;
    }

    function constrainMarkerPosition(key, marker) {
        const latlng = getMarkerLatLng(marker);

        if (wizardStep === "parking" && key === "parking") {
            if (pointInBuilding(latlng)) {
                setMarkerLatLng(marker, lastValidDrag[key]);
            } else {
                lastValidDrag[key] = latlng;
            }
            return;
        }

        if (wizardStep === "entrance" && key === "entrance") {
            constrainEntranceMarker(marker);
            return;
        }

        if (wizardStep === "destination" && key === "delivery") {
            if (!pointInBuilding(latlng)) {
                setMarkerLatLng(marker, lastValidDrag[key]);
            } else {
                lastValidDrag[key] = latlng;
            }
        }
    }

    function setMarkerDraggingState(marker, enabled) {
        marker.setDraggable(enabled);
        const el = marker.getElement()?.querySelector(".map-marker");
        if (el) el.classList.toggle("map-marker--draggable", enabled);
    }

    function initMarkersAndRoutes() {
        addMarker("parking", "parking", "P");
        addMarker("entrance", "entry", "entry");
        addMarker("delivery", "target", "◎");
        addRoute("parking-entrance", "parking", "entrance");
        addRoute("entrance-delivery", "entrance", "delivery");

        Object.entries(markers).forEach(([key, marker]) => {
            marker.on("dragstart", () => {
                lastValidDrag[key] = getMarkerLatLng(marker);
                map.getCanvasContainer().classList.add("map-dragging");
            });

            marker.on("drag", () => {
                const constrained =
                    (wizardStep === "parking" && key === "parking") ||
                    (wizardStep === "entrance" && key === "entrance") ||
                    (wizardStep === "destination" && key === "delivery");

                if (constrained) constrainMarkerPosition(key, marker);
                updateRoutes();
            });

            marker.on("dragend", () => {
                map.getCanvasContainer().classList.remove("map-dragging");
                if (wizardStep === "entrance" && key === "entrance") {
                    constrainEntranceMarker(marker);
                }
                const point = getMarkerLatLng(marker);
                points[key] = [point.lat, point.lng];
                updateOsmEntranceMarkerStyles();
                updateRoutes();
            });
        });
    }

    function getParkingFitBounds() {
        if (!hasBuilding()) return null;

        const center = buildingBounds.getCenter();
        const latSpan = Math.max((buildingBounds.getNorth() - buildingBounds.getSouth()) * 0.35, 0.00055);
        const lngSpan = Math.max((buildingBounds.getEast() - buildingBounds.getWest()) * 0.35, 0.0007);
        return latLngBoundsFromCoords([
            [center.lat - latSpan, center.lng - lngSpan],
            [center.lat + latSpan, center.lng + lngSpan],
        ]);
    }

    function getFitBounds() {
        if (wizardStep !== "parking" && wizardStep !== "print") return null;
        return getParkingFitBounds();
    }

    function getBuildingScreenBox() {
        if (!hasBuilding()) return null;

        const xs = [];
        const ys = [];
        buildingOutline.forEach(([lat, lng]) => {
            const pt = map.project([lng, lat]);
            xs.push(pt.x);
            ys.push(pt.y);
        });

        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        return {
            width: maxX - minX,
            height: maxY - minY,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2,
        };
    }

    function fitBuildingBoundsFallback(padding = 48) {
        if (!buildingBounds?.isValid()) return false;
        map.fitBounds(buildingBounds.toMapBounds(), {
            padding,
            maxZoom: BUILDING_FILL_MAX_ZOOM,
            animate: false,
        });
        return true;
    }

    function fitBuildingFillView() {
        if (!hasBuilding()) return false;
        map.resize();
        const canvas = map.getCanvas();
        const size = { x: canvas.clientWidth, y: canvas.clientHeight };
        if (size.x < 10 || size.y < 10) return false;

        const center = buildingBounds.getCenter();
        map.jumpTo({ center: [center.lng, center.lat], zoom: map.getZoom() });

        const box = getBuildingScreenBox();
        if (!box || box.width < 2 || box.height < 2) {
            return fitBuildingBoundsFallback();
        }

        const fitRatio = Math.min(size.x / box.width, size.y / box.height) * BUILDING_FILL_INSET;
        const targetZoom = Math.min(map.getZoom() + Math.log2(fitRatio), BUILDING_FILL_MAX_ZOOM);
        const targetCenter = map.unproject([box.centerX, box.centerY]);

        map.jumpTo({
            center: [targetCenter.lng, targetCenter.lat],
            zoom: targetZoom,
        });
        return true;
    }

    function scheduleBuildingFillView() {
        fitBuildingFillView();
        requestAnimationFrame(fitBuildingFillView);
        setTimeout(fitBuildingFillView, 320);
    }

    function centerBuildingInMapView() {
        map.resize();
        const box = getBuildingScreenBox();
        if (!box) return fitBuildingBoundsFallback(32);

        const canvas = map.getCanvas();
        const size = { x: canvas.clientWidth, y: canvas.clientHeight };
        if (size.x < 10 || size.y < 10) return false;

        const offsetX = size.x / 2 - box.centerX;
        const offsetY = size.y / 2 - box.centerY;
        if (Math.abs(offsetX) < 1 && Math.abs(offsetY) < 1) return true;

        map.panBy([offsetX, offsetY], { animate: false });
        return true;
    }

    function schedulePrintMapCenter() {
        centerBuildingInMapView();
        requestAnimationFrame(centerBuildingInMapView);
        setTimeout(centerBuildingInMapView, 320);
    }

    function fitMapView() {
        if (!hasBuilding()) {
            if (awaitingBuilding()) return;
            map.jumpTo({
                center: toLngLat(MAP_FALLBACK_CENTER),
                zoom: MAP_FALLBACK_ZOOM,
            });
            return;
        }

        if (isBuildingFillStep()) {
            scheduleBuildingFillView();
            return;
        }

        const bounds = getFitBounds();
        if (!bounds?.isValid()) {
            const center = buildingBounds.getCenter();
            map.jumpTo({ center: [center.lng, center.lat], zoom: 17 });
            return;
        }

        map.fitBounds(bounds.toMapBounds(), { padding: 16, maxZoom: PARKING_MAX_ZOOM });
        if (wizardStep === "print") {
            schedulePrintMapCenter();
        }
    }

    function refreshMapLayout() {
        map.resize();
        if (!hasBuilding() && awaitingBuilding()) {
            return;
        }
        fitMapView();
    }

    function applyWizardStep(step) {
        if (!wizardConfig[step] || !markersInitialized) return;
        wizardStep = step;
        const config = wizardConfig[step];

        Object.keys(markers).forEach((key) => {
            const marker = markers[key];
            const visible = config.markers.includes(key);
            const active = config.active === key;
            const type = key === "delivery" ? "target" : key === "entrance" ? "entry" : "parking";
            const label = type === "entry" ? "entry" : type === "target" ? "◎" : "P";

            if (visible) {
                if (!markerOnMap(marker)) marker.addTo(map);
                updateMarkerAppearance(marker, type, label, active);
                marker.getElement().style.zIndex = active ? "1000" : "500";
                setMarkerDraggingState(marker, config.draggable.includes(key));
            } else if (markerOnMap(marker)) {
                marker.remove();
            }
        });

        if (step === "parking" && markers.parking) {
            snapParkingOutside(markers.parking);
        }

        if (step === "entrance" && markers.entrance) {
            if (osmEntrancesCache?.length) {
                constrainEntranceMarker(markers.entrance);
            } else {
                snapEntranceToOutline(markers.entrance);
            }
            loadOsmEntrances();
        } else {
            hideOsmEntrances();
        }

        updateRoutesSource(config.routes);
        updateRoutes();
        syncCoords();
        fitMapView();
    }

    const locateButton = mapArea.querySelector(".map-control-locate");
    const resetButton = mapArea.querySelector(".map-control-reset");

    function showUserLocation(lat, lng) {
        const source = map.getSource("user-location");
        if (!source) return;
        source.setData({
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    properties: {},
                    geometry: {
                        type: "Point",
                        coordinates: [lng, lat],
                    },
                },
            ],
        });
        map.setLayoutProperty("user-location", "visibility", "visible");
    }

    function hideUserLocation() {
        const source = map.getSource("user-location");
        if (!source) return;
        source.setData(emptyFeatureCollection());
        map.setLayoutProperty("user-location", "visibility", "none");
    }

    locateButton?.addEventListener("click", () => {
        if (!navigator.geolocation) return;

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude } = position.coords;
                map.flyTo({
                    center: [longitude, latitude],
                    zoom: 18,
                });
                showUserLocation(latitude, longitude);
            },
            (error) => {
                console.warn("[TupTup] Nie udało się ustalić lokalizacji:", error);
            },
            { enableHighAccuracy: true }
        );
    });

    resetButton?.addEventListener("click", fitMapView);

    map.on("click", "osm-entrances", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (id == null || !osmEntrancesCache) return;
        const entrance = osmEntrancesCache.find((item) => String(item.id) === String(id));
        if (entrance) snapEntranceToOsmNode(entrance);
    });

    map.on("mouseenter", "osm-entrances", () => {
        map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", "osm-entrances", () => {
        map.getCanvas().style.cursor = "";
    });

    const resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeLayoutTimer);
        resizeLayoutTimer = setTimeout(refreshMapLayout, 80);
    });
    resizeObserver.observe(mapArea);

    window.addEventListener("orientationchange", () => {
        setTimeout(refreshMapLayout, 200);
    });

    window.TupTupMap = {
        setWizardStep: applyWizardStep,
        fitMapView: refreshMapLayout,
        getPoints: () => {
            if (!points.parking || !points.entrance || !points.delivery) return null;
            return {
                parking: [...points.parking],
                entrance: [...points.entrance],
                delivery: [...points.delivery],
            };
        },
        hasBuilding: () => hasBuilding(),
    };

    function commitBuilding(building) {
        if (!building?.outline?.length) return;
        buildingOsm =
            building.osm_type && building.osm_id != null
                ? { type: building.osm_type, id: String(building.osm_id) }
                : null;
        osmEntrancesCache = null;
        osmEntrancesCacheKey = null;
        selectedOsmEntranceId = null;
        entranceSnapDetached = false;
        hideOsmEntrances();
        applyBuildingOutline(building.outline);
        loadOsmEntrances();
        document.dispatchEvent(new CustomEvent("tuptup:building", { detail: building }));
    }

    function flushPendingBuilding() {
        if (!pendingBuilding) return;
        const building = pendingBuilding;
        pendingBuilding = null;
        commitBuilding(building);
    }

    function startMap() {
        mapStarted = true;
        if (!hasBuilding()) {
            map.jumpTo({
                center: toLngLat(MAP_FALLBACK_CENTER),
                zoom: MAP_FALLBACK_ZOOM,
            });
        }
        flushPendingBuilding();
        scheduleMapLayoutRetries();
        document.dispatchEvent(new CustomEvent("tuptup:map-ready"));
    }

    function loadBuildingFromOsm() {
        if (!outlineApi?.resolve) return;

        outlineApi
            .resolve()
            .then((building) => {
                outlineLoading = false;
                if (!building?.outline?.length) {
                    console.warn("[TupTup] Brak osm_id budynku — podaj ?osmid= lub building_osm_way.");
                    if (mapStarted) refreshMapLayout();
                    return;
                }
                pendingBuilding = building;
                if (mapStarted) flushPendingBuilding();
                else scheduleMapLayoutRetries();
            })
            .catch((error) => {
                outlineLoading = false;
                console.warn("[TupTup] Błąd pobierania obrysu budynku:", error);
                if (mapStarted) refreshMapLayout();
            });
    }

    map.on("load", () => {
        hideOsmEntrances();
        hideUserLocation();
    });

    document.addEventListener("DOMContentLoaded", startMap);

    window.addEventListener("load", scheduleMapLayoutRetries);

    if (outlineApi?.parseOsmFromPage?.()) {
        loadBuildingFromOsm();
    } else {
        outlineLoading = false;
    }
})();
