(function () {
    const mapArea = document.querySelector(".map-area");
    const mapCanvas = document.querySelector(".map-canvas");
    if (!mapArea || !mapCanvas || typeof L === "undefined") return;

    const mode = mapArea.dataset.mapMode || "parking";

    // Way C10 (160207067) — https://www.openstreetmap.org/way/160207067
    const buildingOutline = [
        [52.2418507, 20.9456745],
        [52.2415365, 20.9458358],
        [52.2414068, 20.9459023],
        [52.2413835, 20.9457813],
        [52.2413902, 20.9457779],
        [52.2413969, 20.9457744],
        [52.2413837, 20.9457058],
        [52.2415407, 20.9456252],
        [52.2415792, 20.9456054],
        [52.2418142, 20.9454848],
        [52.2418314, 20.9455742],
    ];

    const points = {
        parking: [52.241418, 20.945742],
        entrance: [52.2415365, 20.9458358],
        delivery: [52.241618, 20.945698],
    };

    const markers = {};
    const routes = [];

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

    const layers = [buildingLayer];
    const buildingBounds = L.latLngBounds(buildingOutline);

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

    function bindParkingOutsideConstraint(marker) {
        let lastValid = marker.getLatLng();

        marker.off("drag");
        marker.off("dragend");

        marker.on("dragstart", () => {
            lastValid = marker.getLatLng();
        });

        marker.on("drag", () => {
            const latlng = marker.getLatLng();
            if (pointInBuilding(latlng)) {
                marker.setLatLng(lastValid);
            } else {
                lastValid = latlng;
            }
            updateRoutes();
        });

        marker.on("dragend", () => {
            const snapped = pushOutsideBuilding(marker.getLatLng());
            marker.setLatLng(snapped);
            points.parking = [snapped.lat, snapped.lng];
            lastValid = snapped;
            updateRoutes();
        });

        const snapped = pushOutsideBuilding(marker.getLatLng());
        marker.setLatLng(snapped);
        points.parking = [snapped.lat, snapped.lng];
        lastValid = snapped;
        updateRoutes();
    }

    function markerIcon(type, label) {
        return L.divIcon({
            className: "map-marker-host",
            html: `<div class="map-marker map-marker--${type} map-marker--draggable" role="img" aria-label="${label}">${label === "entry" ? "▯" : label}</div>`,
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

    function updateRoutes() {
        routes.forEach(({ line, from, to }) => {
            line.setLatLngs([getLatLng(from), getLatLng(to)]);
        });
    }

    function addMarker(key, type, label) {
        const marker = L.marker(points[key], {
            icon: markerIcon(type, label),
            draggable: true,
            autoPan: true,
            zIndexOffset: 500,
        }).addTo(map);

        marker.on("drag", updateRoutes);
        marker.on("dragend", () => {
            const { lat, lng } = marker.getLatLng();
            points[key] = [lat, lng];
            updateRoutes();
        });

        markers[key] = marker;
        layers.push(marker);
        return marker;
    }

    function addRoute(from, to) {
        const line = L.polyline([getLatLng(from), getLatLng(to)], {
            color: "#111111",
            weight: 3,
            dashArray: "8 8",
            lineCap: "round",
        }).addTo(map);

        routes.push({ line, from, to });
        layers.push(line);
        return line;
    }

    if (mode === "parking") {
        addMarker("parking", "parking", "P");
        bindParkingOutsideConstraint(markers.parking);
        addRoute("parking", "entrance");
    }

    if (mode === "entrance") {
        addMarker("parking", "parking", "P");
        addMarker("entrance", "entry", "entry");
        addRoute("parking", "entrance");
    }

    if (mode === "destination") {
        addMarker("entrance", "entry", "entry");
        addMarker("delivery", "target", "◎");
        addRoute("entrance", "delivery");
    }

    const viewByMode = {
        parking: { padding: [16, 16], maxZoom: 19 },
        entrance: { padding: [36, 36] },
        destination: { padding: [36, 36] },
    };
    const viewOptions = viewByMode[mode] || viewByMode.entrance;
    const fitTargets = mode === "parking" ? L.featureGroup(layers) : buildingLayer;

    function getFitBounds() {
        const bounds = fitTargets.getBounds();
        if (mode !== "parking") return bounds;

        const center = bounds.getCenter();
        const latSpan = Math.max((bounds.getNorth() - bounds.getSouth()) * 0.28, 0.00055);
        const lngSpan = Math.max((bounds.getEast() - bounds.getWest()) * 0.28, 0.0007);

        return L.latLngBounds(
            [center.lat - latSpan, center.lng - lngSpan],
            [center.lat + latSpan, center.lng + lngSpan]
        );
    }

    function fitMapView() {
        map.fitBounds(getFitBounds(), viewOptions);
    }

    fitMapView();

    const locateButton = mapArea.querySelector(".map-control-locate");
    const resetButton = mapArea.querySelector(".map-control-reset");

    locateButton?.addEventListener("click", () => {
        map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });
    });

    let userLocationLayer = null;

    map.on("locationfound", (event) => {
        if (userLocationLayer) {
            map.removeLayer(userLocationLayer);
        }
        userLocationLayer = L.circleMarker(event.latlng, {
            radius: 7,
            color: "#111111",
            weight: 2,
            fillColor: "#ffffff",
            fillOpacity: 1,
        }).addTo(map);
    });

    resetButton?.addEventListener("click", fitMapView);

    const resizeObserver = new ResizeObserver(() => {
        map.invalidateSize();
    });
    resizeObserver.observe(mapArea);

    window.addEventListener("orientationchange", () => {
        setTimeout(() => map.invalidateSize(), 200);
    });
})();
