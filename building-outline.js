(function (global) {
    const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

    /** Gdy w OSM brak tagu building:levels */
    const FALLBACK_BUILDING_LEVELS = 5;

    function geometryToOutline(geometry) {
        if (!Array.isArray(geometry) || geometry.length < 3) return null;
        return geometry.map(({ lat, lon }) => [lat, lon]);
    }

    function ringArea(outline) {
        let area = 0;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
            const [yi, xi] = outline[j];
            const [y, x] = outline[i];
            area += (x - xi) * (yi + y);
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

        const fromUrl = value.match(/openstreetmap\.org\/(way|relation|node)\/(\d+)/i);
        if (fromUrl) {
            return { type: fromUrl[1].toLowerCase(), id: fromUrl[2], raw: value };
        }

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
            return { type: "auto", id: value, raw: value };
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
            return parseOsmSpec(hidden.value);
        }

        return null;
    }

    function buildOverpassQuery(type, id) {
        if (type === "auto") {
            return `[out:json][timeout:25];(way(${id});relation(${id}););out geom;`;
        }
        const osmType = type === "relation" ? "relation" : "way";
        return `[out:json][timeout:25];${osmType}(${id});out geom;`;
    }

    function isBuildingElement(element) {
        const tags = element?.tags;
        if (!tags) return false;
        if (tags.building) return true;
        if (tags.type === "multipolygon" && tags.building !== undefined) return true;
        return false;
    }

    function buildingScore(element) {
        if (!element) return -1;
        let score = 0;
        if (element.type === "relation") score += 4;
        if (isBuildingElement(element)) score += 8;
        if (outlineFromElement(element)) score += 2;
        return score;
    }

    function pickBuildingElement(elements, id) {
        if (!Array.isArray(elements) || !elements.length) return null;

        const matches = elements.filter(
            (el) =>
                (el.type === "way" || el.type === "relation") && String(el.id) === String(id)
        );
        if (!matches.length) return null;

        return matches.reduce((best, el) => (buildingScore(el) > buildingScore(best) ? el : best));
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

    const NAME_TAG_KEYS = ["official_name", "name", "brand", "operator"];

    function nameFromTags(tags) {
        if (!tags) return null;
        for (const key of NAME_TAG_KEYS) {
            const value = tags[key];
            if (value == null || value === "") continue;
            const trimmed = String(value).trim();
            if (trimmed) return trimmed;
        }
        return null;
    }

    function trimTag(value) {
        if (value == null || value === "") return "";
        return String(value).trim();
    }

    function addressFromTags(tags) {
        if (!tags) return null;

        const street = trimTag(tags["addr:street"]);
        const housenumber = trimTag(tags["addr:housenumber"]);
        const unit = trimTag(tags["addr:unit"]);
        const postcode = trimTag(tags["addr:postcode"]);
        const city = trimTag(tags["addr:city"]);

        const streetLine = [street, housenumber, unit].filter(Boolean).join(" ");
        const cityLine = [postcode, city].filter(Boolean).join(" ");
        const parts = [streetLine, cityLine].filter(Boolean);

        return parts.length ? parts.join(", ") : null;
    }

    function placeFromElement(element) {
        const tags = element?.tags;
        return {
            name: nameFromTags(tags),
            address: addressFromTags(tags),
        };
    }

    function levelsFromElement(element) {
        const levels = parsePositiveInt(element?.tags?.["building:levels"]);
        const minLevel = parseSignedInt(element?.tags?.["building:min_level"]);
        return {
            levels: levels ?? FALLBACK_BUILDING_LEVELS,
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

    function buildingFromElement(element) {
        const outline = outlineFromElement(element);
        if (!outline || outline.length < 3) return null;

        const { levels, minLevel } = levelsFromElement(element);
        const maxLevel = levels - 1 + minLevel;
        const { name, address } = placeFromElement(element);

        return { outline, levels, minLevel, maxLevel, name, address };
    }

    function buildingFromResponse(data, spec) {
        const element =
            spec.type === "auto"
                ? pickBuildingElement(data?.elements, spec.id)
                : elementFromResponse(data, spec);
        return buildingFromElement(element);
    }

    async function fetchOutline(spec) {
        if (!spec?.id || !spec?.type) return null;

        if (spec.type !== "way" && spec.type !== "relation" && spec.type !== "auto") {
            throw new Error(`Nieobsługiwany typ OSM: ${spec.type}`);
        }

        const query = buildOverpassQuery(spec.type, spec.id);
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

        const data = await response.json();
        const building = buildingFromResponse(data, spec);

        if (!building) {
            throw new Error("Brak geometrii obrysu w odpowiedzi Overpass");
        }

        return building;
    }

    async function resolve() {
        const spec = parseOsmFromPage();
        if (!spec) return null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const building = await fetchOutline(spec);
                if (building) return building;
            } catch (error) {
                if (attempt === 0) {
                    await new Promise((r) => setTimeout(r, 600));
                    continue;
                }
                console.warn("[TupTup] Nie udało się pobrać danych budynku z Overpass:", error);
            }
        }

        return null;
    }

    global.TupTupBuildingOutline = {
        FALLBACK_LEVELS: FALLBACK_BUILDING_LEVELS,
        OVERPASS_URL,
        parseOsmSpec,
        parseOsmFromUrl,
        parseOsmFromPage,
        levelsFromElement,
        nameFromTags,
        addressFromTags,
        placeFromElement,
        fetchOutline,
        resolve,
    };
})(window);
