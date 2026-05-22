(function () {
    const mapArea = document.querySelector(".map-area");
    const mapCanvas = document.querySelector(".map-canvas");
    if (!mapArea || !mapCanvas || typeof L === "undefined") return;
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

    const markers = {};
    const routeLines = {};
    const layers = [];
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
    };

    const BUILDING_FILL_MAX_ZOOM = 22;
    const BUILDING_FILL_INSET = 0.88;
    const PARKING_MAX_ZOOM = 19;

    const map = L.map(mapCanvas, {
        zoomControl: false,
        attributionControl: true,
        maxZoom: BUILDING_FILL_MAX_ZOOM,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: BUILDING_FILL_MAX_ZOOM,
        maxNativeZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const buildingLayerStyle = {
        className: "map-building-highlight",
        color: "#111111",
        weight: 3,
        fillColor: "#ffffff",
        fillOpacity: 0.72,
        interactive: false,
    };

    const buildingLayer = L.polygon([], buildingLayerStyle);

    function hasBuilding() {
        return buildingOutline.length >= 3 && buildingBounds?.isValid();
    }

    function defaultPointsForOutline(outline) {
        const bounds = L.latLngBounds(outline);
        const center = bounds.getCenter();

        let entrance = L.latLng(outline[0]);
        let longest = -1;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
            const [lat1, lng1] = outline[j];
            const [lat2, lng2] = outline[i];
            const a = L.latLng(lat1, lng1);
            const b = L.latLng(lat2, lng2);
            const len = a.distanceTo(b);
            if (len > longest) {
                longest = len;
                entrance = L.latLng((lat1 + lat2) / 2, (lng1 + lng2) / 2);
            }
        }
        entrance = closestPointOnBuildingOutline(entrance);

        const c = bounds.getCenter();
        const dLat = entrance.lat - c.lat;
        const dLng = entrance.lng - c.lng;
        const len = Math.hypot(dLat, dLng) || 1e-9;
        let parking = L.latLng(
            entrance.lat + (dLat / len) * 0.00022,
            entrance.lng + (dLng / len) * 0.00022
        );
        parking = pushOutsideBuilding(parking);

        let delivery = center;
        if (!pointInBuilding(delivery)) {
            delivery = L.latLng(
                entrance.lat + (c.lat - entrance.lat) * 0.45,
                entrance.lng + (c.lng - entrance.lng) * 0.45
            );
        }
        if (!pointInBuilding(delivery)) {
            delivery = L.latLng(
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
            marker.setLatLng(coords);
            lastValidDrag[key] = marker.getLatLng();
        });
        updateRoutes();
        syncCoords();
    }

    function applyBuildingOutline(outline) {
        if (!outline?.length) return;
        buildingOutline = outline;
        buildingBounds = L.latLngBounds(buildingOutline);
        if (!map.hasLayer(buildingLayer)) {
            buildingLayer.addTo(map);
            layers.push(buildingLayer);
        }
        buildingLayer.setLatLngs(buildingOutline);
        buildingLayer.setStyle(buildingLayerStyle);
        repositionMarkersForBuilding();
        if (!markersInitialized) {
            initMarkersAndRoutes();
            markersInitialized = true;
        }
        ensureWizardStarted();
        refreshMapLayout();
    }

    function ensureWizardStarted() {
        if (wizardStarted || !markersInitialized) return;
        wizardStarted = true;
        applyWizardStep("parking");
        requestAnimationFrame(refreshMapLayout);
        setTimeout(refreshMapLayout, 120);
        setTimeout(refreshMapLayout, 400);
    }

    function markerIcon(type, label, active) {
        const activeClass = active ? " map-marker--active" : "";
        return L.divIcon({
            className: "map-marker-host",
            html: `<div class="map-marker map-marker--${type} map-marker--draggable${activeClass}" role="img" aria-label="${label}">${label === "entry" ? "" : label}</div>`,
            iconSize: [44, 58],
            iconAnchor: [22, 58],
        });
    }

    function getLatLng(key) {
        if (markers[key]) {
            const { lat, lng } = markers[key].getLatLng();
            points[key] = [lat, lng];
            return markers[key].getLatLng();
        }
        if (points[key]) return L.latLng(points[key]);
        return hasBuilding() ? buildingBounds.getCenter() : L.latLng(MAP_FALLBACK_CENTER);
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
        Object.values(routeLines).forEach((line) => {
            const from = line.tuptupFrom;
            const to = line.tuptupTo;
            line.setLatLngs([getLatLng(from), getLatLng(to)]);
        });
        syncCoords();
    }

    function addMarker(key, type, label) {
        const marker = L.marker(points[key], {
            icon: markerIcon(type, label, false),
            draggable: true,
            autoPan: true,
            zIndexOffset: 500,
        });

        markers[key] = marker;
        return marker;
    }

    function addRoute(id, from, to) {
        const line = L.polyline([getLatLng(from), getLatLng(to)], {
            color: "#111111",
            weight: 3,
            dashArray: "8 8",
            lineCap: "round",
        });
        line.tuptupFrom = from;
        line.tuptupTo = to;
        routeLines[id] = line;
        return line;
    }

    let buildingBounds = null;
    const lastValidDrag = {};

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
        if (lengthSq === 0) return L.latLng(lat1, lng1);

        let t = ((lng - lng1) * dx + (lat - lat1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        return L.latLng(lat1 + t * dy, lng1 + t * dx);
    }

    function closestPointOnBuildingOutline(latlng) {
        if (!hasBuilding()) return latlng;
        let best = L.latLng(buildingOutline[0]);
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
            const dist = candidate.distanceTo(latlng);
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

        let candidate = L.latLng(
            onOutline.lat + (dLat / len) * margin,
            onOutline.lng + (dLng / len) * margin
        );

        for (let attempt = 0; pointInBuilding(candidate) && attempt < 8; attempt++) {
            margin *= 1.5;
            candidate = L.latLng(
                onOutline.lat + (dLat / len) * margin,
                onOutline.lng + (dLng / len) * margin
            );
        }

        return candidate;
    }

    function snapEntranceToOutline(marker) {
        const snapped = closestPointOnBuildingOutline(marker.getLatLng());
        marker.setLatLng(snapped);
        points.entrance = [snapped.lat, snapped.lng];
        lastValidDrag.entrance = snapped;
        return snapped;
    }

    function snapParkingOutside(marker) {
        const snapped = pushOutsideBuilding(marker.getLatLng());
        marker.setLatLng(snapped);
        points.parking = [snapped.lat, snapped.lng];
        lastValidDrag.parking = snapped;
        return snapped;
    }

    function constrainMarkerPosition(key, marker) {
        const latlng = marker.getLatLng();

        if (wizardStep === "parking" && key === "parking") {
            if (pointInBuilding(latlng)) {
                marker.setLatLng(lastValidDrag[key]);
            } else {
                lastValidDrag[key] = latlng;
            }
            return;
        }

        if (wizardStep === "entrance" && key === "entrance") {
            const snapped = closestPointOnBuildingOutline(latlng);
            marker.setLatLng(snapped);
            lastValidDrag[key] = snapped;
            return;
        }

        if (wizardStep === "destination" && key === "delivery") {
            if (!pointInBuilding(latlng)) {
                marker.setLatLng(lastValidDrag[key]);
            } else {
                lastValidDrag[key] = latlng;
            }
        }
    }

    function initMarkersAndRoutes() {
        addMarker("parking", "parking", "P");
        addMarker("entrance", "entry", "entry");
        addMarker("delivery", "target", "◎");
        addRoute("parking-entrance", "parking", "entrance");
        addRoute("entrance-delivery", "entrance", "delivery");

        Object.entries(markers).forEach(([key, marker]) => {
            marker.on("dragstart", () => {
                lastValidDrag[key] = marker.getLatLng();
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
                const { lat, lng } = marker.getLatLng();
                points[key] = [lat, lng];
                updateRoutes();
            });
        });
    }

    function getFitBounds() {
        if (wizardStep !== "parking" || !hasBuilding()) return null;

        const center = buildingBounds.getCenter();
        const latSpan = Math.max((buildingBounds.getNorth() - buildingBounds.getSouth()) * 0.35, 0.00055);
        const lngSpan = Math.max((buildingBounds.getEast() - buildingBounds.getWest()) * 0.35, 0.0007);
        return L.latLngBounds(
            [center.lat - latSpan, center.lng - lngSpan],
            [center.lat + latSpan, center.lng + lngSpan]
        );
    }

    function getBuildingScreenBox() {
        const pathEl = map.getPane("overlayPane")?.querySelector("path.map-building-highlight");
        if (!pathEl) return null;

        const mapRect = map.getContainer().getBoundingClientRect();
        const pb = pathEl.getBBox();
        const ctm = pathEl.getScreenCTM();
        if (!ctm) return null;

        const xs = [];
        const ys = [];
        [
            [pb.x, pb.y],
            [pb.x + pb.width, pb.y],
            [pb.x + pb.width, pb.y + pb.height],
            [pb.x, pb.y + pb.height],
        ].forEach(([x, y]) => {
            const pt = new DOMPoint(x, y).matrixTransform(ctm);
            xs.push(pt.x - mapRect.left);
            ys.push(pt.y - mapRect.top);
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

    function fitBuildingFillView() {
        if (!hasBuilding()) return false;
        map.invalidateSize(true);
        const size = map.getSize();
        if (size.x < 10 || size.y < 10) return false;

        const center = buildingLayer.getBounds().getCenter();
        map.setView(center, map.getZoom(), { animate: false });

        const box = getBuildingScreenBox();
        if (!box || box.width < 2 || box.height < 2) return false;

        const fitRatio = Math.min(size.x / box.width, size.y / box.height) * BUILDING_FILL_INSET;
        const targetZoom = Math.min(map.getZoom() + Math.log2(fitRatio), BUILDING_FILL_MAX_ZOOM);
        const targetCenter = map.containerPointToLatLng(L.point(box.centerX, box.centerY));

        map.setView(targetCenter, targetZoom, { animate: false });
        return true;
    }

    function scheduleBuildingFillView() {
        fitBuildingFillView();
        requestAnimationFrame(fitBuildingFillView);
        setTimeout(fitBuildingFillView, 320);
    }

    function fitMapView() {
        if (!hasBuilding()) {
            map.setView(MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM);
            return;
        }

        if (isBuildingFillStep()) {
            scheduleBuildingFillView();
            return;
        }

        const bounds = getFitBounds();
        if (!bounds?.isValid()) {
            map.setView(buildingBounds.getCenter(), 17);
            return;
        }

        map.fitBounds(bounds, { padding: [16, 16], maxZoom: PARKING_MAX_ZOOM });
    }

    function refreshMapLayout() {
        map.invalidateSize(true);
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
                if (!map.hasLayer(marker)) marker.addTo(map);
                marker.setIcon(markerIcon(type, label, active));
                marker.setZIndexOffset(active ? 1000 : 500);
                if (marker.dragging) {
                    if (config.draggable.includes(key)) marker.dragging.enable();
                    else marker.dragging.disable();
                }
            } else if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        });

        if (step === "parking" && markers.parking) {
            snapParkingOutside(markers.parking);
        }

        if (step === "entrance" && markers.entrance) {
            snapEntranceToOutline(markers.entrance);
        }

        Object.entries(routeLines).forEach(([id, line]) => {
            if (config.routes.includes(id)) {
                line.setLatLngs([getLatLng(line.tuptupFrom), getLatLng(line.tuptupTo)]);
                if (!map.hasLayer(line)) line.addTo(map);
            } else if (map.hasLayer(line)) {
                map.removeLayer(line);
            }
        });

        updateRoutes();
        syncCoords();
        fitMapView();
    }

    const locateButton = mapArea.querySelector(".map-control-locate");
    const resetButton = mapArea.querySelector(".map-control-reset");

    locateButton?.addEventListener("click", () => {
        map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });
    });

    let userLocationLayer = null;

    map.on("locationfound", (event) => {
        if (userLocationLayer) map.removeLayer(userLocationLayer);
        userLocationLayer = L.circleMarker(event.latlng, {
            radius: 7,
            color: "#111111",
            weight: 2,
            fillColor: "#ffffff",
            fillOpacity: 1,
        }).addTo(map);
    });

    resetButton?.addEventListener("click", fitMapView);

    const resizeObserver = new ResizeObserver(() => refreshMapLayout());
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

    function startMap() {
        map.setView(MAP_FALLBACK_CENTER, MAP_FALLBACK_ZOOM);
        requestAnimationFrame(refreshMapLayout);
        document.dispatchEvent(new CustomEvent("tuptup:map-ready"));
    }

    // Po DOMContentLoaded — wtedy skrypty `defer` (flow.js) są już wykonane.
    document.addEventListener("DOMContentLoaded", startMap);

    window.addEventListener("load", refreshMapLayout);

    if (outlineApi?.resolve) {
        outlineApi.resolve().then((building) => {
            if (!building?.outline?.length) {
                console.warn("[TupTup] Brak osm_id budynku — podaj ?osmid= lub building_osm_way.");
                return;
            }
            applyBuildingOutline(building.outline);
            document.dispatchEvent(
                new CustomEvent("tuptup:building", { detail: building })
            );
        });
    }
})();
