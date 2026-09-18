/* MeteoRisk shared frontend country and public-data configuration. */
(function () {
    "use strict";
    const registry = window.METEORISK_COUNTRY_REGISTRY;
    if (!registry || !registry.countries) throw new Error("MeteoRisk country registry is unavailable");
    const requested = new URLSearchParams(window.location.search).get("country");
    const normalized = String(requested || registry.default_country || "RS").toUpperCase();
    const countryCode = registry.countries[normalized] ? normalized : registry.default_country;
    const country = registry.countries[countryCode];

    function dataPath(relativePath) {
        let relative = String(relativePath || "");
        while (relative.startsWith("/")) relative = relative.slice(1);
        return country.data_root + (relative ? "/" + relative : "");
    }

    function adminUnitName(properties, language) {
        const source = properties || {};
        const names = country.name_columns || {};
        const columns = language === "en"
            ? [names.en, names.local, names.local_latin, names.local_cyrillic]
            : [names.local_cyrillic, names.local, names.local_latin, names.en];
        for (const column of columns.filter(Boolean)) {
            const value = source[column];
            if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
        }
        return "—";
    }

    function adminUnitId(properties) {
        const source = properties || {};
        const value = source[country.id_column];
        return value === null || value === undefined ? "" : String(value).trim();
    }

    function adminUnitMatchName(properties) {
        const source = properties || {};
        const names = country.name_columns || {};
        const columns = [names.local_cyrillic, names.local, names.local_latin, names.en];
        for (const column of columns.filter(Boolean)) {
            const value = source[column];
            if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
        }
        return "";
    }

    function localDateKey(isoString) {
        if (!isoString) return null;
        const date = new Date(isoString);
        if (!Number.isFinite(date.getTime())) return null;
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: country.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).formatToParts(date);
        const values = {};
        parts.forEach(part => {
            if (part.type !== "literal") values[part.type] = part.value;
        });
        return `${values.year}-${values.month}-${values.day}`;
    }

    const bounds = country.geometry_bounds;
    if (!Array.isArray(bounds) || bounds.length !== 4) throw new Error("Invalid geometry bounds for " + countryCode);
    const mapBounds = Object.freeze([
        Object.freeze([bounds[1], bounds[0]]),
        Object.freeze([bounds[3], bounds[2]])
    ]);
    const mapCenter = Object.freeze([(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2]);
    const span = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
    const initialZoom = span > 8 ? 5 : span > 5 ? 6 : span > 2.5 ? 7 : 8;

    window.MeteoRiskConfig = Object.freeze({
        registry,
        countryCode,
        country,
        timezone: country.timezone,
        dataPath,
        adminPath: country.public_admin_file,
        adminUnitName,
        adminUnitId,
        adminUnitMatchName,
        localDateKey,
        mapBounds,
        mapCenter,
        initialZoom,
        minZoom: Math.max(4, initialZoom - 1),
        maxZoom: 19
    });
})();
