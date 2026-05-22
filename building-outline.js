(function (global) {
    const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

    /** Way C10 (160207067) — https://www.openstreetmap.org/way/160207067 */
    const DEFAULT_BUILDING_LEVELS = 5;

    const DEFAULT_BUILDING_OUTLINE = [
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

    function geometryToOutline(geometry) {
        if (!Array.isArray(geometry) || geometry.length < 3) return null;
        return geometry.map(({ lat, lon }) => [lat, lon]);
    }

    function ringArea(outline) {
        let area = 0;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
            const [yi, xi] = outline[j];
            const [y, x] = outline[i];
            area += (x - xi) * (yj + y);
        }
        return Math.abs(area);
    }

    function pickLargestRing(rings) {
        let best = null;
        let bestArea = -1;
        for (const ring of rings) {
            if (!ring || ring.length < 3) continue;
            const area = ringArea(ring);
            if (area > bestArea) {
                bestArea = area;
                best = ring;
            }
        }
        return best;
    }

    function parseOsmSpec(raw) {
        if (raw == null || raw === "") return null;

        const value = String(raw).trim();
        const typed = value.match(/^(way|relation|node)[/:](\d+)$/i);
        if (typed) {
            return { type: typed[1].toLowerCase(), id: typed[2], raw: value };
        }

        const prefixed = value.match(/^([wWrRnN])(\d+)$/);
        if (prefixed) {
            const typeMap = { w: "way", r: "relation", n: "node" };
            const type = typeMap[prefixed[1].toLowerCase()];
            return { type, id: prefixed[2], raw: value };
        }

        if (/^\d+$/.test(value)) {
            return { type: "way", id: value, raw: value };
        }

        return null;
    }

    function parseOsmFromUrl(search = global.location.search) {
        const params = new URLSearchParams(search);
        const raw =
            params.get("osmid") ||
            params.get("osm") ||
            params.get("building_osm_way");
        return parseOsmSpec(raw);
    }

    function parseOsmFromPage() {
        const fromUrl = parseOsmFromUrl();
        if (fromUrl) return fromUrl;

        const hidden = document.querySelector('input[name="building_osm_way"]');
        if (hidden?.value) {
            return parseOsmSpec(hidden.value) || { type: "way", id: hidden.value.trim(), raw: hidden.value };
        }

        return null;
    }

    function buildOverpassQuery(type, id) {
        const osmType = type === "relation" ? "relation" : "way";
        return `[out:json][timeout:25];${osmType}(${id});out geom;`;
    }

    function outlineFromWay(element) {
        return geometryToOutline(element.geometry);
    }

    function outlineFromRelation(element) {
        const rings = [];

        if (Array.isArray(element.members)) {
            for (const member of element.members) {
                if (member.role === "inner") continue;
                if (member.type === "way" && member.geometry) {
                    const ring = geometryToOutline(member.geometry);
                    if (ring) rings.push(ring);
                }
            }
        }

        if (rings.length) return pickLargestRing(rings);

        if (element.geometry) {
            return geometryToOutline(element.geometry);
        }

        return null;
    }

    function elementFromResponse(data, spec) {
        const elements = data?.elements;
        if (!Array.isArray(elements) || !elements.length) return null;

        return (
            elements.find((el) => el.type === spec.type && String(el.id) === String(spec.id)) ||
            elements.find((el) => el.type === spec.type) ||
            null
        );
    }

    function parsePositiveInt(raw) {
        if (raw == null || raw === "") return null;
        const value = Number.parseInt(String(raw).trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : null;
    }

    function parseSignedInt(raw) {
        if (raw == null || raw === "") return null;
        const value = Number.parseInt(String(raw).trim(), 10);
        return Number.isFinite(value) ? value : null;
    }

    function levelsFromElement(element) {
        const levels = parsePositiveInt(element?.tags?.["building:levels"]);
        const minLevel = parseSignedInt(element?.tags?.["building:min_level"]);
        return {
            levels: levels ?? DEFAULT_BUILDING_LEVELS,
            minLevel: minLevel ?? 0,
        };
    }

    function outlineFromElement(element) {
        if (!element) return null;
        if (element.type === "relation") return outlineFromRelation(element);
        if (element.type === "way") return outlineFromWay(element);
        return null;
    }

    function outlineFromResponse(data, spec) {
        return outlineFromElement(elementFromResponse(data, spec));
    }

    function buildingFromResponse(data, spec) {
        const element = elementFromResponse(data, spec);
        const outline = outlineFromElement(element);
        if (!outline || outline.length < 3) return null;

        const { levels, minLevel } = levelsFromElement(element);
        const maxLevel = levels - 1 + minLevel;

        return { outline, levels, minLevel, maxLevel };
    }

    async function fetchOutline(spec) {
        if (!spec?.id || !spec?.type) return null;

        if (spec.type !== "way" && spec.type !== "relation") {
            throw new Error(`Nieobsługiwany typ OSM: ${spec.type}`);
        }

        const query = buildOverpassQuery(spec.type, spec.id);
        const response = await fetch(OVERPASS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                "User-Agent": "TupTupRecipientFlow/1.0",
            },
            body: `data=${encodeURIComponent(query)}`,
        });

        if (!response.ok) {
            throw new Error(`Overpass HTTP ${response.status}`);
        }

        const data = await response.json();
        const building = buildingFromResponse(data, spec);

        if (!building) {
            throw new Error("Brak geometrii obrysu w odpowiedzi Overpass");
        }

        return building;
    }

    function defaultBuilding() {
        return {
            outline: DEFAULT_BUILDING_OUTLINE.slice(),
            levels: DEFAULT_BUILDING_LEVELS,
            minLevel: 0,
            maxLevel: DEFAULT_BUILDING_LEVELS - 1,
        };
    }

    async function resolve() {
        const spec = parseOsmFromPage();
        if (!spec) return defaultBuilding();

        try {
            const building = await fetchOutline(spec);
            if (building) return building;
        } catch (error) {
            console.warn("[TupTup] Nie udało się pobrać danych budynku z Overpass:", error);
        }

        return defaultBuilding();
    }

    global.TupTupBuildingOutline = {
        DEFAULT: DEFAULT_BUILDING_OUTLINE,
        DEFAULT_LEVELS: DEFAULT_BUILDING_LEVELS,
        OVERPASS_URL,
        parseOsmSpec,
        parseOsmFromUrl,
        parseOsmFromPage,
        levelsFromElement,
        fetchOutline,
        resolve,
    };
})(window);
