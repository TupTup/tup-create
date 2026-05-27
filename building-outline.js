(function (global) {
    const OVERPASS_ENDPOINTS = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ];
    const OVERPASS_URL = OVERPASS_ENDPOINTS[0];
    const OVERPASS_MIN_GAP_MS = 1100;

    let overpassQueue = Promise.resolve();
    let overpassLastDoneAt = 0;

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

    function buildEntrancesOverpassQuery(type, id) {
        const osmType = type === "relation" ? "relation" : "way";
        return `[out:json][timeout:25];${osmType}(${id});node["entrance"](around:10);out geom;`;
    }

    function entrancesFromResponse(data) {
        const elements = data?.elements;
        if (!Array.isArray(elements)) return [];

        const seen = new Set();
        const entrances = [];
        for (const el of elements) {
            if (el.type !== "node" || el.lat == null || el.lon == null) continue;
            if (!el.tags?.entrance) continue;
            const key = String(el.id);
            if (seen.has(key)) continue;
            seen.add(key);
            entrances.push({
                id: el.id,
                lat: el.lat,
                lng: el.lon,
                entrance: el.tags.entrance,
            });
        }
        return entrances;
    }

    const EXCLUDED_BUILDING_VALUES = new Set(["part", "roof"]);

    function hasBuildingTag(tags) {
        if (!tags) return false;
        if (tags.building) return true;
        return tags.type === "multipolygon" && tags.building !== undefined;
    }

    function isPrimaryNonBuildingFeature(tags) {
        if (!tags) return false;
        if (hasBuildingTag(tags)) return false;
        return Boolean(
            tags.landuse || tags.amenity || tags.parking || tags.highway || tags.indoor
        );
    }

    function isExcludedOutlineElement(element) {
        const tags = element?.tags;
        if (!tags) return false;
        const building = tags.building;
        if (building && EXCLUDED_BUILDING_VALUES.has(String(building).toLowerCase())) {
            return true;
        }
        return isPrimaryNonBuildingFeature(tags);
    }

    function isBuildingPartElement(element) {
        const building = element?.tags?.building;
        return building != null && String(building).toLowerCase() === "part";
    }

    function isFullBuildingElement(element) {
        if (!element || (element.type !== "way" && element.type !== "relation")) return false;
        if (!hasBuildingTag(element.tags)) return false;
        if (isExcludedOutlineElement(element)) return false;
        return Boolean(outlineFromElement(element));
    }

    function hasUsableOutline(element) {
        const outline = outlineFromElement(element);
        return Boolean(outline && outline.length >= 3);
    }

    /** Geometria z żądanego osm_id, gdy brak tagu building (np. sam `out geom` z Overpass). */
    function isGeometryOutlineFallback(element) {
        if (!element || (element.type !== "way" && element.type !== "relation")) return false;
        if (isExcludedOutlineElement(element) || isPrimaryNonBuildingFeature(element?.tags)) {
            return false;
        }
        return hasUsableOutline(element);
    }

    function isBuildingElement(element) {
        return (
            isFullBuildingElement(element) ||
            isBuildingPartElement(element) ||
            isGeometryOutlineFallback(element)
        );
    }

    function outlineVertexCount(element) {
        const outline = outlineFromElement(element);
        return outline?.length ?? 0;
    }

    function outlineAreaOfElement(element) {
        const outline = outlineFromElement(element);
        return outline ? ringArea(outline) : 0;
    }

    function buildingCandidateScore(element, { allowPart = false, allowGeometry = false } = {}) {
        if (!element) return -1;
        const full = isFullBuildingElement(element);
        const part = isBuildingPartElement(element);
        const geometry = isGeometryOutlineFallback(element);
        if (!full && !(allowPart && part) && !(allowGeometry && geometry)) return -1;

        let score = 0;
        if (element.type === "way") score += 1000;
        if (element.type === "relation") score += 100;
        if (full) score += 500;
        if (part) score += 50;
        if (geometry) score += 30;

        score += Math.log10(outlineAreaOfElement(element) + 1) * 40;
        score += Math.max(0, 120 - outlineVertexCount(element));
        return score;
    }

    function pickBuildingElement(elements, id) {
        if (!Array.isArray(elements) || !elements.length) return null;

        const matches = elements.filter(
            (el) =>
                (el.type === "way" || el.type === "relation") && String(el.id) === String(id)
        );
        if (!matches.length) return null;

        const full = matches.filter(isFullBuildingElement);
        const parts = matches.filter(isBuildingPartElement);
        const pool = full.length
            ? full
            : parts.length
              ? parts
              : matches.filter(isGeometryOutlineFallback);
        if (!pool.length) return null;

        const scoreOpts = {
            allowPart: !full.length,
            allowGeometry: !full.length && !parts.length,
        };

        return pool.reduce((best, el) =>
            buildingCandidateScore(el, scoreOpts) > buildingCandidateScore(best, scoreOpts)
                ? el
                : best
        );
    }

    function selectionMetaForElement(element, { spec, candidates = [] } = {}) {
        const osm_type = element.type;
        const osm_id = element.id;
        const full = isFullBuildingElement(element);
        const partOnly = !full && isBuildingPartElement(element);
        const ways = candidates.filter((el) => el.type === "way" && isFullBuildingElement(el));
        const relations = candidates.filter(
            (el) => el.type === "relation" && isFullBuildingElement(el)
        );

        if (spec?.type === "way") {
            return {
                osm_type,
                osm_id,
                source_reason: "explicit way request",
                confidence: full ? 0.94 : 0.5,
            };
        }
        if (spec?.type === "relation") {
            return {
                osm_type,
                osm_id,
                source_reason: "explicit relation request",
                confidence: full ? 0.9 : 0.5,
            };
        }
        if (partOnly) {
            return {
                osm_type,
                osm_id,
                source_reason: "building part fallback",
                confidence: 0.55,
            };
        }
        if (!full && hasUsableOutline(element)) {
            return {
                osm_type,
                osm_id,
                source_reason: "geometry outline fallback",
                confidence: 0.65,
            };
        }
        if (element.type === "way" && ways.length === 1 && !relations.length) {
            return {
                osm_type,
                osm_id,
                source_reason: "single building polygon",
                confidence: 0.97,
            };
        }
        if (element.type === "way" && relations.length) {
            return {
                osm_type,
                osm_id,
                source_reason: "way preferred over relation",
                confidence: 0.88,
            };
        }
        if (element.type === "relation") {
            return {
                osm_type,
                osm_id,
                source_reason: "multipolygon building outline",
                confidence: relations.length && !ways.length ? 0.82 : 0.75,
            };
        }
        return {
            osm_type,
            osm_id,
            source_reason: "building outline",
            confidence: 0.7,
        };
    }

    function outlineFromWay(element) {
        return geometryToOutline(element.geometry);
    }

    function coordKey([lat, lon]) {
        return `${lat.toFixed(7)},${lon.toFixed(7)}`;
    }

    function ringIsClosed(ring) {
        if (!ring || ring.length < 4) return false;
        const first = ring[0];
        const last = ring[ring.length - 1];
        return coordKey(first) === coordKey(last);
    }

    function closeRing(ring) {
        if (!ring || ring.length < 3) return null;
        if (ringIsClosed(ring)) return ring;
        return [...ring, ring[0]];
    }

    function appendSegment(ring, segment, reverse) {
        const coords = reverse ? [...segment].reverse() : segment;
        const start = ring.length ? ring.length - 1 : 0;
        for (let i = 0; i < coords.length; i += 1) {
            if (start === 0 && i === 0) {
                ring.push(coords[i]);
                continue;
            }
            if (i === 0 && coordKey(ring[ring.length - 1]) === coordKey(coords[0])) continue;
            ring.push(coords[i]);
        }
        return ring;
    }

    function assembleRingFromSegments(segments) {
        const remaining = segments
            .map((segment) => segment.filter(Boolean))
            .filter((segment) => segment.length >= 2)
            .map((segment) => segment.slice());

        if (!remaining.length) return null;
        if (remaining.length === 1) return closeRing(remaining[0]);

        const ring = [];
        let current = remaining.shift();
        appendSegment(ring, current, false);

        while (remaining.length) {
            const tail = coordKey(ring[ring.length - 1]);
            let merged = false;

            for (let i = 0; i < remaining.length; i += 1) {
                const segment = remaining[i];
                const head = coordKey(segment[0]);
                const end = coordKey(segment[segment.length - 1]);

                if (tail === head) {
                    appendSegment(ring, segment, false);
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }
                if (tail === end) {
                    appendSegment(ring, segment, true);
                    remaining.splice(i, 1);
                    merged = true;
                    break;
                }
            }

            if (merged) continue;

            const largest = remaining.reduce(
                (best, segment) => (segment.length > best.length ? segment : best),
                remaining[0]
            );
            remaining.splice(remaining.indexOf(largest), 1);
            appendSegment(ring, largest, false);
        }

        return closeRing(ring);
    }

    function outerRingsFromRelation(element) {
        const rings = [];

        if (Array.isArray(element.members)) {
            const outerSegments = [];
            for (const member of element.members) {
                if (member.role === "inner") continue;
                if (member.type !== "way" || !member.geometry) continue;
                const segment = geometryToOutline(member.geometry);
                if (segment) outerSegments.push(segment);
            }

            const assembled = assembleRingFromSegments(outerSegments);
            if (assembled) rings.push(assembled);

            for (const segment of outerSegments) {
                const closed = closeRing(segment);
                if (closed) rings.push(closed);
            }
        }

        if (element.geometry) {
            const ring = geometryToOutline(element.geometry);
            if (ring) rings.push(ring);
        }

        const unique = [];
        const seen = new Set();
        for (const ring of rings) {
            if (!ring || ring.length < 3) continue;
            const key = ring.map(coordKey).join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(ring);
        }

        return unique;
    }

    function outlineFromRelation(element) {
        const rings = outerRingsFromRelation(element);
        if (rings.length) return pickLargestRing(rings);
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

    function buildingFromElement(element, metaContext = {}) {
        const outline = outlineFromElement(element);
        if (!outline || outline.length < 3) return null;

        const { levels, minLevel } = levelsFromElement(element);
        const maxLevel = levels - 1 + minLevel;
        const { name, address } = placeFromElement(element);
        const selection = selectionMetaForElement(element, metaContext);

        return {
            outline,
            levels,
            minLevel,
            maxLevel,
            name,
            address,
            osm_type: selection.osm_type,
            osm_id: selection.osm_id,
            source_reason: selection.source_reason,
            confidence: selection.confidence,
        };
    }

    function buildingFromResponse(data, spec) {
        const elements = data?.elements;
        const candidates = Array.isArray(elements)
            ? elements.filter((el) => el.type === "way" || el.type === "relation")
            : [];

        let element =
            spec.type === "auto"
                ? pickBuildingElement(elements, spec.id)
                : elementFromResponse(data, spec);

        if (element && !isBuildingElement(element)) {
            element = null;
        }

        return buildingFromElement(element, { spec, candidates });
    }

    function overpassRetryDelayMs(response, attempt) {
        const retryAfter = response
            ? Number.parseInt(response.headers.get("Retry-After"), 10)
            : Number.NaN;
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
            return retryAfter * 1000;
        }
        return 1500 * (attempt + 1);
    }

    async function postOverpassOnce(url, query) {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                "User-Agent": "TupTup/1.0 (delivery-map; contact@tuptup.github.io)",
            },
            body: `data=${encodeURIComponent(query)}`,
        });

        if (response.status === 429 || response.status === 503 || response.status === 504) {
            const error = new Error(`Overpass HTTP ${response.status}`);
            error.retryable = true;
            error.retryDelayMs = overpassRetryDelayMs(response, 0);
            throw error;
        }

        if (!response.ok) {
            throw new Error(`Overpass HTTP ${response.status}`);
        }

        return response.json();
    }

    async function runPostOverpass(query) {
        const waitForGap = overpassLastDoneAt + OVERPASS_MIN_GAP_MS - Date.now();
        if (waitForGap > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitForGap));
        }

        let lastError = null;

        for (const url of OVERPASS_ENDPOINTS) {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                    const data = await postOverpassOnce(url, query);
                    overpassLastDoneAt = Date.now();
                    return data;
                } catch (error) {
                    lastError = error;
                    if (!error.retryable || attempt >= 2) break;
                    await new Promise((resolve) =>
                        setTimeout(resolve, error.retryDelayMs || overpassRetryDelayMs(null, attempt))
                    );
                }
            }
        }

        throw lastError || new Error("Overpass request failed");
    }

    function postOverpass(query) {
        const task = overpassQueue.then(() => runPostOverpass(query));
        overpassQueue = task.catch(() => {});
        return task;
    }

    async function fetchOutline(spec) {
        if (!spec?.id || !spec?.type) return null;

        if (spec.type !== "way" && spec.type !== "relation" && spec.type !== "auto") {
            throw new Error(`Nieobsługiwany typ OSM: ${spec.type}`);
        }

        const query = buildOverpassQuery(spec.type, spec.id);
        const data = await postOverpass(query);
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

    async function fetchEntrances(osmType, osmId) {
        if (!osmId || (osmType !== "way" && osmType !== "relation")) return [];

        const query = buildEntrancesOverpassQuery(osmType, osmId);
        const data = await postOverpass(query);
        return entrancesFromResponse(data);
    }

    global.TupTupBuildingOutline = {
        FALLBACK_LEVELS: FALLBACK_BUILDING_LEVELS,
        OVERPASS_URL,
        OVERPASS_ENDPOINTS,
        postOverpass,
        parseOsmSpec,
        parseOsmFromUrl,
        parseOsmFromPage,
        levelsFromElement,
        nameFromTags,
        addressFromTags,
        placeFromElement,
        isFullBuildingElement,
        pickBuildingElement,
        selectionMetaForElement,
        buildEntrancesOverpassQuery,
        entrancesFromResponse,
        fetchOutline,
        fetchEntrances,
        resolve,
    };
})(window);
