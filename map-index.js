(function () {
    const mapArea = document.querySelector(".map-area");
    const mapCanvas = document.querySelector(".map-canvas");
    if (!mapArea || !mapCanvas || typeof L === "undefined") return;
    if (mapArea.dataset.mapMode !== "all") return;

    const outlineApi = window.TupTupBuildingOutline;
    let buildingOutline = (outlineApi?.DEFAULT || []).slice();

    const points = {
        parking: [52.241418, 20.945742],
        entrance: [52.2415365, 20.9458358],
        delivery: [52.241618, 20.945698],
    };

    const markers = {};
    const routeLines = {};
    const layers = [];
    let wizardStep = "parking";

    const wizardConfig = {
        parking: {
            markers: ["parking"],
            routes: ["parking-entrance"],
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

    const map = L.map(mapCanvas, {
        zoomControl: false,
        attributionControl: true,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const buildingLayer = L.polygon(buildingOutline, {
        color: "#8d8d8d",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 0.52,
    }).addTo(map);

    layers.push(buildingLayer);

    function applyBuildingOutline(outline) {
        if (!outline?.length) return;
        buildingOutline = outline;
        buildingBounds = L.latLngBounds(buildingOutline);
        buildingLayer.setLatLngs(buildingOutline);
        refreshMapLayout();
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
        return L.latLng(points[key]);
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

    let buildingBounds = L.latLngBounds(buildingOutline);
    const lastValidDrag = {};

    function getBuildingCloseBounds() {
        const center = buildingBounds.getCenter();
        const latSpan = Math.max(
            (buildingBounds.getNorth() - buildingBounds.getSouth()) * 0.28,
            0.00055
        );
        const lngSpan = Math.max(
            (buildingBounds.getEast() - buildingBounds.getWest()) * 0.28,
            0.0007
        );
        return L.latLngBounds(
            [center.lat - latSpan, center.lng - lngSpan],
            [center.lat + latSpan, center.lng + lngSpan]
        );
    }

    function pointInBuilding(latlng) {
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

    function getFitBounds() {
        if (wizardStep === "parking") {
            const config = wizardConfig[wizardStep];
            const visibleLayers = [buildingLayer];

            config.markers.forEach((key) => {
                if (markers[key]) visibleLayers.push(markers[key]);
            });

            const bounds = L.featureGroup(visibleLayers).getBounds();
            const center = bounds.getCenter();
            const latSpan = Math.max((bounds.getNorth() - bounds.getSouth()) * 0.28, 0.00055);
            const lngSpan = Math.max((bounds.getEast() - bounds.getWest()) * 0.28, 0.0007);
            return L.latLngBounds(
                [center.lat - latSpan, center.lng - lngSpan],
                [center.lat + latSpan, center.lng + lngSpan]
            );
        }

        return getBuildingCloseBounds();
    }

    const viewByStep = {
        parking: { padding: [16, 16], maxZoom: 19 },
        entrance: { padding: [36, 36], maxZoom: 19 },
        destination: { padding: [36, 36], maxZoom: 19 },
    };

    function fitMapView() {
        const options = viewByStep[wizardStep] || viewByStep.entrance;
        const bounds = getFitBounds();

        if (!bounds.isValid()) {
            map.setView(points.entrance, 17);
            return;
        }

        map.fitBounds(bounds, options);
    }

    function refreshMapLayout() {
        map.invalidateSize(true);
        fitMapView();
    }

    function applyWizardStep(step) {
        if (!wizardConfig[step]) return;
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
        getPoints: () => ({
            parking: [...points.parking],
            entrance: [...points.entrance],
            delivery: [...points.delivery],
        }),
    };

    function startMap() {
        applyWizardStep("parking");
        requestAnimationFrame(refreshMapLayout);
        setTimeout(refreshMapLayout, 120);
        setTimeout(refreshMapLayout, 400);
        document.dispatchEvent(new CustomEvent("tuptup:map-ready"));
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startMap);
    } else {
        startMap();
    }

    window.addEventListener("load", refreshMapLayout);

    if (outlineApi?.resolve) {
        outlineApi.resolve().then(applyBuildingOutline);
    }
})();
