/* ============================================================
   CONFIG
   ============================================================ */

const FORECAST_HOURS =
    Array.from(
        { length: 40 },
        (_, i) => (i + 1) * 3
    );

const GEOMETRY_FILE =
    window.MeteoRiskConfig.adminPath;

const HAZARD_INFO_FILE =
    "data/hazard_info.json";

const GEFS_DIR =
    "data/gefs";

const METEORISK_TIME_ZONE =
    window.MeteoRiskConfig.country.timezone;

/*
   Europe/Belgrade is an IANA time-zone identifier, not a fixed UTC offset.
   Intl.DateTimeFormat therefore applies CET/CEST automatically.

   Self-check below guards both 2026 DST transitions:
   spring: +01 -> +02
   autumn: +02 -> +01
*/
function meteoriskTimeZoneOffsetMinutes(isoString) {
    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: METEORISK_TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }
    ).formatToParts(date);

    const values = {};
    parts.forEach(part => {
        if (part.type !== "literal") {
            values[part.type] = part.value;
        }
    });

    const localAsUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second)
    );

    return Math.round(
        (localAsUtc - date.getTime())
        / (60 * 1000)
    );
}

function meteoriskDstSelfCheck() {
    const offsets = {
        springBefore:
            meteoriskTimeZoneOffsetMinutes(
                "2026-03-29T00:30:00Z"
            ),
        springAfter:
            meteoriskTimeZoneOffsetMinutes(
                "2026-03-29T01:30:00Z"
            ),
        autumnBefore:
            meteoriskTimeZoneOffsetMinutes(
                "2026-10-25T00:30:00Z"
            ),
        autumnAfter:
            meteoriskTimeZoneOffsetMinutes(
                "2026-10-25T01:30:00Z"
            )
    };

    const ok = (
        offsets.springBefore === 60
        && offsets.springAfter === 120
        && offsets.autumnBefore === 120
        && offsets.autumnAfter === 60
    );

    if (ok) {
        console.info(
            "MeteoRisk DST QC PASS",
            METEORISK_TIME_ZONE,
            offsets
        );
    } else {
        console.warn(
            "MeteoRisk DST QC WARNING",
            METEORISK_TIME_ZONE,
            offsets
        );
    }

    return ok;
}

meteoriskDstSelfCheck();

/* MeteoRisk STORMS multimodel.
   The existing five-day frontend (+003 to +120 h) is preserved.
   In the current development phase the final multimodel STORMS product
   exists for the first 24 hours at 3-hour intervals. After +024 h the
   existing GEFS products remain available until the multimodel horizon
   is extended. */
const MULTIMODEL_STORMS_FILES = {
     3: "data/multimodel/storms_f003.csv",
     6: "data/multimodel/storms_f006.csv",
     9: "data/multimodel/storms_f009.csv",
    12: "data/multimodel/storms_f012.csv",
    15: "data/multimodel/storms_f015.csv",
    18: "data/multimodel/storms_f018.csv",
    21: "data/multimodel/storms_f021.csv",
    24: "data/multimodel/storms_f024.csv"
};

let multimodelStormsCache = {};



let timelineSlots = [];
let timelineSlotIndex = 0;


/* ============================================================
   STATE
   ============================================================ */

let currentLanguage = "sr";
let currentHazard = "overall_risk";

/* Active top-level module when the user clicks OLUJA / VETAR / TEMPERATURA.
   null means the central overall-risk view across all modules. */
let currentModule = null;

/* UI is not considered ready until forecast data and the map layer are both
   initialized. This prevents false "unavailable" labels during first paint. */
let appReady = false;

/* ============================================================
   CENTRAL HAZARD/MODULE REGISTRY
   ------------------------------------------------------------
   New modules should be added here once. The rest of the UI should read
   module membership, availability and module-level risk from this registry.
   Individual parameters remain selectable inside each module.
   ============================================================ */
const HAZARD_MODULES = {
    storm: {
        labelElementId: "storm-group-label",
        /* Public UI: ONE combined OLUJA risk.
           Component hazards remain expert diagnostics only. */
        parameters: [],
        available: () => Boolean(
            currentModelData
            && currentModelData.storms_available
        ),
        riskLevel: data => stormRiskLevel(data)
    },

    wind: {
        labelElementId: "wind-group-label",
        parameters: ["wind_risk_level"],
        available: () => Boolean(
            currentModelData
            && currentModelData.wind_available
        ),
        riskLevel: data => windRiskLevel(data)
    },

    temperature: {
        labelElementId: "temperature-group-label",
        parameters: ["max_temperature", "heat_stress"],
        available: () => Boolean(
            currentModelData
            && currentModelData.temperature_available
        ),
        riskLevel: data => Math.max(
            temperatureRiskLevel(data),
            heatStressRiskLevel(data)
        )
    },

    fire: {
        labelElementId: "fire-group-label",
        parameters: ["fire_hdw"],
        available: () => Boolean(
            currentModelData
            && currentModelData.fire_available
        ),
        riskLevel: data => fireHdwRiskLevel(data)
    },

    air_quality: {
        labelElementId: "air-quality-group-label",
        parameters: ["air_pm25", "air_pm10", "air_o3"],
        available: () => Boolean(
            currentModelData
            && currentModelData.air_quality_available
        ),
        riskLevel: data => airQualityRiskLevel(data)
    },

    uv: {
        labelElementId: "uv-group-label",
        parameters: [],
        available: () => Boolean(
            currentModelData
            && currentModelData.uv_available
        ),
        riskLevel: data => uvRiskLevel(data)
    }
};

function moduleForParameter(parameter) {
    for (const [moduleKey, config] of Object.entries(HAZARD_MODULES)) {
        if (config.parameters.includes(parameter)) {
            return moduleKey;
        }
    }
    return null;
}

function moduleRiskLevel(data, moduleKey) {
    const config = HAZARD_MODULES[moduleKey];
    return config ? config.riskLevel(data) : 0;
}

function moduleAvailable(moduleKey) {
    const config = HAZARD_MODULES[moduleKey];
    return Boolean(config && config.available());
}

function moduleDataAvailable(data, moduleKey) {
    if (!data) return false;

    if (moduleKey === "temperature") {
        return Boolean(data.temperature_multimodel || data.heat_stress_multimodel);
    }

    if (moduleKey === "fire") {
        return Boolean(data.fire_hdw_available);
    }

    if (moduleKey === "air_quality") {
        return Boolean(data.air_quality_available);
    }

    if (moduleKey === "uv") {
        return Boolean(data.uv_available);
    }

    if (moduleKey === "storm") {
        return Boolean(data.storms_multimodel);
    }

    if (moduleKey === "wind") {
        return Boolean(
            currentModelData?.wind_available
            && typeof windV2DataAvailable === "function"
            && windV2DataAvailable(data)
        );
    }

    return false;
}

function anyModuleDataAvailable(data) {
    return Object.keys(HAZARD_MODULES).some(
        moduleKey => moduleDataAvailable(data, moduleKey)
    );
}

let currentTimeIndex = 0;

let currentForecastHour =
    FORECAST_HOURS[0];

let currentModelData = null;

let geometryData = null;

let hazardInfo = null;

let geojsonLayer = null;

let selectedMunicipalityId = null;

let selectedLayer = null;

let locationMarker = null;

let playTimer = null;

let isPlaying = false;

let allForecastData = null;
let overviewFeature = null;
let overviewShowAll = false;
let overviewSelectedDate = null;

/*
   FIVE-DAY OVERVIEW PERFORMANCE CACHE

   The public timeline/data are static for the lifetime of one page load.
   Therefore the fully merged timeline can be cached after the first build.

   - slot cache: prevents rebuilding an already merged 3-hour term
   - build promise: prevents duplicate simultaneous 5-day builds
   - overview cache: makes calendar/date/language re-rendering immediate
*/
const OVERVIEW_LOAD_CONCURRENCY = 6;

const timelineSlotDataCache = new Map();
const timelineSlotBuildPromiseCache = new Map();

let timelineOverviewDataCache = null;
let timelineOverviewBuildPromise = null;


function resetTimelineOverviewCache() {
    timelineSlotDataCache.clear();
    timelineSlotBuildPromiseCache.clear();
    timelineOverviewDataCache = null;
    timelineOverviewBuildPromise = null;
}

/* User-facing forecast cycle reference.
   It is derived from the multimodel reference date and normalized to 00 UTC,
   so valid times are shown as +003, +006, ... relative to that common cycle,
   regardless of the underlying GEFS lead used internally. */
let displayReferenceRun = null;


/* ============================================================
   TRANSLATIONS
   ============================================================ */

const translations = {

    sr: {

        title:
            "Интерактивни приказ метеоролошких ризика по јединицама локалне самоуправе у Републици Србији",

        model:
            "Пробабилистички мултимодел систем",

        updated:
            "Последње ажурирање података",

        search:
            "Претражи општину...",

        location:
            "📍 Моја локација",

        pdf:
            "📄 Сачувај као PDF",

        share:
            "↗ Подели",

        thunder:
            "⚡ Грмљавина",

        hail:
            "🧊 Ризик од града",

        largeHail:
            "🧊 Ризик од крупног града (≥ 2 cm)",

        veryLargeHail:
            "🧊 Ризик од веома крупног града (≥ 5 cm)",

        valid:
            "Важи за",

        lead:
            "Прогностички рок",

        legend:
            "Ансамбл сигнал",

        modelParameters:
            "Параметри модела",

        instability:
            "Нестабилност (CAPE)",

        shear:
            "Смицање ветра (850–500 hPa)",

        humidity:
            "Релативна влажност (700 hPa)",

        grid:
            "Број GEFS grid тачака",

        disclaimer:
            "Експериментални независни производ заснован на јавно доступним open-data моделским подацима — није званично упозорење РХМЗ-а.",

        notFound:
            "Општина није пронађена.",

        loadError:
            "Није могуће учитати податке за овај термин.",

        locationSearching:
            "Одређујем вашу локацију...",

        locationDenied:
            "Приступ локацији није дозвољен.",

        locationUnavailable:
            "Тренутну локацију није могуће одредити.",

        locationTimeout:
            "Одређивање локације је предуго трајало.",

        municipalityLocated:
            "Пронађена општина",

        shareTitle:
            "Интерактивни приказ метеоролошких ризика",

        stormGroup:
            "⛈ ОЛУЈА",

        windGroup: "💨 ВЕТАР",
        temperatureGroup: "🌡 ТЕМПЕРАТУРА",
        maxTemperature: "🌡 Максимална температура",
        heatStress: "🔥 Топлотни стрес",
        fireGroup: "🔥 ПОЖАРИ",
        fireDanger: "🔥 Пожарна опасност",
        fireSpread: "💨 Потенцијал брзог ширења",
        fireCategory: "Категорија пожарне опасности",
        fireHdwCategory: "Категорија атмосферског сигнала",
        airQualityGroup: "🌫 КВАЛИТЕТ ВАЗДУХА",
        airPm25: "PM2.5",
        airPm10: "PM10",
        airOzone: "O₃",
        airEuropeanAqi: "Европски индекс квалитета ваздуха",
        airDominant: "Доминантни загађивач",
        airDust: "Минерална прашина",
        uvGroup: "☀️ UV ИНДЕКС",
        uvIndex: "UV индекс",
        temperatureCategory: "Категорија",
        mostLikelyCategory: "Највероватнија категорија",
        warmestPeriod: "Најтоплији део дана",
        multimodelTmax: "Мултимодел Tmax",
        categoryProbability: "Вероватноћа категорије",
        impacts: "Могући утицаји",
        recommendations: "Препоруке",
        notAvailableForTime: "Није доступно за изабрани термин",
        available: "доступно",
        unavailable: "није доступно",
        windOverall: "Ризик од ветра",

        overviewTitle:
            "Преглед ризика за наредних 5 дана",

        showAllRisks:
            "Прикажи и појаве без значајног ризика",

        noSignificantSignal:
            "Нема значајног сигнала (≥10%).",

        maxSignal:
            "Максимални ансамбл сигнал",

        loadingOverview:
            "Учитавање петодневног прегледа...",

        riskNote:
            "Утицаји и препоруке односе се на случај да се прогнозирана појава реализује.",

        allFiveDays:
            "Свих 5 дана",

        selectedDay:
            "Изабрани дан",

        multimodelThunder:
            "Мултимоделска процена грмљавине",

        risk:
            "Ризик",

        confidence:
            "Поузданост",

        localSupport:
            "Локална просторна подршка",

        dominantModel:
            "Доминантни модел",

        modelSignals:
            "Сигнали модела",

        modelDisagreement:
            "Неслагање модела",

        riskLevels:
            ["без значајног ризика", "низак", "умерен", "висок", "веома висок"]
    },


    en: {

        title:
            "Interactive Weather Risk Map by Local Government Units in the Republic of Serbia",

        model:
            "Probabilistic multimodel system",

        updated:
            "Last data update",

        search:
            "Search municipality...",

        location:
            "📍 My location",

        pdf:
            "📄 Save as PDF",

        share:
            "↗ Share",

        thunder:
            "⚡ Thunderstorm",

        hail:
            "🧊 Hail risk",

        largeHail:
            "🧊 Large hail risk (≥ 2 cm)",

        veryLargeHail:
            "🧊 Very large hail risk (≥ 5 cm)",

        valid:
            "Valid",

        lead:
            "Lead time",

        legend:
            "Ensemble signal",

        modelParameters:
            "Model parameters",

        instability:
            "Instability (CAPE)",

        shear:
            "Wind shear (850–500 hPa)",

        humidity:
            "Relative humidity (700 hPa)",

        grid:
            "Number of GEFS grid points",

        disclaimer:
            "Independent experimental product based on publicly available open-data model data — not an official RHMZ warning.",

        notFound:
            "Municipality not found.",

        loadError:
            "Data for this forecast time could not be loaded.",

        locationSearching:
            "Determining your location...",

        locationDenied:
            "Location access was denied.",

        locationUnavailable:
            "Current location could not be determined.",

        locationTimeout:
            "Location request timed out.",

        municipalityLocated:
            "Municipality found",

        shareTitle:
            "Interactive Weather Risk Map",

        stormGroup:
            "⛈ STORM",

        windGroup: "💨 WIND",
        temperatureGroup: "🌡 TEMPERATURE",
        maxTemperature: "🌡 Maximum temperature",
        heatStress: "🔥 Heat stress",
        fireGroup: "🔥 FIRES",
        fireDanger: "🔥 Fire danger",
        fireSpread: "💨 Rapid-spread potential",
        fireCategory: "Fire-danger category",
        fireHdwCategory: "Atmospheric-signal category",
        airQualityGroup: "🌫 AIR QUALITY",
        airPm25: "PM2.5",
        airPm10: "PM10",
        airOzone: "O₃",
        airEuropeanAqi: "European Air Quality Index",
        airDominant: "Dominant pollutant",
        airDust: "Mineral dust",
        uvGroup: "☀️ UV INDEX",
        uvIndex: "UV index",
        temperatureCategory: "Category",
        mostLikelyCategory: "Most likely category",
        warmestPeriod: "Warmest part of day",
        multimodelTmax: "Multimodel Tmax",
        categoryProbability: "Category probability",
        impacts: "Possible impacts",
        recommendations: "Recommendations",
        notAvailableForTime: "Not available for the selected time",
        available: "available",
        unavailable: "not available",
        windOverall: "Wind risk",

        overviewTitle:
            "Risk overview for the next 5 days",

        showAllRisks:
            "Show hazards without a significant risk",

        noSignificantSignal:
            "No significant signal (≥10%).",

        maxSignal:
            "Maximum ensemble signal",

        loadingOverview:
            "Loading five-day overview...",

        riskNote:
            "Impacts and recommendations apply if the forecast event occurs.",

        allFiveDays:
            "All 5 days",

        selectedDay:
            "Selected day",

        multimodelThunder:
            "Multimodel thunderstorm assessment",

        risk:
            "Risk",

        confidence:
            "Confidence",

        localSupport:
            "Local spatial support",

        dominantModel:
            "Dominant model",

        modelSignals:
            "Model signals",

        modelDisagreement:
            "Model disagreement",

        riskLevels:
            ["no significant risk", "low", "moderate", "high", "very high"]
    }

};


/* ============================================================
   MAP
   ============================================================ */

/*
   Central map-view configuration.
   Keep this country-specific in one place so a future country selector can
   switch center/zoom/bounds without rewriting map logic.
*/
const MAP_VIEW_CONFIG = Object.freeze({
    countryCode: window.MeteoRiskConfig.countryCode,
    center: window.MeteoRiskConfig.mapCenter,
    initialZoom: window.MeteoRiskConfig.initialZoom,
    minZoom: window.MeteoRiskConfig.minZoom,
    maxZoom: window.MeteoRiskConfig.maxZoom,
    maxBounds: window.MeteoRiskConfig.mapBounds,
    municipalitySearchMaxZoom: 11,
    geolocationZoom: 10
});


const map =
    L.map(
        "map",
        {
            zoomControl: true,

            minZoom:
                MAP_VIEW_CONFIG.minZoom,

            maxZoom:
                MAP_VIEW_CONFIG.maxZoom,

            maxBounds:
                MAP_VIEW_CONFIG.maxBounds,

            /*
               1.0 makes the outer navigation bounds firm instead of letting
               touch/mouse dragging pull the map far outside the allowed area.
            */
            maxBoundsViscosity: 1.0
        }
    )
    .setView(
        MAP_VIEW_CONFIG.center,
        MAP_VIEW_CONFIG.initialZoom
    );


L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom:
            MAP_VIEW_CONFIG.maxZoom,

        attribution:
            "&copy; OpenStreetMap contributors"
    }
).addTo(map);


/* ============================================================
   UTILITIES
   ============================================================ */

function forecastFile(hour) {

    return (
        GEFS_DIR
        + "/f"
        + String(hour).padStart(3, "0")
        + ".json"
    );
}


/* ============================================================
   REAL-TIME START POSITION
   ============================================================ */

async function initialForecastIndexFromCurrentTime() {

    let firstValidTime = null;

    try {
        const rowsByName = await loadMultimodelStormsRows(
            FORECAST_HOURS[0]
        );

        if (rowsByName && rowsByName.size > 0) {
            const firstRow = rowsByName.values().next().value;
            const validText = firstRow ? firstRow.valid_time : null;
            const parsed = validText ? new Date(validText) : null;

            if (parsed && Number.isFinite(parsed.getTime())) {
                firstValidTime = parsed;
            }
        }
    } catch (error) {
        console.warn(
            "Could not determine initial time from multimodel metadata.",
            error
        );
    }

    if (!firstValidTime) {
        try {
            const response = await fetch(
                forecastFile(FORECAST_HOURS[0]),
                { cache: "no-store" }
            );

            if (response.ok) {
                const data = await response.json();
                const parsed = data.valid_time
                    ? new Date(data.valid_time)
                    : null;

                if (parsed && Number.isFinite(parsed.getTime())) {
                    firstValidTime = parsed;
                }
            }
        } catch (error) {
            console.warn(
                "Could not determine initial time from GEFS metadata.",
                error
            );
        }
    }

    if (!firstValidTime) {
        return 0;
    }

    const now = new Date();
    const stepMs = 3 * 60 * 60 * 1000;

    const rawIndex = Math.ceil(
        (now.getTime() - firstValidTime.getTime())
        / stepMs
    );

    return Math.max(
        0,
        Math.min(
            rawIndex,
            FORECAST_HOURS.length - 1
        )
    );
}


function municipalityId(properties) {

    return String(
        properties.Municipality_DOM_ID
    );
}


function getMunicipalityData(
    properties
) {

    if (!currentModelData) {
        return null;
    }

    const id =
        municipalityId(
            properties
        );

    return (
        currentModelData
        .municipalities[id]
        || null
    );
}


function municipalityName(
    properties
) {
    return window.MeteoRiskConfig.adminUnitName(
        properties,
        currentLanguage
    );
}


function formatProbability(value) {

    if (
        value === null
        || value === undefined
        || !Number.isFinite(
            Number(value)
        )
    ) {
        return "—";
    }

    return (
        Number(value).toFixed(1)
        + "%"
    );
}


function formatNumber(
    value,
    decimals = 0
) {

    if (
        value === null
        || value === undefined
        || !Number.isFinite(
            Number(value)
        )
    ) {
        return "—";
    }

    return Number(value)
        .toFixed(decimals);
}


/* Convert CSV numeric text to number while preserving missing values.
   Number("") is 0 in JavaScript, which would incorrectly display a
   missing model (e.g. ICON at an unavailable valid time) as 0%. */

/* ============================================================
   USER-FIRST UX HELPERS
   ------------------------------------------------------------
   These helpers change presentation only. Risk levels still come from the
   existing hazard/module functions and the timeline remains authoritative.
   ============================================================ */

function riskLevelLabel(level) {
    const safe = Math.max(0, Math.min(4, Number(level) || 0));
    const sr = [
        "без значајног ризика",
        "низак ризик",
        "умерен ризик",
        "висок ризик",
        "веома висок ризик"
    ];
    const en = [
        "no significant risk",
        "low risk",
        "moderate risk",
        "high risk",
        "very high risk"
    ];
    return (currentLanguage === "sr" ? sr : en)[safe];
}

function riskSummaryHtml({
    title,
    level,
    category,
    value = "",
    impact = "",
    recommendation = "",
    meta = "",
    badge = "",
    available = true
}) {
    if (!available) {
        return `
            <div class="risk-summary-card risk-unavailable">
                <div class="risk-eyebrow">${title || ""}</div>
                <div class="risk-category">${translations[currentLanguage].notAvailableForTime}</div>
            </div>
        `;
    }

    const safeLevel = Math.max(0, Math.min(4, Number(level) || 0));
    return `
        <div class="risk-summary-card risk-level-${safeLevel}">
            <div class="risk-summary-top">
                <div>
                    <div class="risk-eyebrow">${title || ""}</div>
                    <div class="risk-category">${category || riskLevelLabel(safeLevel)}</div>
                </div>
                <span class="risk-badge">${badge || riskLevelLabel(safeLevel)}</span>
            </div>
            ${value ? `<div class="risk-primary-value">${value}</div>` : ""}
            ${meta ? `<div class="risk-meta">${meta}</div>` : ""}
            ${(impact || recommendation) ? `
                <div class="impact-action-grid">
                    ${impact ? `
                        <div class="impact-action-card">
                            <span class="impact-action-title">${translations[currentLanguage].impacts}</span>
                            ${impact}
                        </div>` : ""}
                    ${recommendation ? `
                        <div class="impact-action-card">
                            <span class="impact-action-title">${translations[currentLanguage].recommendations}</span>
                            ${recommendation}
                        </div>` : ""}
                </div>` : ""}
        </div>
    `;
}

function expertDetailsHtml(content, label = null) {
    if (!content) return "";
    const text = label || (currentLanguage === "sr" ? "Стручни детаљи" : "Technical details");
    return `
        <details class="expert-details">
            <summary>${text}</summary>
            <div class="expert-details-body">${content}</div>
        </details>
    `;
}

function legendUnavailableHtml() {
    return `
        <div class="legend-row">
            <span class="legend-box legend-unavailable"></span>
            ${currentLanguage === "sr" ? "нема података / није доступно" : "no data / unavailable"}
        </div>
    `;
}

function setActionButtonContent(elementId, icon, label) {
    const element = document.getElementById(elementId);
    if (!element) return;
    const clean = String(label || "")
        .replace(/^📍\s*/u, "")
        .replace(/^📄\s*/u, "")
        .replace(/^↗\s*/u, "");
    element.innerHTML = `<span class="action-icon" aria-hidden="true">${icon}</span><span class="action-label">${clean}</span>`;
    element.title = clean;
    element.setAttribute("aria-label", clean);
}

function optionalNumber(value) {
    if (
        value === null
        || value === undefined
        || String(value).trim() === ""
    ) {
        return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function translatedModelAvailability(sourceModels) {
    const text = String(sourceModels || "").trim();
    if (!text) return "—";
    return text;
}


function normalizeToUtcMidnight(dateValue) {
    const date = new Date(dateValue);

    if (!Number.isFinite(date.getTime())) {
        return null;
    }

    return new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0, 0, 0, 0
    ));
}

function timelineLeadHourForIndex(index) {
    if (!timelineSlots.length || !Number.isInteger(index)) return null;

    const slot = timelineSlots[index];
    if (!slot) return null;

    if (
        slot.kind === "forecast"
        && Number.isInteger(slot.data_index)
        && Number.isFinite(Number(FORECAST_HOURS[slot.data_index]))
    ) {
        return Number(FORECAST_HOURS[slot.data_index]);
    }

    const slotTime = new Date(slot.valid_time).getTime();
    if (!Number.isFinite(slotTime)) return null;

    // Prefer the nearest preceding real forecast slot.
    for (let i = index - 1; i >= 0; i -= 1) {
        const ref = timelineSlots[i];
        if (
            ref
            && ref.kind === "forecast"
            && Number.isInteger(ref.data_index)
            && Number.isFinite(Number(FORECAST_HOURS[ref.data_index]))
        ) {
            const refTime = new Date(ref.valid_time).getTime();
            if (!Number.isFinite(refTime)) break;
            const deltaHours = Math.round((slotTime - refTime) / (60 * 60 * 1000));
            return Math.max(0, Number(FORECAST_HOURS[ref.data_index]) + deltaHours);
        }
    }

    // If the first visible slot is timeline-only, derive it from the next real slot.
    for (let i = index + 1; i < timelineSlots.length; i += 1) {
        const ref = timelineSlots[i];
        if (
            ref
            && ref.kind === "forecast"
            && Number.isInteger(ref.data_index)
            && Number.isFinite(Number(FORECAST_HOURS[ref.data_index]))
        ) {
            const refTime = new Date(ref.valid_time).getTime();
            if (!Number.isFinite(refTime)) break;
            const deltaHours = Math.round((slotTime - refTime) / (60 * 60 * 1000));
            return Math.max(0, Number(FORECAST_HOURS[ref.data_index]) + deltaHours);
        }
    }

    /* OLUJA v2 can be newer than the legacy core GEFS web cache.
       Then every current/future slot may be timeline_only. Derive the
       lead directly from the validated OLUJA model run. */
    if (displayReferenceRun) {
        const runTime = new Date(displayReferenceRun).getTime();
        if (Number.isFinite(runTime)) {
            const lead = Math.round((slotTime - runTime) / (60 * 60 * 1000));
            if (lead >= 3 && lead <= 120 && lead % 3 === 0) {
                return lead;
            }
        }
    }

    return null;
}


function displayLeadHour(validTime) {
    if (
        currentForecastHour !== null
        && currentForecastHour !== undefined
        && String(currentForecastHour).trim() !== ""
        && Number.isFinite(Number(currentForecastHour))
    ) {
        return Number(currentForecastHour);
    }

    return null;
}

function formatLeadHour(validTime) {
    const hour = displayLeadHour(validTime);
    if (!Number.isFinite(hour)) return "—";

    return "+"
        + String(Math.max(0, hour)).padStart(3, "0")
        + " h";
}


/* ============================================================
   MULTIMODEL STORMS HELPERS
   ============================================================ */

function normalizeMunicipalityName(value) {
    return String(value ?? "")
        .trim()
        .toLocaleUpperCase("sr");
}

function parseCsvLine(line) {
    const result = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];

        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                field += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === "," && !inQuotes) {
            result.push(field);
            field = "";
        } else {
            field += ch;
        }
    }

    result.push(field);
    return result;
}

function parseCsv(text) {
    const lines = text
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter(line => line.trim() !== "");

    if (!lines.length) return [];

    const headers = parseCsvLine(lines[0]).map(h => h.trim());

    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        const row = {};

        headers.forEach((header, index) => {
            row[header] = values[index] ?? "";
        });

        return row;
    });
}

function stormColorLevelNumber(color) {
    const levels = {
        "GREEN": 0,
        "YELLOW": 1,
        "ORANGE": 2,
        "RED": 3,
        "PURPLE": 4
    };

    return levels[String(color || "").toUpperCase()] ?? 0;
}

function stormRiskColor(color) {
    const colors = {
        "GREEN": "#a6d96a",
        "YELLOW": "#ffffbf",
        "ORANGE": "#fdae61",
        "RED": "#d7191c",
        "PURPLE": "#7b3294"
    };

    return colors[String(color || "").toUpperCase()] || "#cccccc";
}

function translatedStormRiskColor(color) {
    const sr = {
        "GREEN": "без значајног ризика",
        "YELLOW": "повишен",
        "ORANGE": "умерен",
        "RED": "висок",
        "PURPLE": "веома висок"
    };

    const en = {
        "GREEN": "no significant risk",
        "YELLOW": "elevated",
        "ORANGE": "moderate",
        "RED": "high",
        "PURPLE": "very high"
    };

    const key = String(color || "").toUpperCase();
    return (currentLanguage === "sr" ? sr : en)[key] || color || "—";
}

function translatedConfidence(level) {
    const sr = {
        "LOW": "ниска",
        "MEDIUM": "средња",
        "MODERATE": "умерена",
        "HIGH": "висока",
        "SINGLE_MODEL": "један модел",
        "UNKNOWN": "непозната"
    };

    const en = {
        "LOW": "low",
        "MEDIUM": "medium",
        "MODERATE": "moderate",
        "HIGH": "high",
        "SINGLE_MODEL": "single model",
        "UNKNOWN": "unknown"
    };

    const key =
        String(level || "")
            .toUpperCase();

    return (
        currentLanguage === "sr"
            ? sr
            : en
    )[key]
        || level
        || "—";
}

function translatedLocalSupport(level) {
    const sr = {
        "NONE": "нема",
        "ISOLATED": "изолована",
        "LOW": "ниска",
        "MODERATE": "умерена",
        "HIGH": "висока",
        "UNKNOWN": "непозната"
    };

    const en = {
        "NONE": "none",
        "ISOLATED": "isolated",
        "LOW": "low",
        "MODERATE": "moderate",
        "HIGH": "high",
        "UNKNOWN": "unknown"
    };

    const key = String(level || "").toUpperCase();
    return (currentLanguage === "sr" ? sr : en)[key] || level || "—";
}

function stormHazardPrefix(hazardKey) {
    return {
        thunder: "thunder",
        hail: "hail",
        large_hail: "large_hail",
        very_large_hail: "very_large_hail"
    }[hazardKey] || hazardKey;
}

async function loadMultimodelStormsRows(hour) {
    const path = MULTIMODEL_STORMS_FILES[hour];

    if (!path) return null;

    if (multimodelStormsCache[hour]) {
        return multimodelStormsCache[hour];
    }

    const response = await fetch(
        path,
        { cache: "no-store" }
    );

    if (!response.ok) {
        console.warn(
            "Multimodel STORMS file unavailable for f"
            + String(hour).padStart(3, "0")
            + ": HTTP "
            + response.status
        );
        return null;
    }

    const rows = parseCsv(await response.text());
    const byName = new Map();

    if (!displayReferenceRun && rows.length > 0) {
        const referenceText =
            rows[0].reference_run
            || rows[0].valid_time
            || "";

        displayReferenceRun =
            normalizeToUtcMidnight(referenceText);
    }

    rows.forEach(row => {
        byName.set(
            normalizeMunicipalityName(row.Value_sc),
            row
        );
    });

    multimodelStormsCache[hour] = byName;
    return byName;
}



/* ============================================================
   OLUJA v2 - DIRECT VALIDATED WEB-DATA CONNECTION

   Primary source:
       data/storm/manifest.json
       data/storm/runs/<RUN_ID>/fXXX.json

   Behaviour:
   - f003..f072: GEFS + ICON-EU EPS, equal model weights
   - f075..f120: GEFS-only
   - public timeline remains exact 3-hourly f003..f120
   - missing ICON is null/unavailable, never 0
   - legacy multimodel CSV remains fallback only
   ============================================================ */

let stormV2ManifestDirectPromise = null;
const stormV2TermDirectCache = new Map();

async function loadStormV2ManifestDirect() {
    if (stormV2ManifestDirectPromise) {
        return stormV2ManifestDirectPromise;
    }

    stormV2ManifestDirectPromise = (async () => {
        try {
            const response = await fetch(
                "data/storm/manifest.json",
                { cache: "no-store" }
            );

            if (!response.ok) {
                console.warn(
                    "OLUJA v2 manifest unavailable: HTTP "
                    + response.status
                );
                return null;
            }

            const manifest = await response.json();

            if (
                !manifest
                || manifest.schema !== "meteorisk_storm_v2"
                || Number(manifest.term_count) !== 40
                || Number(manifest.municipality_count) !== 194
                || !Array.isArray(manifest.terms)
            ) {
                console.warn(
                    "OLUJA v2 manifest schema/QC failed."
                );
                return null;
            }

            manifest.byHour = new Map();

            manifest.terms.forEach(term => {
                const hour = Number(term.forecast_hour);

                if (Number.isFinite(hour)) {
                    manifest.byHour.set(
                        hour,
                        term
                    );
                }
            });

            if (
                manifest.byHour.size !== 40
                || !manifest.byHour.has(3)
                || !manifest.byHour.has(120)
            ) {
                console.warn(
                    "OLUJA v2 manifest timeline QC failed."
                );
                return null;
            }

            if (
                !displayReferenceRun
                && manifest.model_run
            ) {
                displayReferenceRun =
                    normalizeToUtcMidnight(
                        manifest.model_run
                    );
            }

            return manifest;
        } catch (error) {
            console.warn(
                "OLUJA v2 manifest load failed.",
                error
            );
            return null;
        }
    })();

    return stormV2ManifestDirectPromise;
}


async function loadStormV2TermDirect(hour) {
    const key = Number(hour);

    if (stormV2TermDirectCache.has(key)) {
        return stormV2TermDirectCache.get(key);
    }

    const manifest =
        await loadStormV2ManifestDirect();

    if (!manifest) {
        return null;
    }

    const term = manifest.byHour.get(key);

    if (!term || !term.file) {
        return null;
    }

    try {
        const response = await fetch(
            "data/storm/" + term.file,
            { cache: "no-store" }
        );

        if (!response.ok) {
            console.warn(
                "OLUJA v2 f"
                + String(key).padStart(3, "0")
                + " unavailable: HTTP "
                + response.status
            );
            return null;
        }

        const payload = await response.json();

        if (
            !payload
            || payload.schema !== "meteorisk_storm_v2_term"
            || Number(payload.forecast_hour) !== key
            || Number(payload.municipality_count) !== 194
            || !payload.municipalities
        ) {
            console.warn(
                "OLUJA v2 term schema/QC failed for f"
                + String(key).padStart(3, "0")
            );
            return null;
        }

        stormV2TermDirectCache.set(
            key,
            payload
        );

        return payload;
    } catch (error) {
        console.warn(
            "OLUJA v2 term load failed for f"
            + String(key).padStart(3, "0"),
            error
        );
        return null;
    }
}


async function baseGefForecastHourForSlot(hour) {
    const stormV2Manifest =
        await loadStormV2ManifestDirect();

    if (
        stormV2Manifest
        && stormV2Manifest.byHour.has(
            Number(hour)
        )
    ) {
        return Number(hour);
    }

    const rowsByName =
        await loadMultimodelStormsRows(
            hour
        );

    if (
        !rowsByName
        || rowsByName.size === 0
    ) {
        return hour;
    }

    const firstRow =
        rowsByName.values().next().value;

    const gefsHour = optionalNumber(
        firstRow
            ? firstRow.gefs_forecast_hour
            : null
    );

    return Number.isFinite(
        Number(gefsHour)
    )
        ? Number(gefsHour)
        : hour;
}


function applyStormV2DirectPayload(
    data,
    payload
) {
    if (
        !data
        || !data.municipalities
        || !payload
        || !payload.municipalities
    ) {
        return 0;
    }

    let matched = 0;

    Object.entries(
        payload.municipalities
    ).forEach(
        ([id, source]) => {
            const target =
                data.municipalities[id];

            if (!target) {
                return;
            }

            target.storms_multimodel = true;
            target.storm_v2_available = true;

            [
                "thunder",
                "hail",
                "large_hail",
                "very_large_hail"
            ].forEach(
                hazard => {
                    target[hazard] =
                        optionalNumber(
                            source[
                                "storm_p_"
                                + hazard
                            ]
                        );

                    target[
                        hazard
                        + "_risk_color"
                    ] =
                        source[
                            "storm_"
                            + hazard
                            + "_risk_level"
                        ]
                        || "green";

                    target[
                        hazard
                        + "_risk_level_num"
                    ] =
                        optionalNumber(
                            source[
                                "storm_"
                                + hazard
                                + "_risk_level_num"
                            ]
                        );

                    target[
                        hazard
                        + "_confidence"
                    ] =
                        source[
                            "storm_"
                            + hazard
                            + "_confidence"
                        ]
                        || "single_model";

                    target[
                        hazard
                        + "_gefs"
                    ] =
                        optionalNumber(
                            source[
                                "storm_gefs_p_"
                                + hazard
                            ]
                        );

                    target[
                        hazard
                        + "_icon"
                    ] =
                        optionalNumber(
                            source[
                                "storm_icon_p_"
                                + hazard
                            ]
                        );

                    target[
                        hazard
                        + "_ecmwf"
                    ] = null;

                    target[
                        hazard
                        + "_models_available"
                    ] =
                        optionalNumber(
                            source.storm_model_count
                        );

                    target[
                        hazard
                        + "_model_spread"
                    ] =
                        optionalNumber(
                            source[
                                "storm_"
                                + hazard
                                + "_model_difference_pp"
                            ]
                        );

                    target[
                        hazard
                        + "_model_difference_pp"
                    ] =
                        optionalNumber(
                            source[
                                "storm_"
                                + hazard
                                + "_model_difference_pp"
                            ]
                        );

                    target[
                        hazard
                        + "_agreement_gate_applied"
                    ] =
                        Boolean(
                            source[
                                "storm_"
                                + hazard
                                + "_agreement_gate_applied"
                            ]
                        );

                    target[
                        hazard
                        + "_dominant_model"
                    ] = "";

                    target[
                        hazard
                        + "_source_models"
                    ] =
                        source.storm_models_available
                        || payload.models
                        || "";
                }
            );

            target.storm_overview_color =
                source.storm_risk_level
                || "green";

            target.storm_overview_confidence =
                source.storm_confidence
                || "single_model";

            target.storm_dominant_hazard =
                source.storm_dominant_hazards
                || "";

            target.storm_valid_time =
                payload.valid_time
                || "";

            target.storm_reference_run =
                payload.model_run
                || "";

            target.storm_gefs_forecast_hour =
                Number(payload.forecast_hour);

            target.storm_model_count =
                Number(
                    source.storm_model_count
                    ?? payload.model_count
                );

            target.storm_models_available =
                source.storm_models_available
                || payload.models
                || "";

            target.storm_timeline_mode =
                source.storm_timeline_mode
                || payload.timeline_mode
                || "";

            matched += 1;
        }
    );

    return matched;
}


async function applyLegacyMultimodelStormsOverlay(
    data,
    hour
) {
    if (
        !data
        || !geometryData
    ) {
        return data;
    }

    const rowsByName =
        await loadMultimodelStormsRows(
            hour
        );

    if (!rowsByName) {
        data.storms_multimodel = false;
        data.storms_multimodel_matches = 0;
        data.storms_available = false;
        return data;
    }

    let matched = 0;
    let slotSourceModels = "";

    geometryData.features.forEach(
        feature => {
            const properties =
                feature.properties
                || {};

            const name =
                normalizeMunicipalityName(
                    properties.Value_sc
                    || properties.Value_sl
                    || properties.Value_e
                );

            const row =
                rowsByName.get(name);

            if (!row) return;

            const id =
                municipalityId(
                    properties
                );

            if (
                !data.municipalities
                || !data.municipalities[id]
            ) {
                return;
            }

            const target =
                data.municipalities[id];

            target.storms_multimodel = true;

            target.thunder =
                optionalNumber(row.thunder_signal);
            target.hail =
                optionalNumber(row.hail_signal);
            target.large_hail =
                optionalNumber(row.large_hail_signal);
            target.very_large_hail =
                optionalNumber(row.very_large_hail_signal);

            target.thunder_risk_color =
                row.thunder_color || "GREY";
            target.hail_risk_color =
                row.hail_color || "GREY";
            target.large_hail_risk_color =
                row.large_hail_color || "GREY";
            target.very_large_hail_risk_color =
                row.very_large_hail_color || "GREY";

            target.thunder_confidence =
                row.thunder_confidence || "UNKNOWN";
            target.hail_confidence =
                row.hail_confidence || "UNKNOWN";
            target.large_hail_confidence =
                row.large_hail_confidence || "UNKNOWN";
            target.very_large_hail_confidence =
                row.very_large_hail_confidence || "UNKNOWN";

            target.thunder_ecmwf =
                optionalNumber(row.ecmwf_thunder);
            target.thunder_icon =
                optionalNumber(row.icon_thunder);
            target.thunder_gefs =
                optionalNumber(row.gefs_thunder);

            target.hail_ecmwf =
                optionalNumber(row.ecmwf_hail);
            target.hail_icon =
                optionalNumber(row.icon_hail);
            target.hail_gefs =
                optionalNumber(row.gefs_hail);

            target.large_hail_ecmwf =
                optionalNumber(row.ecmwf_large_hail);
            target.large_hail_icon =
                optionalNumber(row.icon_large_hail);
            target.large_hail_gefs =
                optionalNumber(row.gefs_large_hail);

            target.very_large_hail_ecmwf =
                optionalNumber(row.ecmwf_very_large_hail);
            target.very_large_hail_icon =
                optionalNumber(row.icon_very_large_hail);
            target.very_large_hail_gefs =
                optionalNumber(row.gefs_very_large_hail);

            [
                "thunder",
                "hail",
                "large_hail",
                "very_large_hail"
            ].forEach(
                prefix => {
                    target[
                        prefix
                        + "_models_available"
                    ] =
                        optionalNumber(
                            row[
                                prefix
                                + "_models_available"
                            ]
                        );

                    target[
                        prefix
                        + "_model_spread"
                    ] =
                        optionalNumber(
                            row[
                                prefix
                                + "_model_spread"
                            ]
                        );

                    target[
                        prefix
                        + "_dominant_model"
                    ] =
                        row[
                            prefix
                            + "_dominant_model"
                        ]
                        || "";

                    target[
                        prefix
                        + "_source_models"
                    ] =
                        row[
                            prefix
                            + "_source_models"
                        ]
                        || "";
                }
            );

            target.storm_overview_color =
                row.storm_overview_color || "GREY";
            target.storm_overview_confidence =
                row.storm_overview_confidence || "UNKNOWN";
            target.storm_dominant_hazard =
                row.storm_dominant_hazard || "NONE";
            target.storm_valid_time =
                row.valid_time || "";
            target.storm_reference_run =
                row.reference_run || "";
            target.storm_gefs_forecast_hour =
                optionalNumber(row.gefs_forecast_hour);

            if (!slotSourceModels) {
                slotSourceModels =
                    row.thunder_source_models
                    || row.hail_source_models
                    || "";
            }

            matched += 1;
        }
    );

    data.storms_multimodel =
        matched > 0;
    data.storms_multimodel_matches =
        matched;
    data.storms_available =
        matched > 0;
    data.storms_multimodel_source =
        slotSourceModels
        || "ECMWF ENS | GEFS";
    data.storms_multimodel_note =
        "Developmental multimodel risk signal; not a calibrated probability.";

    return data;
}


async function applyMultimodelStormsOverlay(
    data,
    hour
) {
    if (!data) {
        return data;
    }

    const payload =
        await loadStormV2TermDirect(
            hour
        );

    if (payload) {
        const matched =
            applyStormV2DirectPayload(
                data,
                payload
            );

        if (matched === 194) {
            data.storms_multimodel = true;
            data.storms_multimodel_matches = matched;
            data.storms_available = true;
            data.storm_v2_available = true;

            data.storms_multimodel_source =
                payload.models || "";
            data.storms_multimodel_note =
                "MeteoRisk OLUJA v2 developmental multimodel risk; not calibrated probability.";

            data.storm_run_id =
                payload.run_id || "";
            data.storm_model_run =
                payload.model_run || "";
            data.storm_valid_time =
                payload.valid_time || "";
            data.storm_forecast_hour =
                Number(payload.forecast_hour);
            data.storm_model_count =
                Number(payload.model_count);
            data.storm_timeline_mode =
                payload.timeline_mode || "";

            return data;
        }

        console.warn(
            "OLUJA v2 municipality overlay matched "
            + matched
            + "/194 for f"
            + String(hour).padStart(3, "0")
            + "; falling back to legacy storm overlay."
        );
    }

    return applyLegacyMultimodelStormsOverlay(
        data,
        hour
    );
}


/* ============================================================
   MAXIMUM TEMPERATURE - GEFS + ICON-EU EPS DAILY MULTIMODEL
   ============================================================ */

function localTodayKey() {
    return localDateKeyBelgrade(
        new Date().toISOString()
    );
}


function startOfLocalToday() {
    const today = localTodayKey();

    return new Date(
        today + "T00:00:00+02:00"
    );
}


function hazardAvailability() {
    return Object.fromEntries(
        Object.keys(HAZARD_MODULES).map(
            moduleKey => [
                moduleKey,
                moduleAvailable(moduleKey)
            ]
        )
    );
}


function currentHazardGroup() {
    if (currentHazard === "module_risk") {
        return currentModule || "overall";
    }

    return moduleForParameter(currentHazard) || "overall";
}


function currentHazardAvailable() {
    const group = currentHazardGroup();
    const available = hazardAvailability();

    if (group === "overall") {
        return Object.values(available).some(Boolean);
    }

    return Boolean(available[group]);
}


function unavailableHtml(name) {
    const t = translations[currentLanguage];

    return `
        <div class="popup-title">${name}</div>
        <div class="multimodel-card">
            <div class="popup-section">
                ${t.notAvailableForTime}
            </div>
        </div>
    `;
}


function updateHazardAvailabilityLabels() {
    const t = translations[currentLanguage];

    const moduleLabels = {
        storm: t.stormGroup,
        wind: t.windGroup,
        temperature: t.temperatureGroup,
        fire: t.fireGroup,
        air_quality: t.airQualityGroup,
        uv: t.uvGroup
    };

    Object.entries(HAZARD_MODULES).forEach(
        ([moduleKey, config]) => {
            const element =
                document.getElementById(
                    config.labelElementId
                );

            if (!element) return;

            /* Do not claim "unavailable" before initialization has completed. */
            if (!appReady) {
                element.textContent =
                    moduleLabels[moduleKey];
                return;
            }

            element.textContent =
                moduleLabels[moduleKey]
                +
                (
                    moduleAvailable(moduleKey)
                    ? ""
                    : " — " + t.unavailable
                );
        }
    );
}


function emptyMunicipalityData() {
    const municipalities = {};

    if (!geometryData) {
        return municipalities;
    }

    geometryData.features.forEach(feature => {
        const id = municipalityId(
            feature.properties || {}
        );

        municipalities[id] = {};
    });

    return municipalities;
}


async function buildTimelineSlots() {
    /*
       Any timeline rebuild invalidates merged slot/overview caches.
       In normal operation this runs once at page initialization.
    */
    resetTimelineOverviewCache();

    const forecasts = await loadAllForecasts();
    const now = new Date();

    /*
       Timeline represents TIME, not product availability.

       1. Start at the first 3-hour UTC boundary that is not in the past.
       2. Continue without gaps in 3-hour steps.
       3. End at the latest future horizon covered by ANY product.
       4. Each hazard independently reports AVAILABLE / NOT AVAILABLE
          for every timeline slot.
    */

    const stepMs = 3 * 60 * 60 * 1000;

    const firstMs =
        Math.ceil(now.getTime() / stepMs)
        * stepMs;

    const forecastByTime = new Map();

    let latestForecastMs = firstMs;

    forecasts.forEach((data, index) => {
        const valid = new Date(data.valid_time);

        if (!Number.isFinite(valid.getTime())) {
            return;
        }

        const ms = valid.getTime();

        forecastByTime.set(
            ms,
            index
        );

        if (ms >= now.getTime()) {
            latestForecastMs = Math.max(
                latestForecastMs,
                ms
            );
        }
    });

    /* OLUJA v2 has its own validated run/horizon and may be newer than
       data/gefs. Extend the timeline through its latest valid time without
       pretending that a stale GEFS file is a current forecast slot. */
    const stormV2ManifestForTimeline =
        await loadStormV2ManifestDirect();

    if (
        stormV2ManifestForTimeline
        && Array.isArray(stormV2ManifestForTimeline.terms)
    ) {
        stormV2ManifestForTimeline.terms.forEach(term => {
            const ms = new Date(term.valid_time).getTime();
            if (Number.isFinite(ms) && ms >= now.getTime()) {
                latestForecastMs = Math.max(latestForecastMs, ms);
            }
        });
    }

    /*
       Daily temperature products may extend beyond the last 3-hour model
       product. Keep the continuous 3-hour axis through the whole last
       available local temperature day.
    */
    const allTemperatureDays =
        await loadTemperatureDailyRows();
    const allHeatStressDays = await loadHeatStressDailyRows();
    const allFireFwiDays =
        typeof loadFireFwiDailyRows === "function"
        ? await loadFireFwiDailyRows()
        : new Map();

    const todayKey =
        localTodayKey();

    const futureTemperatureDates =
        Array.from(
            new Set([
                ...allTemperatureDays.keys(),
                ...allHeatStressDays.keys(),
                ...allFireFwiDays.keys()
            ])
        )
        .filter(dateKey => dateKey >= todayKey)
        .sort();

    const lastTemperatureDate =
        futureTemperatureDates.length
        ? futureTemperatureDates[
            futureTemperatureDates.length - 1
        ]
        : null;

    /* VETAR v2 is a standalone overlay keyed by actual valid_time.
       It may be newer than the legacy core GEFS cache, so its horizon
       must be allowed to extend the public timeline independently. */
    if (typeof windV2LatestValidTime === "function") {
        const windLatest = await windV2LatestValidTime();
        const windLatestMs = windLatest
            ? new Date(windLatest).getTime()
            : NaN;

        if (
            Number.isFinite(windLatestMs)
            && windLatestMs >= now.getTime()
        ) {
            latestForecastMs = Math.max(
                latestForecastMs,
                windLatestMs
            );
        }
    }

    const slots = [];

    /*
       Hard safety cap: 10 days. Normally the loop stops much earlier.
    */
    const maxIterations =
        10 * 24 / 3;

    for (
        let i = 0, ms = firstMs;
        i <= maxIterations;
        i += 1, ms += stepMs
    ) {
        const date = new Date(ms);
        const localDate =
            localDateKeyBelgrade(
                date.toISOString()
            );

        const withinForecast =
            ms <= latestForecastMs;

        const withinTemperature =
            Boolean(
                lastTemperatureDate
                && localDate <= lastTemperatureDate
            );

        if (
            !withinForecast
            && !withinTemperature
        ) {
            break;
        }

        const forecastIndex =
            forecastByTime.has(ms)
            ? forecastByTime.get(ms)
            : null;

        slots.push({
            kind:
                forecastIndex !== null
                ? "forecast"
                : "timeline_only",

            valid_time:
                date.toISOString(),

            data_index:
                forecastIndex
        });
    }

    timelineSlots = slots;

    const slider =
        document.getElementById(
            "time-slider"
        );

    slider.min = 0;
    slider.max =
        Math.max(
            0,
            timelineSlots.length - 1
        );
    slider.step = 1;
    slider.value = 0;

    return timelineSlots;
}


async function dataForTimelineSlot(
    index,
    options = {}
) {
    if (!timelineSlots.length) {
        return null;
    }

    const safeIndex =
        Math.max(
            0,
            Math.min(
                index,
                timelineSlots.length - 1
            )
        );

    const updateGlobalForecastHour =
        options.updateGlobalForecastHour !== false;

    const slot =
        timelineSlots[safeIndex];

    /*
       IMPORTANT FOR PARALLEL OVERVIEW BUILD:
       lead time is LOCAL to this slot. Do not use the mutable global
       currentForecastHour while several slots are being merged at once.
    */
    const slotForecastHour =
        timelineLeadHourForIndex(
            safeIndex
        );

    function applyDisplayLeadFromCache(cached) {
        if (
            updateGlobalForecastHour
            && cached
            && Number.isFinite(
                Number(
                    cached._meteorisk_display_forecast_hour
                )
            )
        ) {
            currentForecastHour =
                Number(
                    cached._meteorisk_display_forecast_hour
                );
        }
    }

    if (timelineSlotDataCache.has(safeIndex)) {
        const cached =
            timelineSlotDataCache.get(
                safeIndex
            );

        applyDisplayLeadFromCache(cached);
        return cached;
    }

    if (timelineSlotBuildPromiseCache.has(safeIndex)) {
        const cached =
            await timelineSlotBuildPromiseCache.get(
                safeIndex
            );

        applyDisplayLeadFromCache(cached);
        return cached;
    }

    const buildPromise = (async () => {
        let data;

        if (
            slot.kind === "forecast"
            && allForecastData
            && allForecastData[slot.data_index]
        ) {
            data = structuredClone(
                allForecastData[slot.data_index]
            );

        } else {
            data = {
                valid_time: slot.valid_time,
                model_run: null,
                municipalities:
                    emptyMunicipalityData(),
                storms_multimodel: false,
                storms_available: false,
                wind_available: false,
                temperature_multimodel: false,
                temperature_available: false,
                heat_stress_multimodel: false,
                fire_fwi_available: false,
                fire_hdw_available: false,
                fire_available: false,
                air_quality_available: false,
                uv_available: false
            };
        }

        /*
           Independent hazard overlays are safe to load concurrently.
           Browser connection limits still provide a natural network cap,
           while the outer overview builder limits the number of active slots.
        */
        const overlayTasks = [];

        if (
            Number.isFinite(
                Number(slotForecastHour)
            )
        ) {
            overlayTasks.push(
                applyMultimodelStormsOverlay(
                    data,
                    Number(slotForecastHour)
                )
            );
        }

        overlayTasks.push(
            applyWindV2Overlay(data),
            applyTemperatureOverlay(data),
            applyHeatStressTimelineOverlay(data),
            applyFireOverlay(
                data,
                Number.isFinite(
                    Number(slotForecastHour)
                )
                ? Number(slotForecastHour)
                : null
            ),
            applyEnvironmentOverlay(data)
        );

        await Promise.all(
            overlayTasks
        );

        data.storms_available =
            Boolean(
                data.storms_multimodel
                && data.storms_multimodel_matches > 0
            );

        data.temperature_available =
            Boolean(
                (
                    data.temperature_multimodel
                    && data.temperature_multimodel_matches > 0
                )
                ||
                (
                    data.heat_stress_multimodel
                    && data.heat_stress_multimodel_matches > 0
                )
            );

        if (!data.storms_available) {
            data.storms_multimodel = false;
        }

        /*
           Timeline remains authoritative. Never keep a stale inherited
           valid time from an older core file.
        */
        data.valid_time =
            slot.valid_time;

        const effectiveForecastHour =
            (
                data.wind_available
                && Number.isFinite(
                    Number(data.wind_forecast_hour)
                )
            )
            ? Number(
                data.wind_forecast_hour
            )
            : (
                Number.isFinite(
                    Number(slotForecastHour)
                )
                ? Number(slotForecastHour)
                : null
            );

        /*
           Private frontend helper field only. It is never published back to
           forecast JSON and is used solely to restore the correct +hour when
           a cached slot becomes the active map slot.
        */
        data._meteorisk_display_forecast_hour =
            effectiveForecastHour;

        timelineSlotDataCache.set(
            safeIndex,
            data
        );

        return data;
    })();

    timelineSlotBuildPromiseCache.set(
        safeIndex,
        buildPromise
    );

    try {
        const data =
            await buildPromise;

        applyDisplayLeadFromCache(data);
        return data;

    } finally {
        timelineSlotBuildPromiseCache.delete(
            safeIndex
        );
    }
}


async function mapWithConcurrency(
    items,
    limit,
    worker
) {
    const results =
        new Array(items.length);

    let nextIndex = 0;

    async function runWorker() {
        while (true) {
            const index =
                nextIndex;

            nextIndex += 1;

            if (index >= items.length) {
                return;
            }

            results[index] =
                await worker(
                    items[index],
                    index
                );
        }
    }

    const workerCount =
        Math.max(
            1,
            Math.min(
                Number(limit) || 1,
                items.length
            )
        );

    await Promise.all(
        Array.from(
            { length: workerCount },
            () => runWorker()
        )
    );

    return results;
}


async function buildTimelineOverviewData() {
    if (timelineOverviewDataCache) {
        return timelineOverviewDataCache;
    }

    if (timelineOverviewBuildPromise) {
        return timelineOverviewBuildPromise;
    }

    timelineOverviewBuildPromise = (async () => {
        const started =
            performance.now();

        const indices =
            timelineSlots.map(
                (_, index) => index
            );

        const results =
            await mapWithConcurrency(
                indices,
                OVERVIEW_LOAD_CONCURRENCY,
                index =>
                    dataForTimelineSlot(
                        index,
                        {
                            updateGlobalForecastHour:
                                false
                        }
                    )
            );

        timelineOverviewDataCache =
            results.filter(Boolean);

        const elapsed =
            Math.round(
                performance.now()
                - started
            );

        console.info(
            "MeteoRisk five-day overview cache ready:",
            timelineOverviewDataCache.length,
            "slots in",
            elapsed,
            "ms"
        );

        return timelineOverviewDataCache;
    })();

    try {
        return await timelineOverviewBuildPromise;

    } finally {
        timelineOverviewBuildPromise = null;
    }
}


async function showTimelineSlot(index) {
    if (!timelineSlots.length) {
        return;
    }

    timelineSlotIndex =
        Math.max(
            0,
            Math.min(
                index,
                timelineSlots.length - 1
            )
        );

    const data =
        await dataForTimelineSlot(
            timelineSlotIndex
        );

    if (!data) {
        return;
    }

    currentModelData = data;

    document.getElementById("time-slider").value =
        timelineSlotIndex;

    updateTimelineLabels();
    updateHeader();
    updateHazardAvailabilityLabels();
    updateLegend();
    redrawMap();
    restoreSelectedMunicipality();
    updateTimeButtons();

    if (
        selectedLayer
        && isMobileView()
        && document.getElementById("mobile-detail-panel").classList.contains("open")
    ) {
        openMobileDetail(
            selectedLayer.feature.properties
        );
    }

    /*
       If the municipality overview is open, keep it synchronized with the
       same moving timeline without requiring a new search/click.

       buildTimelineOverviewData() is cache-backed: moving the slider no
       longer downloads/rebuilds all 40 terms.
    */
    if (
        overviewFeature
        && document.getElementById("overview-panel").classList.contains("open")
    ) {
        overviewSelectedDate =
            localDateKeyBelgrade(
                currentModelData.valid_time
            );

        const overviewData =
            await buildTimelineOverviewData();

        renderOverview(
            overviewData,
            overviewFeature
        );
    }
}



function hazardModelSignalsHtml(
    data,
    hazardKey
) {
    const prefix =
        stormHazardPrefix(
            hazardKey
        );

    const icon =
        data[
            prefix
            + "_icon"
        ];

    const gefs =
        data[
            prefix
            + "_gefs"
        ];

    if (
        !Number.isFinite(
            Number(icon)
        )
        && !Number.isFinite(
            Number(gefs)
        )
    ) {
        return "";
    }

    const t =
        translations[
            currentLanguage
        ];

    const modelCount =
        Number(
            data[
                prefix
                + "_models_available"
            ]
        );

    const iconText =
        Number.isFinite(
            Number(icon)
        )
            ? formatProbability(icon)
            : "—";

    const denominator =
        Number.isFinite(
            Number(icon)
        )
            ? 2
            : 1;

    return `
        <div class="popup-section">
            ${t.modelSignals}
        </div>

        <div class="multimodel-model-grid">
            <div>
                <span>GEFS</span>
                <b>${formatProbability(gefs)}</b>
            </div>

            <div>
                <span>ICON-EU EPS</span>
                <b>${iconText}</b>
            </div>
        </div>

        <div class="popup-row">
            ${currentLanguage === "sr"
                ? "Доступни модели"
                : "Models available"}:
            <b>${
                Number.isFinite(modelCount)
                    ? modelCount
                    : denominator
            }/${denominator}</b>
        </div>
    `;
}


function multimodelStormDetailHtml(
    data,
    hazardKey
) {
    if (
        !data
        || !data.storms_multimodel
    ) {
        return "";
    }

    const t =
        translations[
            currentLanguage
        ];

    const prefix =
        stormHazardPrefix(
            hazardKey
        );

    const signal =
        data[hazardKey];

    const riskColor =
        data[
            prefix
            + "_risk_color"
        ];

    const confidence =
        data[
            prefix
            + "_confidence"
        ];

    const sourceModels =
        data[
            prefix
            + "_source_models"
        ]
        || data.storm_models_available
        || "";

    const modelsAvailable =
        Number(
            data[
                prefix
                + "_models_available"
            ]
        );

    const modelDifference =
        data[
            prefix
            + "_model_difference_pp"
        ];

    const agreementGateApplied =
        Boolean(
            data[
                prefix
                + "_agreement_gate_applied"
            ]
        );

    const dual =
        modelsAvailable === 2
        || Number.isFinite(
            Number(
                data[
                    prefix
                    + "_icon"
                ]
            )
        );

    const sourceModelsRow =
        sourceModels
        ? `
            <div class="popup-row">
                ${currentLanguage === "sr"
                    ? "Модели у процени"
                    : "Models used"}:
                <b>${translatedModelAvailability(sourceModels)}</b>
            </div>
        `
        : "";

    const differenceRow =
        Number.isFinite(
            Number(modelDifference)
        )
        ? `
            <div class="popup-row">
                ${currentLanguage === "sr"
                    ? "Разлика између модела"
                    : "Model difference"}:
                <b>${formatProbability(modelDifference)}</b>
            </div>
        `
        : "";

    const agreementRow =
        dual
        ? `
            <div class="popup-row">
                ${currentLanguage === "sr"
                    ? "Правило сагласности"
                    : "Agreement gate"}:
                <b>${
                    agreementGateApplied
                        ? (
                            currentLanguage === "sr"
                                ? "примењено"
                                : "applied"
                        )
                        : (
                            currentLanguage === "sr"
                                ? "није ограничило ниво"
                                : "did not limit level"
                        )
                }</b>
            </div>
        `
        : "";

    const modeNote =
        dual
        ? (
            currentLanguage === "sr"
                ? "GEFS + ICON-EU EPS, једнака тежина модела 50:50."
                : "GEFS + ICON-EU EPS, equal model weights 50:50."
        )
        : (
            currentLanguage === "sr"
                ? "GEFS-only: ICON-EU EPS после +72 h нема упоредив TP3h термин."
                : "GEFS-only: after +72 h ICON-EU EPS has no comparable TP3h slot."
        );

    return `
        <div class="multimodel-card">
            <div class="popup-section">
                ${currentLanguage === "sr"
                    ? "OLUJA v2 процена"
                    : "STORM v2 assessment"}
            </div>

            <div class="popup-row">
                ${stormPublicSignalLabel(hazardKey)}:
                <b>${formatProbability(signal)}</b>
            </div>

            <div class="popup-row">
                ${t.risk}:
                <b>${translatedStormRiskColor(riskColor)}</b>
            </div>

            <div class="popup-row">
                ${t.confidence}:
                <b>${translatedConfidence(confidence)}</b>
            </div>

            ${sourceModelsRow}
            ${differenceRow}
            ${agreementRow}

            ${hazardModelSignalsHtml(
                data,
                hazardKey
            )}

            <div class="popup-note">
                <b>${currentLanguage === "sr"
                    ? "Просторни обухват:"
                    : "Spatial scope:"}</b>
                ${stormSpatialScopeNote()}
            </div>

            <div class="popup-note">
                ${modeNote}
                ${currentLanguage === "sr"
                    ? " Недоступан модел се не третира као 0%. Производ је развојни и није калибрисана вероватноћа."
                    : " An unavailable model is not treated as 0%. The product is developmental and is not a calibrated probability."}
            </div>
        </div>
    `;
}


/* ============================================================
   HAZARD INFO
   ============================================================ */

function hazardInfoFor(hazardKey) {

    if (!hazardInfo) {
        return null;
    }

    const hazard = hazardInfo[hazardKey];

    if (!hazard) {
        return null;
    }

    return hazard[currentLanguage] || null;
}


function currentHazardInfo() {
    return hazardInfoFor(currentHazard);
}


function hazardInfoHtmlForHazard(
    hazardKey,
    data
) {

    const info = hazardInfoFor(hazardKey);
    const t = translations[currentLanguage];

    if (!info || !data) {
        return "";
    }

    const probability = Number(data[hazardKey]);

    /* Storm hazards are significant from 10% upward. */
    if (!Number.isFinite(probability) || probability < 10) {
        return "";
    }

    const impacts = Array.isArray(info.impacts) ? info.impacts : [];
    const recommendations = Array.isArray(info.recommendations) ? info.recommendations : [];

    if (!impacts.length && !recommendations.length) {
        return "";
    }

    return `
        <div class="popup-risk-box">
            ${impacts.length ? `
                <div class="popup-section">${info.impact_title}</div>
                <ul>${impacts.map(item => `<li>${item}</li>`).join("")}</ul>
            ` : ""}

            ${recommendations.length ? `
                <div class="popup-section">${info.recommendation_title}</div>
                <ul>${recommendations.map(item => `<li>${item}</li>`).join("")}</ul>
            ` : ""}

            <div class="popup-note">${t.riskNote}</div>
        </div>
    `;
}


function hazardInfoHtml(data) {
    return hazardInfoHtmlForHazard(currentHazard, data);
}


function stormHazardLabel(hazardKey) {
    const t = translations[currentLanguage];

    const labels = {
        thunder: t.thunder,
        hail: t.hail,
        large_hail: t.largeHail,
        very_large_hail: t.veryLargeHail
    };

    return labels[hazardKey] || hazardKey;
}



/* ============================================================
   MeteoRisk M1.1.6 - OVERALL SUMMARY + DRAGGABLE DESKTOP POPUP
   ============================================================ */

function overallRiskLevelLabel(level) {
    const safeLevel = Math.max(0, Math.min(4, Number(level) || 0));
    const sr = [
        "без значајног ризика",
        "повишен",
        "умерен",
        "висок",
        "веома висок"
    ];
    const en = [
        "no significant risk",
        "elevated",
        "moderate",
        "high",
        "very high"
    ];
    return (currentLanguage === "sr" ? sr : en)[safeLevel];
}


function overallRiskDominantHazards(data) {
    if (!data) return [];

    const labels = currentLanguage === "sr"
        ? {
            storm: "Олуја",
            wind: "Ветар",
            temperature: "Максимална температура",
            heat: "Топлотни стрес",
            fwi: "Пожарна опасност (FWI)",
            hdw: "Потенцијал ширења пожара (HDW)",
            air: "Квалитет ваздуха",
            uv: "UV индекс"
        }
        : {
            storm: "Storm",
            wind: "Wind",
            temperature: "Maximum temperature",
            heat: "Heat stress",
            fwi: "Fire danger (FWI)",
            hdw: "Fire spread potential (HDW)",
            air: "Air quality",
            uv: "UV index"
        };

    const candidates = [
        { key:"storm", level: stormRiskLevel(data) },
        { key:"wind", level: windRiskLevel(data) },
        { key:"temperature", level: temperatureRiskLevel(data) },
        { key:"heat", level: heatStressRiskLevel(data) },
        { key:"fwi", level: fireFwiRiskLevel(data) },
        { key:"hdw", level: fireHdwRiskLevel(data) }
    ];

    if (typeof airQualityRiskLevel === "function") {
        candidates.push({ key:"air", level: airQualityRiskLevel(data) });
    }

    if (typeof uvRiskLevel === "function") {
        candidates.push({ key:"uv", level: uvRiskLevel(data) });
    }

    const strongest = Math.max(
        0,
        ...candidates.map(item => Number(item.level) || 0)
    );

    if (strongest < 1) {
        return [];
    }

    return candidates
        .filter(item => (Number(item.level) || 0) === strongest)
        .map(item => labels[item.key])
        .filter(Boolean);
}


function overallRiskSummaryHtml(data) {
    const level = overallRiskLevel(data);
    const color = overallRiskColor(level);
    const dominant = overallRiskDominantHazards(data);

    const totalLabel =
        currentLanguage === "sr"
        ? "Укупан ризик"
        : "Overall risk";

    const dominantLabel =
        currentLanguage === "sr"
        ? "Доминантна опасност"
        : "Dominant hazard";

    const noneLabel =
        currentLanguage === "sr"
        ? "Нема издвојене значајне опасности"
        : "No significant dominant hazard";

    const explanation =
        currentLanguage === "sr"
        ? "Боја карте представља највиши ниво међу свим доступним опасностима у активном термину."
        : "The map colour represents the highest level across all available hazards in the active time slot.";

    const textColor = Number(level) >= 3 ? "#ffffff" : "#111827";

    return `
        <div class="mr-overall-risk-summary">
            <div class="mr-overall-risk-summary-head">
                <div>
                    <div class="mr-overall-risk-summary-title">${totalLabel}</div>
                    <div class="mr-overall-risk-summary-note">${explanation}</div>
                </div>
                <span
                    class="mr-overall-risk-badge"
                    style="background:${color};color:${textColor}">
                    ${overallRiskLevelLabel(level)}
                </span>
            </div>
            <div class="popup-row mr-overall-risk-dominant">
                ${dominantLabel}:
                <b>${dominant.length ? dominant.join(" · ") : noneLabel}</b>
            </div>
        </div>
    `;
}


function overallPopupHazardsHtml(data) {

    const availability = hazardAvailability();
    const availabilityText = `
        <div class="multimodel-card">
            <div class="popup-section">
                ${currentLanguage === "sr" ? "Доступност производа" : "Product availability"}
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].stormGroup}:
                <b>${availability.storm
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].windGroup}:
                <b>${availability.wind
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].temperatureGroup}:
                <b>${availability.temperature
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].fireGroup}:
                <b>${availability.fire
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].airQualityGroup}:
                <b>${availability.air_quality
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
            <div class="popup-row">
                ${translations[currentLanguage].uvGroup}:
                <b>${availability.uv
                    ? translations[currentLanguage].available
                    : translations[currentLanguage].unavailable}</b>
            </div>
        </div>
    `;


    const t = translations[currentLanguage];

    let html = "";
    let significantCount = 0;

    /* --------------------------------------------------------
       OLUJA: one public hierarchical risk.
       -------------------------------------------------------- */
    if (
        data.storms_multimodel
        && stormRiskLevel(data) >= 1
    ) {
        significantCount += 1;

        html += `
            <div class="popup-section">${t.stormGroup}</div>
            <div class="popup-row">
                ${currentLanguage === "sr" ? "Процена ризика" : "Risk assessment"}:
                <b>${stormPublicCategory(data)}</b>
            </div>
            <div class="popup-row">
                ${t.confidence}:
                <b>${translatedConfidence(stormPublicConfidence(data))}</b>
            </div>
        `;
    }

    /* --------------------------------------------------------
       MAXIMUM TEMPERATURE: one daily severity category.
       Show only yellow-or-higher in the combined popup.
       -------------------------------------------------------- */

    if (
        data.temperature_multimodel
        &&
        stormColorLevelNumber(
            data.temperature_color
        ) >= 1
    ) {
        significantCount += 1;

        html += `
            <div class="popup-section">
                ${t.maxTemperature}
            </div>

            <div class="popup-row">
                ${t.multimodelTmax}:
                <b>${formatNumber(data.max_temperature, 1)} °C</b>
            </div>

            <div class="popup-row">
                ${t.temperatureCategory}:
                <b>${translatedTemperatureCategory(data)}</b>
            </div>

            <div class="popup-row">
                ${t.categoryProbability}:
                <b>${formatProbability(data.temperature_category_probability)}</b>
            </div>

            <div class="popup-row">
                ${t.warmestPeriod}:
                <b>${data.temperature_warmest_period || "—"}</b>
            </div>
        `;
    }



    /* --------------------------------------------------------
       24H HEAT STRESS: mirror the main heat-stress product in
       the combined municipality popup. Show only yellow-or-higher.
       -------------------------------------------------------- */

    if (
        data.heat_stress_multimodel
        &&
        stormColorLevelNumber(data.heat_stress_color) >= 1
    ) {
        significantCount += 1;

        const heatMode =
            String(data.heat_stress_mode || "").toUpperCase();

        const heatImpact =
            typeof thermalStressImpactRecommendation === "function"
            ? thermalStressImpactRecommendation(data)
            : null;

        html += `
            <div class="popup-section">${t.heatStress}</div>

            <div class="popup-row">
                ${currentLanguage === "sr" ? "Режим" : "Mode"}:
                <b>${
                    typeof thermalStressModeTranslation === "function"
                    ? thermalStressModeTranslation(heatMode)
                    : (heatMode || "—")
                }</b>
            </div>

            <div class="popup-row">
                ${t.temperatureCategory}:
                <b>${
                    typeof translatedHeatStressCategory === "function"
                    ? translatedHeatStressCategory(data)
                    : (data.heat_stress_category_sr || "—")
                }</b>
            </div>

            ${
                (heatMode === "DAY" || heatMode === "TRANSITION")
                && Number.isFinite(Number(data.heat_stress))
                ? `
                    <div class="popup-row">
                        Heat Index:
                        <b>${formatNumber(data.heat_stress, 1)} °C</b>
                    </div>
                `
                : ""
            }

            ${
                (heatMode === "NIGHT" || heatMode === "TRANSITION")
                && Number.isFinite(Number(data.heat_stress_night_tmin))
                ? `
                    <div class="popup-row">
                        ${currentLanguage === "sr" ? "Ноћни минимум" : "Overnight minimum"}:
                        <b>${formatNumber(data.heat_stress_night_tmin, 1)} °C</b>
                    </div>
                `
                : ""
            }

            ${
                heatImpact
                ? `
                    <div class="popup-risk-box">
                        <div class="popup-section">${t.impacts}</div>
                        <div>${heatImpact.impact}</div>

                        <div class="popup-section">${t.recommendations}</div>
                        <div>${heatImpact.recommendation}</div>

                        <div class="popup-note">${t.riskNote}</div>
                    </div>
                `
                : ""
            }
        `;
    }


    /* --------------------------------------------------------
       FIRES: FWI is the daily background danger; HDW is the exact
       3-hour atmospheric signal. Show only yellow-or-higher components.
       -------------------------------------------------------- */

    if (
        data.fire_fwi_available
        && fireFwiRiskLevel(data) >= 1
    ) {
        significantCount += 1;
        const ir = fireFwiImpactRecommendation(data);
        html += `
            <div class="popup-section">${t.fireDanger}</div>
            <div class="popup-row">${fireFwiValueLabel(data)}</div>
            <div class="popup-row">${t.fireCategory}: <b>${translatedFireFwiCategory(data)}</b></div>
            <div class="popup-risk-box">
                <div class="popup-section">${t.impacts}</div><div>${ir.impact}</div>
                <div class="popup-section">${t.recommendations}</div><div>${ir.recommendation}</div>
            </div>`;
    }

    if (
        data.fire_hdw_available
        && fireHdwRiskLevel(data) >= 1
    ) {
        significantCount += 1;
        const ir = fireHdwImpactRecommendation(data);
        html += `
            <div class="popup-section">${t.fireSpread}</div>
            <div class="popup-row">HDW: <b>${formatNumber(data.fire_hdw, 1)}</b></div>
            <div class="popup-row">${t.fireHdwCategory}: <b>${translatedFireHdwCategory(data)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Климатолошки перцентил" : "Climatological percentile"}: <b>${Number.isFinite(Number(data.fire_hdw_percentile)) ? formatNumber(data.fire_hdw_percentile, 0) + "." : "—"}</b></div>
            <div class="popup-risk-box">
                <div class="popup-section">${t.impacts}</div><div>${ir.impact}</div>
                <div class="popup-section">${t.recommendations}</div><div>${ir.recommendation}</div>
            </div>`;
    }

    /* --------------------------------------------------------
       AIR QUALITY + UV: show yellow-or-higher module signals.
       -------------------------------------------------------- */

    if (data.air_quality_available && airQualityRiskLevel(data) >= 1) {
        significantCount += 1;
        const ir = airQualityImpactRecommendation(data);
        html += `
            <div class="popup-section">${t.airQualityGroup}</div>
            <div class="popup-row">${t.airEuropeanAqi}: <b>${formatNumber(data.european_aqi, 0)}</b></div>
            <div class="popup-row">${t.airDominant}: <b>${translatedPollutantName(data.air_dominant_pollutant)}</b></div>
            <div class="popup-risk-box">
                <div class="popup-section">${t.impacts}</div><div>${ir.impact}</div>
                <div class="popup-section">${t.recommendations}</div><div>${ir.recommendation}</div>
            </div>`;
    }

    if (data.uv_available && uvRiskLevel(data) >= 1) {
        significantCount += 1;
        const ir = uvImpactRecommendation(data);
        html += `
            <div class="popup-section">${t.uvGroup}</div>
            <div class="popup-row">${t.uvIndex}: <b>${formatNumber(data.uv_index, 1)}</b> — ${translatedUvCategory(data)}</div>
            <div class="popup-risk-box">
                <div class="popup-section">${t.impacts}</div><div>${ir.impact}</div>
                <div class="popup-section">${t.recommendations}</div><div>${ir.recommendation}</div>
            </div>`;
    }

    /* --------------------------------------------------------
       WIND v2: one public risk layer. Internal threshold
       probabilities live in the expert-details section.
       -------------------------------------------------------- */
    if (
        typeof windV2RiskLevel === "function"
        && windV2RiskLevel(data) >= 1
    ) {
        significantCount += 1;
        html += windV2SummaryHtml(data, { expert: false });
    }

    if (significantCount === 0) {
        return `
            <div class="overview-muted">
                ${currentLanguage === "sr"
                    ? "Нема параметара са значајним ризиком у овом 3-часовном термину."
                    : "No parameters with significant risk in this 3-hour period."}
            </div>
        `;
    }

    return availabilityText + html;
}


/* ============================================================
   DATE FORMAT
   ============================================================ */

function formatValidTime(
    isoString
) {
    if (!isoString) return "—";

    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return "—";

    const locale = currentLanguage === "sr" ? "sr-RS" : "en-GB";
    const value = date.toLocaleString(
        locale,
        {
            timeZone: METEORISK_TIME_ZONE,
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }
    );

    return value + (currentLanguage === "sr" ? " локално" : " local");
}

function formatTechnicalUtcTime(isoString) {
    if (!isoString) return "—";
    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return "—";

    return date.toLocaleString(
        currentLanguage === "sr" ? "sr-RS" : "en-GB",
        {
            timeZone: "UTC",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        }
    ) + " UTC";
}


/* ============================================================
   COLORS
   ============================================================ */

function getProbabilityColor(
    value
) {

    if (
        value === null
        || value === undefined
        || isNaN(value)
    ) {
        return "#cccccc";
    }

    if (value >= 50) {
        return "#7b3294";
    }

    if (value >= 30) {
        return "#d7191c";
    }

    if (value >= 20) {
        return "#fdae61";
    }

    if (value >= 10) {
        return "#ffffbf";
    }

    return "#a6d96a";
}


/* ============================================================
   STYLE
   ============================================================ */

const STORM_PUBLIC_THRESHOLDS = Object.freeze({
    thunderYellow: 20.0,
    hailOrange: 30.0,
    hailRed: 60.0,
    largeHailRed: 40.0,
    hailPurple: 80.0,
    largeHailPurple: 60.0,
    veryLargeHailPurple: 40.0
});


function stormPublicProbability(data, hazardKey) {
    if (!data) return 0;

    const value = Number(data[hazardKey]);
    return Number.isFinite(value) ? value : 0;
}


function stormPublicAssessment(data) {
    if (!data || !data.storms_multimodel) {
        return {
            level: 0,
            drivingHazard: null
        };
    }

    const thunder = stormPublicProbability(data, "thunder");
    const hail = stormPublicProbability(data, "hail");
    const largeHail = stormPublicProbability(data, "large_hail");
    const veryLargeHail = stormPublicProbability(data, "very_large_hail");

    /*
       OLUJA v2.1 - DEVELOPMENTAL PUBLIC CLASSIFICATION

       PURPLE:
         P(hail) >= 50%
         OR P(hail >= 2 cm) >= 35%
         OR P(hail >= 5 cm) >= 15%

       RED:
         P(hail) >= 35%
         OR P(hail >= 2 cm) >= 20%

       ORANGE:
         P(hail) >= 15%

       YELLOW:
         P(thunderstorm) >= 20%

       Checks run from the highest level downward.
       These thresholds affect the public display only.
    */

    if (
        hail >= STORM_PUBLIC_THRESHOLDS.hailPurple
        || largeHail >= STORM_PUBLIC_THRESHOLDS.largeHailPurple
        || veryLargeHail >= STORM_PUBLIC_THRESHOLDS.veryLargeHailPurple
    ) {
        let drivingHazard = "hail";

        if (
            veryLargeHail
            >= STORM_PUBLIC_THRESHOLDS.veryLargeHailPurple
        ) {
            drivingHazard = "very_large_hail";
        } else if (
            largeHail
            >= STORM_PUBLIC_THRESHOLDS.largeHailPurple
        ) {
            drivingHazard = "large_hail";
        }

        return {
            level: 4,
            drivingHazard
        };
    }

    if (
        hail >= STORM_PUBLIC_THRESHOLDS.hailRed
        || largeHail >= STORM_PUBLIC_THRESHOLDS.largeHailRed
    ) {
        return {
            level: 3,
            drivingHazard:
                largeHail >= STORM_PUBLIC_THRESHOLDS.largeHailRed
                    ? "large_hail"
                    : "hail"
        };
    }

    if (hail >= STORM_PUBLIC_THRESHOLDS.hailOrange) {
        return {
            level: 2,
            drivingHazard: "hail"
        };
    }

    if (thunder >= STORM_PUBLIC_THRESHOLDS.thunderYellow) {
        return {
            level: 1,
            drivingHazard: "thunder"
        };
    }

    return {
        level: 0,
        drivingHazard: null
    };
}


function stormRiskLevel(data) {
    return stormPublicAssessment(data).level;
}


function stormPublicCategory(data) {
    const level = stormRiskLevel(data);

    const sr = [
        "без значајног ризика од олује",
        "могућност грмљавине",
        "повећан ризик од грмљавине, уз могућност града",
        "висок ризик од грмљавине и града",
        "изражен ризик од грмљавине и града"
    ];

    const en = [
        "no significant storm risk",
        "thunderstorm possible",
        "increased thunderstorm risk, with hail possible",
        "high risk of thunderstorms and hail",
        "pronounced risk of thunderstorms and hail"
    ];

    return (currentLanguage === "sr" ? sr : en)[level];
}


function stormPublicBadge(data) {
    const level = stormRiskLevel(data);

    const sr = [
        "без значајног ризика",
        "могућност",
        "повећан ризик",
        "висок ризик",
        "изражен ризик"
    ];

    const en = [
        "no significant risk",
        "possible",
        "increased risk",
        "high risk",
        "pronounced risk"
    ];

    return (currentLanguage === "sr" ? sr : en)[level];
}


function stormPublicConfidence(data) {
    const assessment = stormPublicAssessment(data);
    const driving = assessment.drivingHazard;

    if (!driving) {
        return data?.storm_overview_confidence || "unknown";
    }

    const prefix = stormHazardPrefix(driving);

    return data[prefix + "_confidence"]
        || data.storm_overview_confidence
        || "unknown";
}


function stormPublicThresholdNote() {
    return currentLanguage === "sr"
        ? "Развојна OLUJA v2.2 класификација: жуто — P(грмљавина) ≥ 20%; наранџасто — P(град) ≥ 30%; црвено — P(град) ≥ 60% или P(≥2 cm) ≥ 40%; љубичасто — P(град) ≥ 80% или P(≥2 cm) ≥ 60% или P(≥5 cm) ≥ 40%. Прагови још нису калибрисани на историјским случајевима."
        : "Developmental STORM v2.2 classification: yellow — P(thunderstorm) >= 20%; orange — P(hail) >= 30%; red — P(hail) >= 60% or P(>=2 cm) >= 40%; purple — P(hail) >= 80% or P(>=2 cm) >= 60% or P(>=5 cm) >= 40%. Thresholds have not yet been calibrated on historical cases.";
}



function stormImpactRecommendation(data) {
    const level = stormRiskLevel(data);

    const sr = {
        0: { impact: "", recommendation: "" },
        1: {
            impact:
                "Ако се грмљавинска појава реализује, локално су могући удари грома, краткотрајни пљускови и пролазно појачан ветар.",
            recommendation:
                "Пратите нова ажурирања. Током грмљавине избегавајте отворен простор, истакнуте положаје и заклон испод усамљеног дрвећа."
        },
        2: {
            impact:
                "Ако се појава реализује, поред грмљавине постоји повећана могућност града, јачих пљускова и краткотрајно јаког ветра, уз локалне сметње у саобраћају и активностима на отвореном.",
            recommendation:
                "Пратите развој ситуације и званична упозорења. Осетљиве активности на отвореном планирајте уз могућност брзог прекида, а возила и лаке предмете по могућности склоните на заштићено место."
        },
        3: {
            impact:
                "У случају развоја олуја, повећана је могућност јачих грмљавинских непогода са градом, интензивним пљусковима и јаким ударима ветра, уз локалну материјалну штету и поремећаје у саобраћају и пољопривреди.",
            recommendation:
                "Повећајте приправност, обезбедите предмете и возила када је то могуће и избегавајте изложене активности током приближавања олује. Пратите званична упозорења и упутства надлежних служби."
        },
        4: {
            impact:
                "Ако се најјачи ансамбл сценарио реализује, могуће су изражене грмљавинске непогоде са градом и другим опасним пратећим појавама, уз значајнију локалну штету и прекиде активности.",
            recommendation:
                "Потребан је висок степен приправности. Заштитите људе, возила и осетљиву имовину, благовремено прекините изложене активности и поступајте у складу са званичним упозорењима и упутствима надлежних служби."
        }
    };

    const en = {
        0: { impact: "", recommendation: "" },
        1: {
            impact:
                "If thunderstorms develop, local lightning, brief heavy showers and temporarily stronger wind are possible.",
            recommendation:
                "Monitor updates. During thunderstorms avoid exposed areas, elevated locations and shelter beneath isolated trees."
        },
        2: {
            impact:
                "If storms develop, hail becomes more plausible together with heavier showers and brief strong wind, with localized disruption to traffic and outdoor activities.",
            recommendation:
                "Monitor developments and official warnings. Plan exposed outdoor activities so they can be stopped quickly, and shelter vehicles and light objects where practical."
        },
        3: {
            impact:
                "If storms develop, stronger thunderstorms with hail, intense showers and strong wind gusts become more plausible, with localized damage and disruption to transport and agriculture.",
            recommendation:
                "Increase preparedness, secure loose objects and vehicles where possible, and avoid exposed activities as storms approach. Follow official warnings and instructions."
        },
        4: {
            impact:
                "If the strongest ensemble scenario develops, pronounced severe thunderstorms with hail and other hazardous accompanying phenomena are possible, with potentially significant localized damage and disruption.",
            recommendation:
                "Maintain a high level of preparedness. Protect people, vehicles and vulnerable property, stop exposed activities in time, and follow official warnings and instructions."
        }
    };

    return (currentLanguage === "sr" ? sr : en)[level] || {
        impact: "",
        recommendation: ""
    };
}


function stormPublicSignalLabel(
    hazardKey
) {
    const sr = {
        thunder:
            "Могућност грмљавинског развоја",

        hail:
            "Могућност града уз грмљавински развој",

        large_hail:
            "Могућност крупног града ≥ 2 cm уз грмљавински развој",

        very_large_hail:
            "Могућност веома крупног града ≥ 5 cm уз грмљавински развој"
    };

    const en = {
        thunder:
            "Possibility of thunderstorm development",

        hail:
            "Possibility of hail with thunderstorm development",

        large_hail:
            "Possibility of large hail ≥ 2 cm with thunderstorm development",

        very_large_hail:
            "Possibility of very large hail ≥ 5 cm with thunderstorm development"
    };

    return (
        currentLanguage === "sr"
        ? sr
        : en
    )[hazardKey] || hazardKey;
}


function stormSpatialScopeNote() {
    return currentLanguage === "sr"
        ? "Процена се односи на могућност појаве негде на територији изабране општине или у појасу до 25 km од њене границе. Појава може бити локална и не значи да ће захватити сваку локацију у општини."
        : "The assessment refers to the possibility of the phenomenon occurring somewhere within the selected municipality or within a zone up to 25 km beyond its boundary. The phenomenon may be local and does not mean that every location in the municipality will be affected.";
}


function stormExpertSignalsHtml(data) {
    if (
        !data
        || !data.storms_multimodel
    ) {
        return "";
    }

    const rows = [
        "thunder",
        "hail",
        "large_hail",
        "very_large_hail"
    ];

    return rows.map(key => {
        const prefix =
            stormHazardPrefix(key);

        const gefs =
            data[prefix + "_gefs"];

        const icon =
            data[prefix + "_icon"];

        const modelLine =
            Number.isFinite(Number(icon))
            ? `GEFS ${formatProbability(gefs)} · ICON-EU EPS ${formatProbability(icon)}`
            : `GEFS ${formatProbability(gefs)} · ICON-EU EPS —`;

        return `
            <div class="popup-row">
                ${stormPublicSignalLabel(key)}:
                <b>${formatProbability(data[key])}</b>
            </div>

            <div class="popup-note">
                ${modelLine}
            </div>
        `;
    }).join("");
}


function windRiskLevel(data) {
    if (!data || !currentModelData?.wind_available) return 0;
    return typeof windV2RiskLevel === "function"
        ? windV2RiskLevel(data)
        : 0;
}

function temperatureRiskLevel(data) {
    if (
        !data
        || !currentModelData?.temperature_available
        || !data.temperature_multimodel
    ) return 0;

    return stormColorLevelNumber(
        data.temperature_color
    );
}


function heatStressRiskLevel(data) {
    if (!data || !currentModelData?.temperature_available || !data.heat_stress_multimodel) return 0;
    return stormColorLevelNumber(data.heat_stress_color);
}

function overallRiskLevel(data) {
    return Math.max(
        stormRiskLevel(data),
        windRiskLevel(data),
        temperatureRiskLevel(data),
        heatStressRiskLevel(data),
        fireFwiRiskLevel(data),
        fireHdwRiskLevel(data),
        airQualityRiskLevel(data),
        uvRiskLevel(data)
    );
}

function overallRiskColor(level) {
    return ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"][level] || "#a6d96a";
}

function styleFeature(
    feature
) {

    const data =
        getMunicipalityData(
            feature.properties
        );

    const value = data ? data[currentHazard] : null;

    let fillColor;

    const available =
        hazardAvailability();

    const group =
        currentHazardGroup();

    if (
        group !== "overall"
        && !available[group]
    ) {
        fillColor = "#c7c7c7";

    } else if (currentHazard === "overall_risk") {
        fillColor =
            Object.values(available).some(Boolean)
            ? (
                data && anyModuleDataAvailable(data)
                ? overallRiskColor(overallRiskLevel(data))
                : "#c7c7c7"
            )
            : "#c7c7c7";

    } else if (currentHazard === "module_risk") {
        fillColor =
            data && moduleDataAvailable(data, currentModule)
            ? overallRiskColor(
                moduleRiskLevel(
                    data,
                    currentModule
                )
            )
            : "#c7c7c7";

    } else if (currentHazard === "wind_risk_level") {
        fillColor = (
            data
            && typeof windV2DataAvailable === "function"
            && windV2DataAvailable(data)
        )
            ? windV2ColorHex(data.wind_risk_level)
            : "#c7c7c7";
    } else if (
        currentHazard === "max_temperature"
        && data
        && data.temperature_multimodel
    ) {
        fillColor = stormRiskColor(
            data.temperature_color
        );
    } else if (
        currentHazard === "heat_stress"
    ) {
        fillColor =
            (
                data
                && data.heat_stress_multimodel
            )
            ? stormRiskColor(data.heat_stress_color)
            : "#c7c7c7";
    } else if (
        currentHazard === "fire_fwi"
    ) {
        fillColor =
            data && data.fire_fwi_available
            ? fireColorHex(data.fire_fwi_color)
            : "#c7c7c7";
    } else if (
        currentHazard === "fire_hdw"
    ) {
        fillColor =
            data && data.fire_hdw_available
            ? fireColorHex(data.fire_hdw_color)
            : "#c7c7c7";
    } else if (
        ["air_pm25", "air_pm10", "air_o3"].includes(currentHazard)
    ) {
        fillColor = airPollutantColorHex(data, currentHazard);
    } else if (
        currentHazard === "uv_index"
    ) {
        fillColor = data && data.uv_available
            ? environmentColorHex(data.uv_color)
            : "#c7c7c7";
    } else if (
        ["thunder", "hail", "large_hail", "very_large_hail"].includes(currentHazard)
        && data
        && data.storms_multimodel
    ) {
        const prefix = stormHazardPrefix(currentHazard);
        fillColor = stormRiskColor(
            data[prefix + "_risk_color"]
        );
    } else {
        fillColor = getProbabilityColor(value);
    }

    return {

        fillColor: fillColor,

        weight: 1,

        opacity: 1,

        color: "#555",

        fillOpacity:
            data ? 0.72 : 0.25
    };
}


/* ============================================================
   POPUP
   ============================================================ */


function modulePopupContent(data, name, moduleKey) {
    const t = translations[currentLanguage];

    const header = `
        <div class="popup-title">${name}</div>
        <div class="popup-valid">
            ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
        </div>
    `;

    if (moduleKey === "temperature") {
        const components = [];

        if (data.temperature_multimodel) {
            const ir = temperatureImpactRecommendation(data);
            components.push({
                key: "max_temperature",
                label: t.maxTemperature,
                level: temperatureRiskLevel(data),
                category: translatedTemperatureCategory(data),
                value: `${t.multimodelTmax}: <b>${formatNumber(data.max_temperature, 1)} °C</b>`,
                impact: ir.impact,
                recommendation: ir.recommendation
            });
        }

        if (data.heat_stress_multimodel) {
            const ir = thermalStressImpactRecommendation(data);
            components.push({
                key: "heat_stress",
                label: t.heatStress,
                level: heatStressRiskLevel(data),
                category: translatedHeatStressCategory(data),
                value: data.heat_stress_mode === "NIGHT"
                    ? `${currentLanguage === "sr" ? "Ноћни минимум" : "Overnight minimum"}: <b>${formatNumber(data.heat_stress_night_tmin, 1)} °C</b>`
                    : `${currentLanguage === "sr" ? "Топлотни индекс / сигнал" : "Heat index / signal"}: <b>${formatNumber(data.heat_stress, 1)} °C</b>`,
                impact: ir.impact,
                recommendation: ir.recommendation
            });
        }

        if (!components.length) return header + riskSummaryHtml({ title: t.temperatureGroup, available: false });

        const strongest = components.reduce((best, item) =>
            !best || item.level > best.level ? item : best, null);

        const technical = [
            data.temperature_multimodel ? temperatureDetailHtml(data, { technicalOnly: true }) : "",
            data.heat_stress_multimodel ? heatStressDetailHtml(data, { technicalOnly: true }) : ""
        ].join("");

        return header + riskSummaryHtml({
            title: t.temperatureGroup,
            level: strongest.level,
            category: strongest.category,
            value: strongest.value,
            impact: strongest.impact,
            recommendation: strongest.recommendation,
            meta: `${currentLanguage === "sr" ? "Доминантни параметар" : "Dominant parameter"}: ${strongest.label}`
        }) + expertDetailsHtml(
            technical,
            currentLanguage === "sr" ? "Параметри и стручни детаљи" : "Parameters and technical details"
        );
    }

    if (moduleKey === "fire") {
        const components = [];

        if (data.fire_fwi_available) {
            const ir = fireFwiImpactRecommendation(data);
            components.push({
                key: "fire_fwi",
                label: t.fireDanger,
                level: fireFwiRiskLevel(data),
                category: translatedFireFwiCategory(data),
                value: fireFwiValueLabel(data),
                impact: ir.impact,
                recommendation: ir.recommendation
            });
        }

        if (data.fire_hdw_available) {
            const ir = fireHdwImpactRecommendation(data);
            components.push({
                key: "fire_hdw",
                label: t.fireSpread,
                level: fireHdwRiskLevel(data),
                category: translatedFireHdwCategory(data),
                value: `HDW <b>${formatNumber(data.fire_hdw, 1)}</b>${Number.isFinite(Number(data.fire_hdw_percentile)) ? ` · P${formatNumber(data.fire_hdw_percentile, 0)}` : ""}`,
                impact: ir.impact,
                recommendation: ir.recommendation
            });
        }

        if (!components.length) return header + riskSummaryHtml({ title: t.fireGroup, available: false });

        const strongest = components.reduce((best, item) =>
            !best || item.level > best.level ? item : best, null);

        const technical = [
            data.fire_fwi_available ? fireFwiDetailHtml(data, { technicalOnly: true }) : "",
            data.fire_hdw_available ? fireHdwDetailHtml(data, { technicalOnly: true }) : ""
        ].join("");

        return header + riskSummaryHtml({
            title: t.fireGroup,
            level: strongest.level,
            category: strongest.category,
            value: strongest.value,
            impact: strongest.impact,
            recommendation: strongest.recommendation,
            meta: `${currentLanguage === "sr" ? "Доминантна компонента" : "Dominant component"}: ${strongest.label}`
        }) + expertDetailsHtml(
            technical,
            currentLanguage === "sr" ? "FWI / HDW и стручни детаљи" : "FWI / HDW and technical details"
        );
    }

    if (moduleKey === "air_quality") {
        if (!data.air_quality_available) {
            return header + riskSummaryHtml({ title: t.airQualityGroup, available: false });
        }
        const ir = airQualityImpactRecommendation(data);
        return header + riskSummaryHtml({
            title: t.airQualityGroup,
            level: airQualityRiskLevel(data),
            category: translatedAqiBand(data),
            badge: translatedAqiBand(data),
            value: `${t.airEuropeanAqi}: <b>${formatNumber(data.european_aqi, 0)}</b>`,
            impact: ir.impact,
            recommendation: ir.recommendation,
            meta: `${t.airDominant}: ${translatedPollutantName(data.air_dominant_pollutant)}`
        }) + expertDetailsHtml(
            airQualityDetailHtml(data, { technicalOnly: true }),
            currentLanguage === "sr" ? "Загађивачи и стручни детаљи" : "Pollutants and technical details"
        );
    }

    if (moduleKey === "uv") {
        if (!data.uv_available) {
            return header + riskSummaryHtml({ title: t.uvGroup, available: false });
        }
        const ir = uvImpactRecommendation(data);
        return header + riskSummaryHtml({
            title: t.uvGroup,
            level: uvRiskLevel(data),
            category: translatedUvCategory(data),
            badge: translatedUvCategory(data),
            value: `${t.uvIndex}: <b>${formatNumber(data.uv_index, 1)}</b>`,
            impact: ir.impact,
            recommendation: ir.recommendation
        }) + expertDetailsHtml(
            uvDetailHtml(data, { technicalOnly: true }),
            currentLanguage === "sr" ? "Стручни детаљи UV индекса" : "UV index technical details"
        );
    }

    if (moduleKey === "wind") {
        if (
            typeof windV2DataAvailable !== "function"
            || !windV2DataAvailable(data)
        ) {
            return header + riskSummaryHtml({
                title: t.windGroup,
                available: false
            });
        }

        return header + windV2SummaryHtml(data, { expert: true });
    }

    if (moduleKey === "storm") {
        if (!data.storms_multimodel) {
            return header + riskSummaryHtml({
                title: t.stormGroup,
                available: false
            });
        }

        const finalLevel = stormRiskLevel(data);
        const finalCategory = stormPublicCategory(data);
        const finalBadge = stormPublicBadge(data);
        const confidence = translatedConfidence(
            stormPublicConfidence(data)
        );
        const impactRecommendation =
            stormImpactRecommendation(data);

        const expertHtml = `
            <div class="popup-row">
                ${currentLanguage === "sr"
                    ? "Поузданост коначне процене"
                    : "Final assessment confidence"}:
                <b>${confidence}</b>
            </div>

            <div class="popup-section">
                ${currentLanguage === "sr"
                    ? "Компонентни ансамбл сигнали"
                    : "Component ensemble signals"}
            </div>

            ${stormExpertSignalsHtml(data)}

            <div class="popup-note">
                ${currentLanguage === "sr"
                    ? "Компонентни проценти су стручни дијагностички сигнали и немају засебне јавне боје. Јавни производ је једна степенована процена ризика: ОЛУЈА."
                    : "Component percentages are expert diagnostic signals and do not have separate public colours. The public product is one graded STORM risk assessment."}
            </div>

            <div class="popup-note">
                <b>${currentLanguage === "sr"
                    ? "Просторни обухват:"
                    : "Spatial scope:"}</b>
                ${stormSpatialScopeNote()}
            </div>

            <div class="popup-note">
                ${stormPublicThresholdNote()}
            </div>
        `;

        return header
            + riskSummaryHtml({
                title: t.stormGroup,
                level: finalLevel,
                category: finalCategory,
                badge: finalBadge,
                value: currentLanguage === "sr"
                    ? "Развојна ансамбл процена ризика"
                    : "Developmental ensemble risk assessment",
                impact: impactRecommendation.impact,
                recommendation: impactRecommendation.recommendation
            })
            + expertDetailsHtml(
                expertHtml,
                currentLanguage === "sr"
                    ? "Стручни детаљи OLUJA v2"
                    : "STORM v2 expert details"
            );
    }

    return header;
}


function popupContentCore(
    properties
) {

    const t = translations[currentLanguage];
    const data = getMunicipalityData(properties);
    const name = municipalityName(properties);

    if (!data) {
        return `
            <div class="popup-title">${name}</div>
            <div>${t.loadError}</div>
        `;
    }

    if (
        currentHazard !== "overall_risk"
        && !currentHazardAvailable()
    ) {
        return unavailableHtml(name);
    }

    /* ========================================================
       CENTRAL / OVERALL MAP
       Only yellow-or-higher hazards are shown.
       ======================================================== */

    if (currentHazard === "overall_risk") {
        return `
            <div class="popup-title">${name}</div>

            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
            </div>

            ${overallRiskSummaryHtml(data)}
            ${overallPopupHazardsHtml(data)}
        `;
    }

    if (currentHazard === "module_risk") {
        return modulePopupContent(
            data,
            name,
            currentModule
        );
    }


    /* ========================================================
       DETAIL MODE - WIND v2
       ======================================================== */

    if (currentHazard === "wind_risk_level") {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
            </div>
            ${windV2SummaryHtml(data, { expert: true })}
        `;
    }

    /* ========================================================
       DETAIL MODE - MULTIMODEL STORMS
       ======================================================== */

    if (currentHazard === "max_temperature") {

        return `
            <div class="popup-title">${name}</div>

            <div class="popup-valid">
                ${currentLanguage === "sr" ? "Дневна прогноза" : "Daily forecast"}:
                ${data.temperature_date || localDateKeyBelgrade(currentModelData?.valid_time) || "—"}
            </div>

            ${temperatureDetailHtml(data)}
        `;
    }


    if (currentHazard === "heat_stress") {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${currentLanguage === "sr" ? "Важи за" : "Valid for"}:
                ${(() => {
                    const sourceTime =
                        data.heat_stress_local_time
                        || data.heat_stress_valid_time
                        || currentModelData?.valid_time
                        || "";
                    const d = sourceTime ? new Date(sourceTime) : null;
                    if (!d || !Number.isFinite(d.getTime())) return "—";
                    return new Intl.DateTimeFormat(
                        currentLanguage === "sr" ? "sr-RS" : "en-GB",
                        {
                            timeZone: "Europe/Belgrade",
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false
                        }
                    ).format(d);
                })()}
            </div>
            ${heatStressDetailHtml(data)}
        `;
    }

    if (currentHazard === "fire_fwi") {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${currentLanguage === "sr" ? "Дневна прогноза" : "Daily forecast"}:
                ${data.fire_fwi_date || localDateKeyBelgrade(currentModelData?.valid_time) || "—"}
            </div>
            ${fireFwiDetailHtml(data)}
        `;
    }

    if (currentHazard === "fire_hdw") {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(data.fire_hdw_valid_time || currentModelData.valid_time)}
            </div>
            ${fireHdwDetailHtml(data)}
        `;
    }

    if (["air_pm25", "air_pm10", "air_o3"].includes(currentHazard)) {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
            </div>
            ${airPollutantDetailHtml(data, currentHazard)}
        `;
    }

    if (currentHazard === "uv_index") {
        return `
            <div class="popup-title">${name}</div>
            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
            </div>
            ${uvDetailHtml(data)}
        `;
    }

    if (
        ["thunder", "hail", "large_hail", "very_large_hail"].includes(currentHazard)
        && data.storms_multimodel
    ) {
        return `
            <div class="popup-title">${name}</div>

            <div class="popup-valid">
                ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
            </div>

            <div class="popup-section">${stormHazardLabel(currentHazard)}</div>

            ${multimodelStormDetailHtml(data, currentHazard)}

            ${hazardInfoHtmlForHazard(currentHazard, data)}
        `;
    }

    /* ========================================================
       DETAIL MODE - STORM PARAMETER
       ======================================================== */

    const hazardLabels = {
        thunder: t.thunder,
        hail: t.hail,
        large_hail: t.largeHail,
        very_large_hail: t.veryLargeHail
    };

    return `
        <div class="popup-title">${name}</div>

        <div class="popup-valid">
            ${t.valid}: ${formatValidTime(currentModelData.valid_time)}
        </div>

        <div class="popup-section">${hazardLabels[currentHazard] || currentHazard}</div>

        <div class="popup-row">
            ${[
                "thunder",
                "hail",
                "large_hail",
                "very_large_hail"
            ].includes(currentHazard)
                ? stormPublicSignalLabel(currentHazard)
                : (
                    currentLanguage === "sr"
                    ? "Ансамбл сигнал"
                    : "Ensemble signal"
                )}:
            <b>${formatProbability(data[currentHazard])}</b>
        </div>

        ${[
            "thunder",
            "hail",
            "large_hail",
            "very_large_hail"
        ].includes(currentHazard)
            ? `
                <div class="popup-note">
                    <b>${currentLanguage === "sr"
                        ? "Просторни обухват:"
                        : "Spatial scope:"}</b>
                    ${stormSpatialScopeNote()}
                </div>
            `
            : ""}

        <div class="popup-section">${t.modelParameters}</div>

        <div class="popup-row">${t.instability}: <b>${formatNumber(data.cape,0)} J/kg</b></div>
        <div class="popup-row">${t.shear}: <b>${formatNumber(data.shear,1)} m/s</b></div>
        <div class="popup-row">${t.humidity}: <b>${formatNumber(data.rh700,0)}%</b></div>
        <div class="popup-row">${t.grid}: <b>${data.grid_points ?? "—"}</b></div>

        ${hazardInfoHtmlForHazard(currentHazard, data)}
    `;
}




/* ============================================================
   METEORISK M1.0.1 DESKTOP POPUP ACTION FIX
   One renderer for desktop Leaflet popup and mobile detail sheet.
   ============================================================ */
function popupContent(properties) {
    const html = popupContentCore(properties);
    return html + mrPopupActionsHtml();
}

/* ============================================================
   MOBILE DETAIL PANEL
   ============================================================ */

function isMobileView() {
    return window.matchMedia("(max-width: 800px)").matches;
}

function openMobileDetail(properties) {
    if (!isMobileView()) return false;

    const panel = document.getElementById("mobile-detail-panel");
    const heading = document.getElementById("mobile-detail-heading");
    const body = document.getElementById("mobile-detail-body");

    heading.textContent = municipalityName(properties);
    body.innerHTML = popupContent(properties);
    mrInjectPopupActions(body);

    /* The panel header already contains the municipality name. */
    const duplicateTitle = body.querySelector(".popup-title");
    if (duplicateTitle) duplicateTitle.remove();

    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("mobile-detail-open");
    panel.scrollTop = 0;
    map.closePopup();
    return true;
}

function closeMobileDetail() {
    const panel = document.getElementById("mobile-detail-panel");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("mobile-detail-open");
}

document.getElementById("mobile-detail-close").addEventListener("click", closeMobileDetail);

document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        closeMobileDetail();
        closeOverview();
    }
});

/* ============================================================
   FEATURE EVENTS
   ============================================================ */

function highlightFeature(
    event
) {

    event.target.setStyle(
        {
            weight: 3,
            color: "#222",
            fillOpacity: 0.85
        }
    );

    event.target.bringToFront();
}


function resetHighlight(
    event
) {

    if (
        geojsonLayer
    ) {

        geojsonLayer.resetStyle(
            event.target
        );
    }
}


function onEachFeature(
    feature,
    layer
) {

    layer.bindPopup(
        popupContent(
            feature.properties
        ),
        {
            maxWidth: 420
        }
    );


    layer.on(
        {

            mouseover:
                highlightFeature,

            mouseout:
                resetHighlight,

            click:
                function() {

                    selectedLayer =
                        this;

                    selectedMunicipalityId =
                        municipalityId(
                            feature.properties
                        );

                    if (openMobileDetail(feature.properties)) {
                        return;
                    }

                    this.setPopupContent(
                        popupContent(
                            feature.properties
                        )
                    );
                }
        }
    );
}


/* ============================================================
   LOAD MODEL DATA
   ============================================================ */

async function loadForecast(
    timeIndex
) {

    const t =
        translations[
            currentLanguage
        ];

    timeIndex =
        Math.max(
            0,
            Math.min(
                timeIndex,
                FORECAST_HOURS.length - 1
            )
        );

    const hour =
        FORECAST_HOURS[
            timeIndex
        ];

    document
        .querySelector(
            ".timeline-panel"
        )
        .classList.add(
            "loading-time"
        );

    try {

        const baseGefHour =
            await baseGefForecastHourForSlot(
                hour
            );

        const response =
            await fetch(
                forecastFile(
                    baseGefHour
                ),
                {
                    cache:
                        "no-store"
                }
            );

        if (
            !response.ok
        ) {

            throw new Error(
                "HTTP "
                +
                response.status
            );
        }

        const data =
            await response.json();

        await applyMultimodelStormsOverlay(
            data,
            hour
        );

        await applyWindV2Overlay(data);

        await applyTemperatureOverlay(
            data
        );

        await applyHeatStressTimelineOverlay(data);
        await applyFireOverlay(data);
        await applyEnvironmentOverlay(data);

        data.fire_available = Boolean(data.fire_hdw_available);

        currentModelData =
            data;

        currentTimeIndex =
            timeIndex;

        currentForecastHour =
            hour;

        document
            .getElementById(
                "time-slider"
            )
            .value =
                timeIndex;

        updateTimelineLabels();

        updateHeader();

        updateLegend();

        redrawMap();

        restoreSelectedMunicipality();

        if (selectedLayer && isMobileView() && document.getElementById("mobile-detail-panel").classList.contains("open")) {
            openMobileDetail(selectedLayer.feature.properties);
        }

        updateTimeButtons();

    }

    catch (error) {

        console.error(
            error
        );

        showStatus(
            t.loadError,
            5000
        );
    }

    finally {

        document
            .querySelector(
                ".timeline-panel"
            )
            .classList.remove(
                "loading-time"
            );
    }
}


/* ============================================================
   REDRAW
   ============================================================ */

function redrawMap() {

    if (
        !geojsonLayer
    ) {
        return;
    }

    geojsonLayer.setStyle(
        styleFeature
    );

    geojsonLayer.eachLayer(
        layer => {

            if (
                layer.feature
                &&
                layer.feature.properties
            ) {

                layer.setPopupContent(
                    popupContent(
                        layer.feature.properties
                    )
                );
            }
        }
    );
}


/* ============================================================
   RESTORE SELECTED MUNICIPALITY
   ============================================================ */

function restoreSelectedMunicipality() {

    if (
        !selectedMunicipalityId
        ||
        !geojsonLayer
    ) {
        return;
    }

    geojsonLayer.eachLayer(
        layer => {

            const id =
                municipalityId(
                    layer.feature.properties
                );

            if (
                id ===
                selectedMunicipalityId
            ) {

                selectedLayer =
                    layer;

                layer.setPopupContent(
                    popupContent(
                        layer.feature.properties
                    )
                );

                if (
                    layer.isPopupOpen()
                ) {

                    layer.openPopup();
                }
            }
        }
    );
}


/* ============================================================
   INITIALIZE DATA
   ============================================================ */

async function initializeData() {

    try {

        /* ----------------------------------------------------
           HAZARD INFO
           ---------------------------------------------------- */

        const hazardResponse =
            await fetch(
                HAZARD_INFO_FILE,
                {
                    cache:
                        "no-store"
                }
            );

        if (
            !hazardResponse.ok
        ) {

            throw new Error(
                "Hazard info HTTP "
                +
                hazardResponse.status
            );
        }

        hazardInfo =
            await hazardResponse.json();


        /* ----------------------------------------------------
           GEOMETRY
           ---------------------------------------------------- */

        const response =
            await fetch(
                GEOMETRY_FILE
            );

        if (
            !response.ok
        ) {

            throw new Error(
                "Geometry HTTP "
                +
                response.status
            );
        }

        geometryData =
            await response.json();


        /* ----------------------------------------------------
           AVAILABILITY-AWARE TIMELINE
           ---------------------------------------------------- */

        await loadAllForecasts();

        await buildTimelineSlots();

        if (!timelineSlots.length) {
            throw new Error(
                "No current or future forecast products are available."
            );
        }

        await showTimelineSlot(0);


        /* ----------------------------------------------------
           MAP LAYER
           ---------------------------------------------------- */

        geojsonLayer =
            L.geoJSON(
                geometryData,
                {
                    style:
                        styleFeature,

                    onEachFeature:
                        onEachFeature
                }
            )
            .addTo(
                map
            );


        map.fitBounds(
            geojsonLayer.getBounds(),
            {
                padding:
                    [15,15]
            }
        );

        /* First paint is complete only now: data + geometry + map layer.
           Refresh availability labels and map once more to avoid false
           "all unavailable" state on initial page load. */
        appReady = true;
        hideAppLoader();
        updateHazardAvailabilityLabels();
        updateHeader();
        updateLegend();
        redrawMap();
        restoreSelectedMunicipality();


        redrawMap();

    }

    catch (error) {

        console.error(
            error
        );

        showStatus(
            currentLanguage === "sr"
            ? "Грешка при учитавању података."
            : "Error loading data.",
            8000
        );
        showAppLoaderError();
    }
}


/* ============================================================
   TIMELINE LABELS
   ============================================================ */

function updateTimelineLabels() {

    if (!currentModelData) {
        return;
    }

    const t =
        translations[currentLanguage];

    document.getElementById(
        "valid-time-label"
    ).textContent =
        formatValidTime(
            currentModelData.valid_time
        );

    document.getElementById(
        "lead-time-label"
    ).textContent =
        t.lead + ": " + formatLeadHour(currentModelData.valid_time)
        + (currentLanguage === "sr"
            ? " · локално време"
            : " · local time");
}


/* ============================================================
   TIMELINE CONTROLS
   ============================================================ */

function updateTimeButtons() {

    document.getElementById(
        "previous-time"
    ).disabled =
        timelineSlotIndex === 0;

    document.getElementById(
        "next-time"
    ).disabled =
        timelineSlotIndex ===
        timelineSlots.length - 1;
}


document.getElementById(
    "previous-time"
).addEventListener(
    "click",
    () => {
        stopPlay();
        showTimelineSlot(
            timelineSlotIndex - 1
        );
    }
);


document.getElementById(
    "next-time"
).addEventListener(
    "click",
    () => {
        stopPlay();
        showTimelineSlot(
            timelineSlotIndex + 1
        );
    }
);


document.getElementById(
    "time-slider"
).addEventListener(
    "input",
    event => {
        stopPlay();

        showTimelineSlot(
            Number(
                event.target.value
            )
        );
    }
);


/* ============================================================
   PLAY / PAUSE
   ============================================================ */

document
    .getElementById(
        "play-time"
    )
    .addEventListener(
        "click",
        () => {

            if (
                isPlaying
            ) {

                stopPlay();

            } else {

                startPlay();
            }
        }
    );


function startPlay() {

    if (
        isPlaying
    ) {
        return;
    }

    isPlaying =
        true;

    document
        .getElementById(
            "play-time"
        )
        .textContent =
            "⏸";

    playTimer =
        setInterval(
            () => {

                let next =
                    timelineSlotIndex + 1;

                if (
                    next >=
                    timelineSlots.length
                ) {
                    next = 0;
                }

                showTimelineSlot(
                    next
                );

            },
            1300
        );
}


function stopPlay() {

    isPlaying =
        false;

    document
        .getElementById(
            "play-time"
        )
        .textContent =
            "▶";

    if (
        playTimer
    ) {

        clearInterval(
            playTimer
        );

        playTimer =
            null;
    }
}


/* ============================================================
   HAZARD CHANGE
   ============================================================ */

document
    .querySelectorAll(
        ".layer-button"
    )
    .forEach(
        button => {

            button.addEventListener(
                "click",
                function() {

                    currentHazard =
                        this.dataset.layer;

                    currentModule =
                        moduleForParameter(
                            currentHazard
                        );

                    document
                        .querySelectorAll(
                            ".layer-button"
                        )
                        .forEach(
                            btn =>
                                btn.classList.remove(
                                    "active"
                                )
                        );

                    this.classList.add(
                        "active"
                    );

                    updateHazardAvailabilityLabels();
                    redrawMap();
                    updateLegend();

                    if (selectedLayer) {
                        const properties = selectedLayer.feature.properties;

                        if (isMobileView() && document.getElementById("mobile-detail-panel").classList.contains("open")) {
                            openMobileDetail(properties);
                        } else {
                            selectedLayer.setPopupContent(popupContent(properties));
                            selectedLayer.openPopup();
                        }
                    }
                }
            );
        }
    );


/* ============================================================
   STORM GROUP
   ============================================================ */

const stormGroupButton =
    document.getElementById("storm-group-button");

const stormSubcontrols =
    document.getElementById("storm-subcontrols");

function refreshSelectedMunicipalityPopup() {
    if (!selectedLayer) return;

    const properties =
        selectedLayer.feature.properties;

    if (
        isMobileView()
        && document
            .getElementById("mobile-detail-panel")
            .classList.contains("open")
    ) {
        openMobileDetail(properties);
    } else {
        selectedLayer.setPopupContent(
            popupContent(properties)
        );
    }
}


/* MeteoRisk M1.1.4: explicit active map view.
   The default map is overall risk; a dominant FIRE signal must not look
   like the FIRE module was automatically selected. */
function activeViewModuleLabel(group) {
    const labels = currentLanguage === "sr"
        ? {
            storm: "⛈ ОЛУЈА",
            wind: "💨 ВЕТАР",
            temperature: "🌡 ТЕМПЕРАТУРА",
            fire: "🔥 ПОЖАРИ",
            air_quality: "≋ КВАЛИТЕТ ВАЗДУХА",
            uv: "🌞 UV ИНДЕКС"
        }
        : {
            storm: "⛈ STORM",
            wind: "💨 WIND",
            temperature: "🌡 TEMPERATURE",
            fire: "🔥 FIRES",
            air_quality: "≋ AIR QUALITY",
            uv: "🌞 UV INDEX"
        };

    return labels[group] || (
        currentLanguage === "sr"
        ? "ИЗАБРАНИ МОДУЛ"
        : "SELECTED MODULE"
    );
}


function updateActiveViewIndicator() {
    const banner = document.getElementById("active-view-banner");
    const title = document.getElementById("active-view-title");
    const description = document.getElementById("active-view-description");
    const icon = banner
        ? banner.querySelector(".mr-active-view-icon")
        : null;

    if (!banner || !title || !description) {
        return;
    }

    if (currentHazard === "overall_risk" || !currentModule) {
        if (icon) icon.textContent = "⚠";
        title.textContent =
            currentLanguage === "sr"
            ? "УКУПАН РИЗИК"
            : "OVERALL RISK";
        description.textContent =
            currentLanguage === "sr"
            ? "Приказује највиши ризик од свих доступних опасности."
            : "Shows the highest risk across all available hazards.";
        return;
    }

    const moduleLabel = activeViewModuleLabel(currentModule);
    const moduleIconMatch = moduleLabel.match(/^(\S+)\s+/);

    if (icon) {
        icon.textContent =
            moduleIconMatch
            ? moduleIconMatch[1]
            : "●";
    }

    title.textContent =
        moduleLabel.replace(/^(\S+)\s+/, "");

    if (currentHazard === "module_risk") {
        description.textContent =
            currentLanguage === "sr"
            ? "Приказује највиши ризик у изабраном модулу."
            : "Shows the highest risk within the selected module.";
    } else {
        description.textContent =
            currentLanguage === "sr"
            ? "Приказује изабрани параметар овог модула."
            : "Shows the selected parameter within this module.";
    }
}


function setOverallRiskView() {
    currentModule = null;
    currentHazard = "overall_risk";

    document
        .querySelectorAll(".layer-button")
        .forEach(
            btn => btn.classList.remove("active")
        );

    redrawMap();
    updateLegend();
    refreshSelectedMunicipalityPopup();
}


function setModuleRiskView(group) {
    currentModule = group;
    currentHazard = "module_risk";

    document
        .querySelectorAll(".layer-button")
        .forEach(
            btn => btn.classList.remove("active")
        );

    redrawMap();
    updateLegend();
    refreshSelectedMunicipalityPopup();
}


function openHazardGroup(group) {
    const stormOpen = group === "storm";
    const windOpen = group === "wind";
    const temperatureOpen = group === "temperature";
    const fireOpen = group === "fire";
    const airQualityOpen = group === "air_quality";
    const uvOpen = group === "uv";

    /* OLUJA is one public layer; its hidden diagnostic submenu never opens. */
    stormSubcontrols.classList.remove("open");
    stormGroupButton.classList.toggle("open", stormOpen);

    windSubcontrols.classList.toggle("open", windOpen);
    windGroupButton.classList.toggle("open", windOpen);

    temperatureSubcontrols.classList.toggle("open", temperatureOpen);
    temperatureGroupButton.classList.toggle("open", temperatureOpen);

    fireSubcontrols.classList.toggle("open", fireOpen);
    fireGroupButton.classList.toggle("open", fireOpen);

    airQualitySubcontrols.classList.toggle("open", airQualityOpen);
    airQualityGroupButton.classList.toggle("open", airQualityOpen);

    uvGroupButton.classList.toggle("open", uvOpen);

    /* Architectural rule:
       clicking the module shows the strongest risk INSIDE that module.
       Clicking a sub-parameter then shows only that parameter. */
    setModuleRiskView(group);
    updateHazardAvailabilityLabels();
}

stormGroupButton.addEventListener(
    "click",
    () => {
        if (
            currentModule === "storm"
            && currentHazard === "module_risk"
        ) {
            stormGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("storm");
        }
    }
);

const windGroupButton = document.getElementById("wind-group-button");
const windSubcontrols = document.getElementById("wind-subcontrols");

windGroupButton.addEventListener(
    "click",
    () => {
        if (windSubcontrols.classList.contains("open")) {
            windSubcontrols.classList.remove("open");
            windGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("wind");
        }
    }
);


const temperatureGroupButton =
    document.getElementById("temperature-group-button");

const temperatureSubcontrols =
    document.getElementById("temperature-subcontrols");

// Heat-stress button is injected here so index.html does not need a manual edit.
if (temperatureSubcontrols && !document.getElementById("btn-heat-stress")) {
    const heatButton = document.createElement("button");
    heatButton.id = "btn-heat-stress";
    heatButton.className = "layer-button";
    heatButton.dataset.layer = "heat_stress";
    heatButton.textContent = translations[currentLanguage].heatStress;
    temperatureSubcontrols.appendChild(heatButton);
    heatButton.addEventListener("click", function() {
        currentHazard = this.dataset.layer;
        currentModule = moduleForParameter(currentHazard);
        document.querySelectorAll(".layer-button").forEach(btn => btn.classList.remove("active"));
        this.classList.add("active");
        updateHazardAvailabilityLabels();
        redrawMap();
        updateLegend();
        if (selectedLayer) {
            const properties = selectedLayer.feature.properties;
            if (isMobileView() && document.getElementById("mobile-detail-panel").classList.contains("open")) openMobileDetail(properties);
            else selectedLayer.bindPopup(popupContent(properties), { maxWidth: 420 }).openPopup();
        }
    });
}

temperatureGroupButton.addEventListener(
    "click",
    () => {
        if (temperatureSubcontrols.classList.contains("open")) {
            temperatureSubcontrols.classList.remove("open");
            temperatureGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("temperature");
        }
    }
);

const fireGroupButton = document.getElementById("fire-group-button");
const fireSubcontrols = document.getElementById("fire-subcontrols");

fireGroupButton.addEventListener(
    "click",
    () => {
        if (fireSubcontrols.classList.contains("open")) {
            fireSubcontrols.classList.remove("open");
            fireGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("fire");
        }
    }
);

const airQualityGroupButton = document.getElementById("air-quality-group-button");
const airQualitySubcontrols = document.getElementById("air-quality-subcontrols");

airQualityGroupButton.addEventListener(
    "click",
    () => {
        if (airQualitySubcontrols.classList.contains("open")) {
            airQualitySubcontrols.classList.remove("open");
            airQualityGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("air_quality");
        }
    }
);

const uvGroupButton = document.getElementById("uv-group-button");

uvGroupButton.addEventListener(
    "click",
    () => {
        if (currentModule === "uv" && currentHazard === "module_risk") {
            uvGroupButton.classList.remove("open");
            setOverallRiskView();
        } else {
            openHazardGroup("uv");
        }
    }
);


/* ============================================================
   FIVE-DAY MUNICIPALITY OVERVIEW
   ============================================================ */

async function loadAllForecasts() {

    /*
       MeteoRisk M1.1.3: defer non-core overlays until a timeline slot is rendered.

       IMPORTANT:
       - Keep the original 40-slot core forecast schedule and its valid_time values.
       - Keep STORMS overlay here because it also defines the public +003...+024
         mapping to the underlying GEFS file.
       - Temperature, thermal stress, FIRE, AQ and UV are attached later by
         dataForTimelineSlot(), for the exact slot being displayed/aggregated.
       This avoids doing the same heavy overlay work for all 40 files before
       first paint, without reconstructing or changing the authoritative timeline.
    */

    if (allForecastData) {
        return allForecastData;
    }

    const responses = await Promise.all(
        FORECAST_HOURS.map(
            async hour => {

                const baseGefHour =
                    await baseGefForecastHourForSlot(
                        hour
                    );

                const response = await fetch(
                    forecastFile(baseGefHour),
                    { cache: "no-store" }
                );

                if (!response.ok) {
                    throw new Error(
                        "Forecast HTTP "
                        + response.status
                        + " for f"
                        + String(hour).padStart(3, "0")
                    );
                }

                const data = await response.json();

                /*
                   STORMS must remain attached to the public slot here.
                   For +003...+024, baseGefHour may intentionally differ from
                   the public hour (e.g. public +003 -> older GEFS f033).
                */
                await applyMultimodelStormsOverlay(
                    data,
                    hour
                );

                /* VETAR v2 is attached later by actual valid_time. */
                data.wind_available = false;
                data.wind_v2_available = false;

                data.storms_available =
                    Boolean(
                        data.storms_multimodel
                        && data.storms_multimodel_matches > 0
                    );

                /*
                   Non-core overlays are intentionally left for
                   dataForTimelineSlot(). Explicit false values prevent stale
                   availability inherited from a core JSON from leaking into UI.
                */
                data.temperature_multimodel = false;
                data.temperature_available = false;
                data.heat_stress_multimodel = false;
                data.fire_fwi_available = false;
                data.fire_hdw_available = false;
                data.fire_available = false;
                data.air_quality_available = false;
                data.uv_available = false;

                return data;
            }
        )
    );

    allForecastData = responses;
    return responses;
}


function formatOverviewMoment(isoString) {
    return formatValidTime(isoString);
}


function overviewWindowIntersectsSelectedDate(
    startIso,
    endIso
) {
    if (!overviewSelectedDate) {
        return true;
    }

    const startKey =
        localDateKeyBelgrade(startIso);

    const endKey =
        localDateKeyBelgrade(endIso);

    if (!startKey || !endKey) {
        return false;
    }

    return (
        startKey <= overviewSelectedDate
        && endKey >= overviewSelectedDate
    );
}


function filterOverviewWindowsForSelectedDate(
    windows
) {
    if (!overviewSelectedDate) {
        return windows;
    }

    return windows.filter(
        window =>
            overviewWindowIntersectsSelectedDate(
                window.start,
                window.end
            )
    );
}


function formatOverviewInterval(
    startIso,
    endIso,
    options = {}
) {
    if (!startIso || !endIso) {
        return "—";
    }

    const start = new Date(startIso);
    const end = new Date(endIso);

    if (
        !Number.isFinite(start.getTime())
        || !Number.isFinite(end.getTime())
    ) {
        return "—";
    }

    const startKey =
        localDateKeyBelgrade(startIso);

    const endKey =
        localDateKeyBelgrade(endIso);

    const locale =
        currentLanguage === "sr"
        ? "sr-RS"
        : "en-GB";

    const timeOptions = {
        timeZone: METEORISK_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    };

    const clipToSelectedDay =
        Boolean(
            options.clipToSelectedDay
            && overviewSelectedDate
        );

    /*
       IMPORTANT:
       The 3-hour forecast grid can have first local timestamps at 01/02 h.
       If a risk window already existed in the previous forecast term before
       local midnight, the selected-day display is clipped to 00:00.
       No model value is invented: continuity must exist in the previous term.
    */
    if (
        clipToSelectedDay
        && overviewWindowIntersectsSelectedDate(
            startIso,
            endIso
        )
    ) {
        const startText =
            startKey < overviewSelectedDate
            ? "00:00"
            : start.toLocaleTimeString(
                locale,
                timeOptions
            );

        const endText =
            endKey > overviewSelectedDate
            ? "24:00"
            : end.toLocaleTimeString(
                locale,
                timeOptions
            );

        return (
            formatOverviewDateKey(
                overviewSelectedDate
            )
            + " "
            + startText
            + "–"
            + endText
            + (
                currentLanguage === "sr"
                ? " локално"
                : " local"
            )
        );
    }

    if (startIso === endIso) {
        return formatOverviewMoment(startIso);
    }

    if (
        startKey
        && startKey === endKey
    ) {
        return (
            formatOverviewDateKey(startKey)
            + " "
            + start.toLocaleTimeString(
                locale,
                timeOptions
            )
            + "–"
            + end.toLocaleTimeString(
                locale,
                timeOptions
            )
            + (
                currentLanguage === "sr"
                ? " локално"
                : " local"
            )
        );
    }

    return (
        formatOverviewMoment(startIso)
        + " – "
        + formatOverviewMoment(endIso)
    );
}


function buildRiskWindows(forecasts, municipalityID, hazardKey) {

    const significant = [];
    let maxProbability = 0;

    forecasts.forEach(
        forecast => {

            const municipality =
                forecast.municipalities[municipalityID];

            if (!municipality) {
                return;
            }

            const probability =
                Number(municipality[hazardKey]);

            if (!Number.isFinite(probability)) {
                return;
            }

            maxProbability = Math.max(
                maxProbability,
                probability
            );

            if (probability >= 10) {
                significant.push({
                    valid_time: forecast.valid_time,
                    probability: probability
                });
            }
        }
    );

    if (significant.length === 0) {
        return {
            maxProbability,
            windows: []
        };
    }

    const windows = [];
    let current = {
        start: significant[0].valid_time,
        end: significant[0].valid_time,
        maxProbability: significant[0].probability
    };

    for (let i = 1; i < significant.length; i++) {

        const previousTime =
            new Date(significant[i - 1].valid_time).getTime();

        const currentTime =
            new Date(significant[i].valid_time).getTime();

        const consecutive =
            currentTime - previousTime === 3 * 60 * 60 * 1000;

        if (consecutive) {
            current.end = significant[i].valid_time;
            current.maxProbability = Math.max(
                current.maxProbability,
                significant[i].probability
            );
        } else {
            windows.push(current);
            current = {
                start: significant[i].valid_time,
                end: significant[i].valid_time,
                maxProbability: significant[i].probability
            };
        }
    }

    windows.push(current);

    return {
        maxProbability,
        windows
    };
}


function buildStormPublicWindows(forecasts, municipalityID) {
    const significant = [];
    let maxLevel = 0;

    forecasts.forEach(forecast => {
        const municipality = forecast.municipalities[municipalityID];
        if (!municipality || !municipality.storms_multimodel) return;

        const level = stormRiskLevel(municipality);
        maxLevel = Math.max(maxLevel, level);

        if (level >= 1) {
            significant.push({
                valid_time: forecast.valid_time,
                level: level,
                category: stormPublicCategory(municipality)
            });
        }
    });

    if (!significant.length) {
        return { maxLevel, windows: [] };
    }

    const windows = [];
    let current = {
        start: significant[0].valid_time,
        end: significant[0].valid_time,
        maxLevel: significant[0].level,
        category: significant[0].category
    };

    for (let i = 1; i < significant.length; i++) {
        const previousTime = new Date(significant[i - 1].valid_time).getTime();
        const currentTime = new Date(significant[i].valid_time).getTime();
        const consecutive = currentTime - previousTime === 3 * 60 * 60 * 1000;

        if (consecutive) {
            current.end = significant[i].valid_time;
            if (significant[i].level > current.maxLevel) {
                current.maxLevel = significant[i].level;
                current.category = significant[i].category;
            }
        } else {
            windows.push(current);
            current = {
                start: significant[i].valid_time,
                end: significant[i].valid_time,
                maxLevel: significant[i].level,
                category: significant[i].category
            };
        }
    }

    windows.push(current);
    return { maxLevel, windows };
}


function stormOverviewGroupHtml(
    forecasts,
    municipalityID
) {
    const t = translations[currentLanguage];

    /*
       Windows are built from the full timeline, including the term before
       local midnight. Only the rendered interval is clipped to the selected
       calendar date.
    */
    const result =
        buildStormPublicWindows(
            forecasts,
            municipalityID
        );

    const shownWindows =
        filterOverviewWindowsForSelectedDate(
            result.windows
        );

    if (
        shownWindows.length === 0
        && !overviewShowAll
    ) {
        return "";
    }

    const periodsHtml =
        shownWindows.length
        ? shownWindows.map(window => `
            <div class="overview-period">
                ${formatOverviewInterval(
                    window.start,
                    window.end,
                    {
                        clipToSelectedDay: true
                    }
                )}
                — <b>${window.category}</b>
            </div>
        `).join("")
        : `
            <div class="overview-muted">
                ${currentLanguage === "sr"
                    ? "Нема значајног ризика од олује."
                    : "No significant storm risk."}
            </div>
        `;

    let detailHtml = "";

    if (overviewSelectedDate) {
        let strongest = null;

        forecasts.forEach(forecast => {
            if (
                localDateKeyBelgrade(
                    forecast.valid_time
                ) !== overviewSelectedDate
            ) {
                return;
            }

            const data =
                forecast.municipalities[
                    municipalityID
                ];

            if (
                !data
                || !data.storms_multimodel
            ) {
                return;
            }

            const level =
                stormRiskLevel(data);

            if (
                !strongest
                || level > strongest.level
            ) {
                strongest = {
                    data,
                    level,
                    valid_time:
                        forecast.valid_time
                };
            }
        });

        if (strongest) {
            const ir =
                stormImpactRecommendation(
                    strongest.data
                );

            if (
                ir.impact
                || ir.recommendation
            ) {
                detailHtml = `
                    <div class="overview-muted" style="margin-top:7px;">
                        <b>${t.impacts}:</b>
                        ${ir.impact}
                    </div>

                    <div class="overview-muted" style="margin-top:5px;">
                        <b>${t.recommendations}:</b>
                        ${ir.recommendation}
                    </div>

                    <div class="overview-muted" style="margin-top:5px;">
                        ${currentLanguage === "sr"
                            ? "Утицаји и препоруке односе се на случај да се прогнозирана појава реализује."
                            : "Impacts and recommendations apply if the forecast event occurs."}
                    </div>
                `;
            }
        }
    }

    return `
        <div class="overview-group">
            <div class="overview-group-title">${t.stormGroup}</div>
            <div class="overview-risk">
                <div class="overview-risk-name">
                    ${currentLanguage === "sr"
                        ? "Степен ризика од олује"
                        : "Storm risk level"}
                </div>
                ${periodsHtml}
                ${detailHtml}
            </div>
        </div>
    `;
}


function overviewRiskName(key) {

    const t = translations[currentLanguage];

    const names = {
        thunder: t.thunder.replace("⚡ ", ""),
        hail: t.hail.replace("🧊 ", ""),
        large_hail: t.largeHail.replace("🧊 ", ""),
        very_large_hail: t.veryLargeHail.replace("🧊 ", "")
    };

    return names[key];
}


function overviewDateKey(isoString) {
    const d = new Date(isoString);
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

function overviewDayRisk(forecasts, municipalityID, dateKey) {
    // Return the strongest daily risk category across ALL hazards.
    // 0 green, 1 yellow, 2 orange, 3 red, 4 purple.
    let strongest = 0;
    const windLevel = {green:0, yellow:1, orange:2, red:3, purple:4};

    forecasts.forEach(forecast => {
        if (localDateKeyBelgrade(forecast.valid_time) !== dateKey) return;
        const municipality = forecast.municipalities[municipalityID];
        if (!municipality) return;

        if (municipality.storms_multimodel) {
            strongest = Math.max(
                strongest,
                stormRiskLevel(municipality)
            );
        }

        const w = String(municipality.wind_risk_level || "green").toLowerCase();
        strongest = Math.max(strongest, windLevel[w] ?? 0);

        if (municipality.temperature_multimodel) {
            strongest = Math.max(
                strongest,
                stormColorLevelNumber(
                    municipality.temperature_color
                )
            );
        }

        if (municipality.heat_stress_multimodel) {
            strongest = Math.max(
                strongest,
                stormColorLevelNumber(
                    municipality.heat_stress_color
                )
            );
        }

        if (municipality.fire_hdw_available) {
            strongest = Math.max(strongest, fireHdwRiskLevel(municipality));
        }

        if (municipality.air_quality_available) {
            strongest = Math.max(strongest, airQualityRiskLevel(municipality));
        }

        if (municipality.uv_available) {
            strongest = Math.max(strongest, uvRiskLevel(municipality));
        }
    });

    return strongest;
}

function overviewRiskClass(level) {
    return ["risk-green", "risk-yellow", "risk-orange", "risk-red", "risk-purple"][level] || "risk-green";
}

function monthCalendarHtml(year, month, activeDates, forecasts, municipalityID) {
    const locale = currentLanguage === "sr" ? "sr-RS" : "en-GB";
    const monthTitle = new Date(Date.UTC(year, month, 1)).toLocaleDateString(locale, {timeZone:"UTC", month:"long", year:"numeric"});
    const weekdays = currentLanguage === "sr" ? ["ПОН","УТО","СРЕ","ЧЕТ","ПЕТ","СУБ","НЕД"] : ["MON","TUE","WED","THU","FRI","SAT","SUN"];
    const first = new Date(Date.UTC(year, month, 1));
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 6) % 7;
    let cells = weekdays.map(day => `<div class="overview-weekday">${day}</div>`).join("");
    for (let i = 0; i < offset; i++) cells += '<div class="overview-day empty"></div>';
    for (let day = 1; day <= days; day++) {
        const key = year + "-" + String(month + 1).padStart(2,"0") + "-" + String(day).padStart(2,"0");
        if (activeDates.has(key)) {
            const riskClass = overviewRiskClass(overviewDayRisk(forecasts, municipalityID, key));
            const selected = overviewSelectedDate === key ? " selected" : "";
            cells += `<button type="button" class="overview-day ${riskClass}${selected}" data-overview-date="${key}">${day}</button>`;
        } else {
            cells += `<div class="overview-day inactive">${day}</div>`;
        }
    }
    return `<div class="overview-calendar"><div class="overview-calendar-title">${monthTitle}</div><div class="overview-calendar-grid">${cells}</div></div>`;
}

function overviewCalendarsHtml(
    forecasts,
    municipalityID
) {
    if (!timelineSlots.length) {
        return "";
    }

    /*
       The calendar is a projection of the SAME local-time timeline shown
       under the map. Render only months that actually contain an active
       forecast date.

       Normal case:
         all available dates are in one month -> one calendar.

       Month transition:
         available dates cross a month boundary -> two calendars.
    */
    const activeDates =
        new Set(
            timelineSlots
                .map(
                    slot =>
                        localDateKeyBelgrade(
                            slot.valid_time
                        )
                )
                .filter(Boolean)
        );

    const sortedActiveDates =
        Array.from(activeDates)
            .sort();

    if (!sortedActiveDates.length) {
        return "";
    }

    const months = [];
    const monthKeys = new Set();

    sortedActiveDates.forEach(dateKey => {
        const [
            yearText,
            monthText
        ] = dateKey.split("-");

        const year =
            Number(yearText);

        const month =
            Number(monthText) - 1;

        if (
            !Number.isInteger(year)
            || !Number.isInteger(month)
        ) {
            return;
        }

        const monthKey =
            year
            + "-"
            + String(month + 1)
                .padStart(2, "0");

        if (!monthKeys.has(monthKey)) {
            monthKeys.add(monthKey);
            months.push({
                year,
                month
            });
        }
    });

    if (!months.length) {
        return "";
    }

    /*
       A five-day MeteoRisk horizon can normally span at most two calendar
       months. Slice defensively so an unexpected malformed timeline cannot
       create an oversized calendar panel.
    */
    const visibleMonths =
        months.slice(0, 2);

    const t =
        translations[currentLanguage];

    const legendClasses = [
        "risk-green",
        "risk-yellow",
        "risk-orange",
        "risk-red",
        "risk-purple"
    ];

    const legendColors = [
        "#78b943",
        "#d9cf35",
        "#ed8d35",
        "#d7191c",
        "#7b3294"
    ];

    const legend =
        t.riskLevels.map(
            (label, i) =>
                `<span><i class="overview-calendar-dot ${legendClasses[i]}" style="border-color:${legendColors[i]}"></i>${label}</span>`
        ).join("");

    const calendars =
        visibleMonths.map(
            item =>
                monthCalendarHtml(
                    item.year,
                    item.month,
                    activeDates,
                    forecasts,
                    municipalityID
                )
        ).join("");

    const layoutClass =
        visibleMonths.length === 1
        ? " single-month"
        : " two-months";

    return `
        <div class="overview-calendars${layoutClass}">
            ${calendars}
        </div>

        <div class="overview-calendar-legend">
            ${legend}
        </div>
    `;
}


function formatOverviewDateKey(dateKey) {
    const [y,m,d] = dateKey.split("-");
    return currentLanguage === "sr" ? `${d}.${m}.${y}.` : `${d}/${m}/${y}`;
}


function heatStressOverviewItemHtml(
    forecasts,
    municipalityID
) {
    const t = translations[currentLanguage];

    const slots = forecasts
        .filter(forecast => {
            const municipality =
                forecast.municipalities[municipalityID];

            return Boolean(
                municipality
                && municipality.heat_stress_multimodel
            );
        })
        .map(forecast => ({
            forecast,
            data: forecast.municipalities[municipalityID],
            level: stormColorLevelNumber(
                forecast.municipalities[municipalityID]
                    .heat_stress_color
            )
        }))
        .sort(
            (a, b) =>
                new Date(a.forecast.valid_time)
                -
                new Date(b.forecast.valid_time)
        );

    if (!slots.length) return "";

    const significant =
        slots.filter(item => item.level >= 1);

    if (!significant.length && !overviewShowAll) {
        return "";
    }

    if (!significant.length) {
        return `
            <div class="overview-risk">
                <div class="overview-risk-name">
                    ${t.heatStress}
                </div>
                <div class="overview-muted">
                    ${t.noSignificantSignal}
                </div>
            </div>
        `;
    }

    const windows = [];
    let current = {
        start: significant[0].forecast.valid_time,
        end: significant[0].forecast.valid_time,
        strongest: significant[0]
    };

    for (let i = 1; i < significant.length; i++) {
        const previousTime =
            new Date(
                significant[i - 1].forecast.valid_time
            ).getTime();

        const currentTime =
            new Date(
                significant[i].forecast.valid_time
            ).getTime();

        const consecutive =
            currentTime - previousTime
            === 3 * 60 * 60 * 1000;

        if (consecutive) {
            current.end =
                significant[i].forecast.valid_time;

            if (
                significant[i].level
                >
                current.strongest.level
            ) {
                current.strongest = significant[i];
            }
        } else {
            windows.push(current);
            current = {
                start: significant[i].forecast.valid_time,
                end: significant[i].forecast.valid_time,
                strongest: significant[i]
            };
        }
    }

    windows.push(current);

    const shownWindows =
        filterOverviewWindowsForSelectedDate(
            windows
        );

    const periodsHtml =
        shownWindows.map(window => {
            const data =
                window.strongest.data;

            const category =
                typeof translatedHeatStressCategory === "function"
                ? translatedHeatStressCategory(data)
                : (data.heat_stress_category_sr || "—");

            return `
                <div class="overview-period">
                    ${formatOverviewInterval(
                        window.start,
                        window.end,
                        {
                            clipToSelectedDay: true
                        }
                    )}
                    — <b>${category}</b>
                </div>
            `;
        }).join("");

    let detailHtml = "";

    if (overviewSelectedDate) {
        const strongest =
            significant
                .filter(
                    item =>
                        localDateKeyBelgrade(
                            item.forecast.valid_time
                        ) === overviewSelectedDate
                )
                .reduce(
                    (best, item) =>
                        !best || item.level > best.level
                        ? item
                        : best,
                    null
                );

        if (strongest) {
            const data = strongest.data;
            const mode =
                String(
                    data.heat_stress_mode || ""
                ).toUpperCase();

            const impact =
                typeof thermalStressImpactRecommendation
                === "function"
                ? thermalStressImpactRecommendation(data)
                : null;

            let valueHtml = "";

            if (
                (mode === "DAY" || mode === "TRANSITION")
                &&
                Number.isFinite(Number(data.heat_stress))
            ) {
                valueHtml += `
                    <div class="overview-period">
                        Heat Index:
                        <b>${formatNumber(
                            data.heat_stress,
                            1
                        )} °C</b>
                    </div>
                `;
            }

            if (
                (mode === "NIGHT" || mode === "TRANSITION")
                &&
                Number.isFinite(
                    Number(data.heat_stress_night_tmin)
                )
            ) {
                valueHtml += `
                    <div class="overview-period">
                        ${
                            currentLanguage === "sr"
                            ? "Ноћни минимум"
                            : "Overnight minimum"
                        }:
                        <b>${formatNumber(
                            data.heat_stress_night_tmin,
                            1
                        )} °C</b>
                    </div>
                `;
            }

            detailHtml = `
                ${valueHtml}

                ${
                    impact
                    ? `
                        <div class="overview-muted" style="margin-top:7px;">
                            <b>${t.impacts}:</b>
                            ${impact.impact}
                        </div>

                        <div class="overview-muted" style="margin-top:5px;">
                            <b>${t.recommendations}:</b>
                            ${impact.recommendation}
                        </div>
                    `
                    : ""
                }
            `;
        }
    }

    return `
        <div class="overview-risk">
            <div class="overview-risk-name">
                ${t.heatStress}
            </div>
            ${periodsHtml}
            ${detailHtml}
        </div>
    `;
}


function temperatureOverviewGroupHtml(
    forecasts,
    municipalityID
) {
    const t = translations[currentLanguage];

    const heatStressHtml =
        heatStressOverviewItemHtml(
            forecasts,
            municipalityID
        );

    const byDate = new Map();

    forecasts.forEach(forecast => {
        const dateKey =
            localDateKeyBelgrade(
                forecast.valid_time
            );

        const municipality =
            forecast.municipalities[
                municipalityID
            ];

        if (
            !dateKey
            || !municipality
            || !municipality.temperature_multimodel
        ) {
            return;
        }

        if (!byDate.has(dateKey)) {
            byDate.set(dateKey, municipality);
        }
    });

    const dates =
        Array.from(byDate.keys())
        .sort()
        .filter(dateKey =>
            !overviewSelectedDate
            || dateKey === overviewSelectedDate
        );

    if (!dates.length && !heatStressHtml) {
        return `
            <div class="overview-group">
                <div class="overview-group-title">
                    ${t.temperatureGroup}
                </div>
                <div class="overview-risk">
                    <div class="overview-muted">
                        ${t.notAvailableForTime || (currentLanguage === "sr"
                            ? "Није доступно за изабрани термин"
                            : "Not available for the selected time")}
                    </div>
                </div>
            </div>
        `;
    }

    let temperatureItemHtml = "";

    if (dates.length) {
        const rows = dates.map(dateKey => {
            const data = byDate.get(dateKey);

            const category =
                translatedTemperatureCategory(data);

            const impact =
                typeof temperatureImpactRecommendation === "function"
                ? temperatureImpactRecommendation(data)
                : null;

            const detailHtml =
                overviewSelectedDate && impact
                ? `
                    <div class="overview-muted" style="margin-top:7px;">
                        <b>${t.impacts}:</b> ${impact.impact}
                    </div>
                    <div class="overview-muted" style="margin-top:5px;">
                        <b>${t.recommendations}:</b> ${impact.recommendation}
                    </div>
                `
                : "";

            return `
                <div class="overview-day-block">
                    <div class="overview-period">
                        <b>${formatOverviewDateKey(dateKey)}</b>
                        — ${formatNumber(data.max_temperature, 1)} °C
                        — <b>${category}</b>
                    </div>

                    <div class="overview-period">
                        ${t.categoryProbability}:
                        <b>${formatProbability(
                            data.temperature_category_probability
                        )}</b>
                        · ${t.warmestPeriod}:
                        <b>${data.temperature_warmest_period || "—"}</b>
                    </div>

                    ${detailHtml}
                </div>
            `;
        }).join("");

        temperatureItemHtml = `
            <div class="overview-risk">
                <div class="overview-risk-name">
                    ${t.maxTemperature}
                </div>
                ${rows}
            </div>
        `;
    }

    return `
        <div class="overview-group">
            <div class="overview-group-title">
                ${t.temperatureGroup}
            </div>
            ${temperatureItemHtml}
            ${heatStressHtml}
        </div>
    `;
}




/* UI CONTRACT FOR HAZARD MODULES:
   Every hazard should provide, where applicable:
   - availability state
   - risk/category
   - value/probability
   - valid period
   - impacts
   - recommendations
   The search/calendar overview and map popup should use the same fields.

   FUTURE RULE:
   a new hazard should expose one shared set of municipality fields
   and one overview adapter/renderer. The main map and the municipality
   search/calendar must read those same fields, so meteorological logic
   is never duplicated in two different UI paths.

   TEMPERATURE is the first synchronized implementation:
   Tmax + 24h heat stress feed both the main view and municipality
   calendar/overview from the same data fields.
*/

function renderOverview(forecasts, feature) {

    const t = translations[currentLanguage];
    const municipalityID = municipalityId(feature.properties);

    /* The overview receives data already projected onto timelineSlots.
       This guarantees that map, slider, calendar and municipality details
       all refer to the same valid times. */
    const visibleForecasts =
        forecasts;

    const displayedForecasts =
        overviewSelectedDate
        ? visibleForecasts.filter(
            forecast =>
                localDateKeyBelgrade(
                    forecast.valid_time
                ) === overviewSelectedDate
        )
        : visibleForecasts;

    function buildGroupHtml(title, hazardKeys) {
        let items = "";

        hazardKeys.forEach(hazardKey => {
            const result = buildRiskWindows(displayedForecasts, municipalityID, hazardKey);

            if (result.windows.length === 0 && !overviewShowAll) return;

            let periodsHtml;
            if (result.windows.length > 0) {
                periodsHtml = result.windows.map(window => `
                    <div class="overview-period">
                        ${formatOverviewInterval(window.start, window.end)}
                        — <b>${formatProbability(window.maxProbability)}</b>
                    </div>
                `).join("");
            } else {
                periodsHtml = `
                    <div class="overview-muted">
                        ${t.noSignificantSignal}
                        ${t.maxSignal}: ${formatProbability(result.maxProbability)}
                    </div>
                `;
            }

            items += `
                <div class="overview-risk">
                    <div class="overview-risk-name">${overviewRiskName(hazardKey)}</div>
                    ${periodsHtml}
                </div>
            `;
        });

        // Hide the whole hazard group when nothing significant exists,
        // unless the user explicitly asks to show insignificant hazards.
        if (!items) return "";
        return `<div class="overview-group"><div class="overview-group-title">${title}</div>${items}</div>`;
    }

    const stormHtml = stormOverviewGroupHtml(
        visibleForecasts,
        municipalityID
    );

    const windHtml =
        typeof windV2OverviewGroupHtml === "function"
        ? windV2OverviewGroupHtml(
            visibleForecasts,
            municipalityID
        )
        : "";

    const temperatureHtml =
        temperatureOverviewGroupHtml(
            visibleForecasts,
            municipalityID
        );

    const fireHtml =
        typeof fireOverviewGroupHtml === "function"
        ? fireOverviewGroupHtml(
            visibleForecasts,
            municipalityID
        )
        : "";

    const airQualityHtml =
        typeof airQualityOverviewGroupHtml === "function"
        ? airQualityOverviewGroupHtml(visibleForecasts, municipalityID)
        : "";

    const uvHtml =
        typeof uvOverviewGroupHtml === "function"
        ? uvOverviewGroupHtml(visibleForecasts, municipalityID)
        : "";

    const groupsHtml =
        stormHtml
        + windHtml
        + temperatureHtml
        + fireHtml
        + airQualityHtml
        + uvHtml
        || `
            <div class="overview-risk">
                <div class="overview-muted">
                    ${t.noSignificantSignal}
                </div>
            </div>
        `;

    document.getElementById("overview-title").textContent = municipalityName(feature.properties);
    document.getElementById("overview-subtitle").textContent = t.overviewTitle;

    document.getElementById("overview-body").innerHTML = `
        ${overviewCalendarsHtml(visibleForecasts, municipalityID)}
        <div class="overview-calendar-actions">
            <button type="button" id="overview-all-days" class="overview-all-days">${t.allFiveDays}</button>
            <div class="overview-day-heading">${overviewSelectedDate ? t.selectedDay + ": " + formatOverviewDateKey(overviewSelectedDate) : t.overviewTitle}</div>
        </div>
        <div class="overview-toolbar">
            <label><input type="checkbox" id="overview-show-all" ${overviewShowAll ? "checked" : ""}> ${t.showAllRisks}</label>
        </div>
        ${groupsHtml}
    `;

    document.querySelectorAll("[data-overview-date]").forEach(button => {
        button.addEventListener("click", () => {
            overviewSelectedDate = button.dataset.overviewDate;
            const indicesOfDay =
                timelineSlots
                    .map(
                        (slot, index) => ({
                            index,
                            dateKey:
                                localDateKeyBelgrade(
                                    slot.valid_time
                                ),
                            time:
                                new Date(
                                    slot.valid_time
                                )
                        })
                    )
                    .filter(
                        item =>
                            item.dateKey
                            === overviewSelectedDate
                    );

            if (indicesOfDay.length > 0) {
                const now =
                    new Date();

                const target =
                    indicesOfDay.find(
                        item =>
                            item.time >= now
                    )
                    || indicesOfDay[0];

                stopPlay();

                showTimelineSlot(
                    target.index
                );
            }

            renderOverview(
                forecasts,
                feature
            );
        });
    });

    document.getElementById("overview-all-days").addEventListener("click", () => {
        overviewSelectedDate = null;
        renderOverview(forecasts, feature);
    });

    document.getElementById("overview-show-all").addEventListener("change", event => {
        overviewShowAll = event.target.checked;
        renderOverview(forecasts, feature);
    });
}


async function openFiveDayOverview(feature) {

    overviewFeature = feature;

    overviewSelectedDate =
        currentModelData && currentModelData.valid_time
        ? localDateKeyBelgrade(
            currentModelData.valid_time
        )
        : null;

    const panel = document.getElementById("overview-panel");
    const body = document.getElementById("overview-body");
    const t = translations[currentLanguage];

    document.getElementById("overview-title").textContent =
        municipalityName(feature.properties);

    document.getElementById("overview-subtitle").textContent =
        t.overviewTitle;

    body.innerHTML = `
        <div class="overview-muted">
            ${t.loadingOverview}
        </div>
    `;

    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");

    try {
        const forecasts =
            await buildTimelineOverviewData();

        renderOverview(
            forecasts,
            feature
        );
    } catch (error) {
        console.error(error);
        body.innerHTML = `
            <div class="overview-muted">
                ${t.loadError}
            </div>
        `;
    }
}


function closeOverview() {
    const panel = document.getElementById("overview-panel");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
}


document
    .getElementById("overview-close")
    .addEventListener(
        "click",
        closeOverview
    );

/* ============================================================
   SEARCH NORMALIZATION
   ============================================================ */

function transliterateCyrillic(
    text
) {

    const chars = {

        "а":"a","б":"b","в":"v",
        "г":"g","д":"d","ђ":"dj",
        "е":"e","ж":"z","з":"z",
        "и":"i","ј":"j","к":"k",
        "л":"l","љ":"lj","м":"m",
        "н":"n","њ":"nj","о":"o",
        "п":"p","р":"r","с":"s",
        "т":"t","ћ":"c","у":"u",
        "ф":"f","х":"h","ц":"c",
        "ч":"c","џ":"dz","ш":"s"

    };

    return text
        .toLowerCase()
        .split("")
        .map(
            c =>
                chars[c] ?? c
        )
        .join("");
}


function normalizeSearch(
    text
) {

    if (
        !text
    ) {
        return "";
    }

    let value =
        transliterateCyrillic(
            text
        );

    value =
        value
        .normalize(
            "NFD"
        )
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /đ/g,
            "dj"
        )
        .replace(
            /č|ć/g,
            "c"
        )
        .replace(
            /š/g,
            "s"
        )
        .replace(
            /ž/g,
            "z"
        )
        .replace(
            /-grad/g,
            ""
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();

    return value;
}


/* ============================================================
   SEARCH
   ============================================================ */

const searchInput =
    document.getElementById(
        "municipality-search"
    );

const searchResults =
    document.getElementById(
        "search-results"
    );


function findMunicipalities(
    query
) {

    if (
        !geometryData
    ) {
        return [];
    }

    const q =
        normalizeSearch(
            query
        );

    if (
        !q
    ) {
        return [];
    }

    const exact = [];
    const starts = [];
    const contains = [];

    geometryData.features
        .forEach(
            feature => {

                const p =
                    feature.properties;

                const names =
                    [
                        p.Value_sc,
                        p.Value_sl,
                        p.Value_e
                    ]
                    .filter(
                        Boolean
                    )
                    .map(
                        normalizeSearch
                    );

                if (
                    names.some(
                        n =>
                            n === q
                    )
                ) {

                    exact.push(
                        feature
                    );

                } else if (
                    names.some(
                        n =>
                            n.startsWith(q)
                    )
                ) {

                    starts.push(
                        feature
                    );

                } else if (
                    names.some(
                        n =>
                            n.includes(q)
                    )
                ) {

                    contains.push(
                        feature
                    );
                }
            }
        );

    return [
        ...exact,
        ...starts,
        ...contains
    ];
}


function showSearchResults() {

    const matches =
        findMunicipalities(
            searchInput.value
        )
        .slice(
            0,
            10
        );

    searchResults.innerHTML =
        "";

    if (
        !searchInput.value.trim()
        ||
        matches.length === 0
    ) {

        searchResults.style.display =
            "none";

        return;
    }

    matches.forEach(
        feature => {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "search-result";

            item.textContent =
                municipalityName(
                    feature.properties
                );

            item.addEventListener(
                "click",
                () => {

                    searchResults.style.display =
                        "none";

                    searchInput.value =
                        municipalityName(
                            feature.properties
                        );

                    openMunicipality(
                        feature,
                        true
                    );
                }
            );

            searchResults.appendChild(
                item
            );
        }
    );

    searchResults.style.display =
        "block";
}


function performSearch() {

    const matches =
        findMunicipalities(
            searchInput.value
        );

    if (
        matches.length === 0
    ) {

        showStatus(
            translations[
                currentLanguage
            ].notFound
        );

        return;
    }

    searchResults.style.display =
        "none";

    openMunicipality(
        matches[0],
        true
    );
}


function openMunicipality(
    feature,
    showOverview = false
) {

    const id =
        municipalityId(
            feature.properties
        );

    selectedMunicipalityId =
        id;

    if (
        !geojsonLayer
    ) {
        return;
    }

    geojsonLayer.eachLayer(
        layer => {

            if (
                municipalityId(
                    layer.feature.properties
                )
                === id
            ) {

                selectedLayer =
                    layer;

                searchInput.value =
                    municipalityName(
                        layer.feature.properties
                    );

                map.fitBounds(
                    layer.getBounds(),
                    {
                        padding:
                            [40,40],

                        maxZoom:
                            MAP_VIEW_CONFIG
                                .municipalitySearchMaxZoom
                    }
                );

                /* Keep the searched municipality clearly visible on the map. */
                layer.setStyle({
                    weight: 4,
                    color: "#111",
                    fillOpacity: 0.88
                });
                layer.bringToFront();

                if (showOverview) {
                    map.closePopup();
                    openFiveDayOverview(layer.feature);
                    return;
                }

                if (openMobileDetail(layer.feature.properties)) {
                    return;
                }

                layer.setPopupContent(
                    popupContent(
                        layer.feature.properties
                    )
                );

                layer.openPopup();
            }
        }
    );
}


searchInput.addEventListener(
    "input",
    showSearchResults
);


searchInput.addEventListener(
    "keydown",
    event => {

        if (
            event.key ===
            "Enter"
        ) {

            performSearch();
        }
    }
);


document
    .getElementById(
        "search-button"
    )
    .addEventListener(
        "click",
        performSearch
    );


/* ============================================================
   GEOLOCATION
   ============================================================ */

document
    .getElementById(
        "location-button"
    )
    .addEventListener(
        "click",
        locateUser
    );


function locateUser() {

    const t =
        translations[
            currentLanguage
        ];

    if (
        !navigator.geolocation
    ) {

        showStatus(
            t.locationUnavailable
        );

        return;
    }

    showStatus(
        t.locationSearching,
        3000
    );

    navigator.geolocation
        .getCurrentPosition(

            position => {

                const lat =
                    position.coords.latitude;

                const lon =
                    position.coords.longitude;

                if (
                    locationMarker
                ) {

                    map.removeLayer(
                        locationMarker
                    );
                }

                locationMarker =
                    L.marker(
                        [lat,lon]
                    )
                    .addTo(
                        map
                    );

                const point =
                    turf.point(
                        [lon,lat]
                    );

                let found =
                    null;

                for (
                    const feature
                    of geometryData.features
                ) {

                    if (
                        turf.booleanPointInPolygon(
                            point,
                            feature
                        )
                    ) {

                        found =
                            feature;

                        break;
                    }
                }

                if (
                    found
                ) {

                    openMunicipality(
                        found
                    );

                    showStatus(
                        t.municipalityLocated
                        +
                        ": "
                        +
                        municipalityName(
                            found.properties
                        )
                    );

                } else {

                    map.setView(
                        [lat,lon],
                        MAP_VIEW_CONFIG
                            .geolocationZoom
                    );
                }
            },


            error => {

                if (
                    error.code === 1
                ) {

                    showStatus(
                        t.locationDenied
                    );

                } else if (
                    error.code === 2
                ) {

                    showStatus(
                        t.locationUnavailable
                    );

                } else {

                    showStatus(
                        t.locationTimeout
                    );
                }
            },


            {
                enableHighAccuracy:
                    false,

                timeout:
                    15000,

                maximumAge:
                    300000
            }
        );
}


/* ============================================================
   PDF
   ============================================================ */

document
    .getElementById(
        "pdf-button"
    )
    .addEventListener(
        "click",
        () => {

            window.print();
        }
    );


/* ============================================================
   SHARE
   ============================================================ */

const sharePanel =
    document.getElementById(
        "share-panel"
    );


function shareData() {

    const t =
        translations[
            currentLanguage
        ];

    let text =
        t.title;

    if (
        currentModelData
    ) {

        text +=
            "\n"
            +
            formatValidTime(
                currentModelData.valid_time
            );
    }

    if (
        selectedLayer
    ) {

        const properties =
            selectedLayer
            .feature
            .properties;

        const data =
            getMunicipalityData(
                properties
            );

        if (
            data
        ) {

            text +=
                "\n"
                +
                municipalityName(
                    properties
                )
                +
                ": "
                +
                formatProbability(
                    data[
                        currentHazard
                    ]
                );
        }
    }

    return {

        title:
            t.shareTitle,

        text:
            text,

        url:
            window.location.href
    };
}


async function nativeShare() {

    try {

        await navigator.share(
            shareData()
        );

    } catch (error) {

        if (
            error.name !==
            "AbortError"
        ) {

            sharePanel.style.display =
                "block";
        }
    }
}


document
    .getElementById(
        "share-button"
    )
    .addEventListener(
        "click",
        () => {

            if (
                navigator.share
            ) {

                nativeShare();

            } else {

                sharePanel.style.display =
                    sharePanel.style.display
                    === "block"
                    ? "none"
                    : "block";
            }
        }
    );


document
    .getElementById(
        "share-native"
    )
    .addEventListener(
        "click",
        nativeShare
    );


document
    .getElementById(
        "share-whatsapp"
    )
    .addEventListener(
        "click",
        () => {

            const d =
                shareData();

            window.open(
                "https://wa.me/?text="
                +
                encodeURIComponent(
                    d.text
                    +
                    "\n"
                    +
                    d.url
                ),
                "_blank"
            );
        }
    );


document
    .getElementById(
        "share-viber"
    )
    .addEventListener(
        "click",
        () => {

            const d =
                shareData();

            window.location.href =
                "viber://forward?text="
                +
                encodeURIComponent(
                    d.text
                    +
                    "\n"
                    +
                    d.url
                );
        }
    );


document
    .getElementById(
        "share-telegram"
    )
    .addEventListener(
        "click",
        () => {

            const d =
                shareData();

            window.open(
                "https://t.me/share/url?url="
                +
                encodeURIComponent(
                    d.url
                )
                +
                "&text="
                +
                encodeURIComponent(
                    d.text
                ),
                "_blank"
            );
        }
    );


document
    .getElementById(
        "share-email"
    )
    .addEventListener(
        "click",
        () => {

            const d =
                shareData();

            window.location.href =
                "mailto:?subject="
                +
                encodeURIComponent(
                    d.title
                )
                +
                "&body="
                +
                encodeURIComponent(
                    d.text
                    +
                    "\n\n"
                    +
                    d.url
                );
        }
    );



let productMetadata = null;

async function loadProductMetadata() {
    try {
        const response = await fetch("./data/product_metadata.json", { cache: "no-store" });
        if (!response.ok) return null;
        productMetadata = await response.json();
        return productMetadata;
    } catch (error) {
        console.warn("Product metadata could not be loaded.", error);
        return null;
    }
}

let discoveredLatestProductRun = null;

async function discoverLatestProductRun() {
    const candidates = [];

    if (
        productMetadata
        && productMetadata.last_successful_update_utc
    ) {
        const d = new Date(
            productMetadata.last_successful_update_utc
        );

        if (Number.isFinite(d.getTime())) {
            candidates.push(d);
        }
    }

    function publicRunIdDate(runId) {
        const match =
            /^(\d{4})(\d{2})(\d{2})_(\d{2})$/.exec(
                String(runId || "")
            );
        if (!match) return null;
        const d = new Date(
            Date.UTC(
                Number(match[1]),
                Number(match[2]) - 1,
                Number(match[3]),
                Number(match[4])
            )
        );
        return Number.isFinite(d.getTime()) ? d : null;
    }

    /* Canonical B5 pointers carry the authoritative model-run identity. */
    try {
        const resolved =
            await window.MeteoRiskPublicData.resolveCurrentRun("temperature_5day");
        const d = publicRunIdDate(resolved.pointer.current_run);
        if (d) candidates.push(d);
    } catch (error) {
        console.warn(
            "Temperature run could not be discovered.",
            error
        );
    }

    try {
        const resolved =
            await window.MeteoRiskPublicData.resolveCurrentRun("thermal_stress_24h");
        const d = publicRunIdDate(resolved.pointer.current_run);
        if (d) candidates.push(d);
    } catch (error) {
        console.warn(
            "Thermal-stress run could not be discovered.",
            error
        );
    }

    if (candidates.length) {
        discoveredLatestProductRun =
            new Date(
                Math.max(
                    ...candidates.map(
                        d => d.getTime()
                    )
                )
            );
    }

    updateHeader();
}

function latestAvailableDataRun() {
    const candidates = [];

    if (
        discoveredLatestProductRun
        && Number.isFinite(
            discoveredLatestProductRun.getTime()
        )
    ) {
        candidates.push(
            discoveredLatestProductRun
        );
    }

    if (
        productMetadata
        && productMetadata.last_successful_update_utc
    ) {
        const d =
            new Date(
                productMetadata.last_successful_update_utc
            );

        if (Number.isFinite(d.getTime())) {
            candidates.push(d);
        }
    }

    if (currentModelData) {
        [
            currentModelData.temperature_model_run,
            currentModelData.storm_reference_run,
            currentModelData.model_run
        ]
        .filter(Boolean)
        .forEach(value => {
            const d = new Date(value);

            if (Number.isFinite(d.getTime())) {
                candidates.push(d);
            }
        });
    }

    if (
        displayReferenceRun
        && Number.isFinite(
            displayReferenceRun.getTime()
        )
    ) {
        candidates.push(
            displayReferenceRun
        );
    }

    if (candidates.length) {
        return new Date(
            Math.max(
                ...candidates.map(
                    d => d.getTime()
                )
            )
        );
    }

    return (
        currentModelData
        ? currentModelData.valid_time
        : null
    );
}


loadProductMetadata()
    .finally(
        discoverLatestProductRun
    );

/* ============================================================
   HEADER
   ============================================================ */

function updateHeader() {

    const t =
        translations[
            currentLanguage
        ];

    document
        .getElementById(
            "main-title"
        )
        .textContent =
            t.title;

    document
        .getElementById(
            "subtitle"
        )
        .textContent =
            currentLanguage === "sr"
            ? "Пробабилистички мултимодел систем"
            : "Probabilistic multimodel system";

    if (
        currentModelData
    ) {

        document
            .getElementById(
                "update-info"
            )
            .textContent =
                t.updated
                +
                ": "
                +
                formatValidTime(
                    latestAvailableDataRun()
                );
    }
}


/* ============================================================
   LANGUAGE
   ============================================================ */

function updateLanguage() {

    const t =
        translations[
            currentLanguage
        ];

    document.documentElement.lang =
        currentLanguage;

    searchInput.placeholder =
        t.search;

    setActionButtonContent("location-button", "📍", t.location);
    setActionButtonContent("pdf-button", "📄", t.pdf);
    setActionButtonContent("share-button", "↗", t.share);

    document
        .getElementById(
            "storm-group-label"
        )
        .textContent =
            t.stormGroup;

    document.getElementById("wind-group-label").textContent = t.windGroup;
    document.getElementById("temperature-group-label").textContent = t.temperatureGroup;
    document.getElementById("btn-max-temperature").textContent = t.maxTemperature;
    document.getElementById("fire-group-label").textContent = t.fireGroup;
    document.getElementById("btn-fire-fwi").textContent = t.fireDanger;
    document.getElementById("btn-fire-hdw").textContent = t.fireSpread;
    document.getElementById("air-quality-group-label").textContent = t.airQualityGroup;
    document.getElementById("btn-air-pm25").textContent = t.airPm25;
    document.getElementById("btn-air-pm10").textContent = t.airPm10;
    document.getElementById("btn-air-o3").textContent = t.airOzone;
    document.getElementById("uv-group-label").textContent = t.uvGroup;
    const heatBtnLang = document.getElementById("btn-heat-stress");
    if (heatBtnLang) heatBtnLang.textContent = t.heatStress;
    document.getElementById("btn-wind-risk").textContent = t.windOverall;

    document
        .getElementById(
            "btn-thunder"
        )
        .textContent =
            t.thunder;

    document
        .getElementById(
            "btn-hail"
        )
        .textContent =
            t.hail;

    document
        .getElementById(
            "btn-large-hail"
        )
        .textContent =
            t.largeHail;

    document
        .getElementById(
            "btn-very-large-hail"
        )
        .textContent =
            t.veryLargeHail;

    document
        .getElementById(
            "disclaimer"
        )
        .textContent =
            t.disclaimer;

    document.title =
        t.title;

    updateHeader();

    updateTimelineLabels();

    updateHazardAvailabilityLabels();

    updateLegend();

    redrawMap();

    if (
        overviewFeature
        && document.getElementById("overview-panel").classList.contains("open")
        && allForecastData
    ) {
        buildTimelineOverviewData()
            .then(
                overviewData => {
                    if (
                        overviewFeature
                        && document.getElementById("overview-panel").classList.contains("open")
                    ) {
                        renderOverview(
                            overviewData,
                            overviewFeature
                        );
                    }
                }
            )
            .catch(
                error => console.warn(
                    "Overview language refresh could not be rebuilt.",
                    error
                )
            );
    }

    if (
        selectedLayer
        && isMobileView()
        && document.getElementById("mobile-detail-panel").classList.contains("open")
    ) {
        openMobileDetail(
            selectedLayer.feature.properties
        );
    }

    if (
        selectedLayer
        && !document.getElementById("overview-panel").classList.contains("open")
    ) {

        selectedLayer
            .setPopupContent(
                popupContent(
                    selectedLayer
                    .feature
                    .properties
                )
            );

        selectedLayer
            .openPopup();
    }
}


document
    .querySelectorAll(
        ".lang-button"
    )
    .forEach(
        button => {

            button.addEventListener(
                "click",
                function() {

                    currentLanguage =
                        this.dataset.lang;

                    document
                        .querySelectorAll(
                            ".lang-button"
                        )
                        .forEach(
                            btn =>
                                btn.classList.remove(
                                    "active"
                                )
                        );

                    this.classList.add(
                        "active"
                    );

                    updateLanguage();
                }
            );
        }
    );


/* ============================================================
   LEGEND
   ============================================================ */

const legend =
    L.control(
        {
            position:
                "bottomright"
        }
    );


legend.onAdd =
function() {

    const div =
        L.DomUtil.create(
            "div",
            "legend"
        );

    div.id =
        "map-legend";

    updateLegend(
        div
    );

    return div;
};


function updateLegend(
    div = null
) {

    updateActiveViewIndicator();

    const element =
        div
        ||
        document.getElementById(
            "map-legend"
        );

    if (!element) {
        return;
    }

    const t = translations[currentLanguage];

    if (currentHazard === "max_temperature") {
        const labels = currentLanguage === "sr"
            ? [
                "<30 °C — уобичајена температура",
                "30–35 °C — тропски дан",
                "35–38 °C — врео дан",
                "38–40 °C — веома врео дан",
                "≥40 °C — екстремно врео дан"
            ]
            : [
                "<30 °C — usual temperature",
                "30–35 °C — tropical day",
                "35–38 °C — hot day",
                "38–40 °C — very hot day",
                "≥40 °C — extremely hot day"
            ];

        const colors = [
            "#a6d96a",
            "#ffffbf",
            "#fdae61",
            "#d7191c",
            "#7b3294"
        ];

        element.innerHTML = `
            <div class="legend-title">
                ${translations[currentLanguage].maxTemperature}
            </div>
            ${labels.map((label, i) => `
                <div class="legend-row">
                    <span class="legend-box" style="background:${colors[i]}"></span>
                    ${label}
                </div>
            `).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }


    if (currentHazard === "heat_stress") {
        const labels = currentLanguage === "sr"
            ? ["<27 °C — без значајног топлотног стреса", "27–32 °C — повишен", "32–41 °C — изражен", "41–54 °C — веома висок", "≥54 °C — екстреман"]
            : ["<27 °C — no significant heat stress", "27–32 °C — elevated", "32–41 °C — marked", "41–54 °C — very high", "≥54 °C — extreme"];
        const colors = ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        element.innerHTML = `<div class="legend-title">${translations[currentLanguage].heatStress}</div>${labels.map((label,i) => `<div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>`).join("")}${legendUnavailableHtml()}`;
        return;
    }

    if (currentHazard === "fire_fwi") {
        const labels = currentLanguage === "sr"
            ? ["<11,2 — ниска", "11,2–21,3 — умерена", "21,3–38 — висока", "38–50 — веома висока", "≥50 — екстремна"]
            : ["<11.2 — low", "11.2–21.3 — moderate", "21.3–38 — high", "38–50 — very high", "≥50 — extreme"];
        const colors = ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        element.innerHTML = `<div class="legend-title">${t.fireDanger}</div>${labels.map((label,i) => `<div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>`).join("")}${legendUnavailableHtml()}`;
        return;
    }

    if (currentHazard === "fire_hdw") {
        const labels = currentLanguage === "sr"
            ? ["<P75 — без значајно повишеног сигнала", "P75–P90 — повишен", "P90–P95 — изражен", "P95–P99 — веома висок", "≥P99 — екстреман"]
            : ["<P75 — no significantly elevated signal", "P75–P90 — elevated", "P90–P95 — marked", "P95–P99 — very high", "≥P99 — extreme"];
        const colors = ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        element.innerHTML = `<div class="legend-title">${t.fireSpread}</div>${labels.map((label,i) => `<div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>`).join("")}${legendUnavailableHtml()}<div class="popup-note">${currentLanguage === "sr" ? "Развојна MeteoRisk перцентилска калибрација." : "Developmental MeteoRisk percentile calibration."}</div>`;
        return;
    }

    if (
        ["thunder", "hail", "large_hail", "very_large_hail"].includes(currentHazard)
        && currentModelData
        && currentModelData.storms_multimodel
    ) {
        const labels = currentLanguage === "sr"
            ? ["без значајног ризика", "повишен", "умерен", "висок", "веома висок"]
            : ["no significant risk", "elevated", "moderate", "high", "very high"];

        const colors = [
            "#a6d96a",
            "#ffffbf",
            "#fdae61",
            "#d7191c",
            "#7b3294"
        ];

        element.innerHTML = `
            <div class="legend-title">
                ${currentLanguage === "sr"
                    ? "Мултимоделски ниво ризика"
                    : "Multimodel risk level"}
            </div>
            ${labels.map((label, i) => `
                <div class="legend-row">
                    <span class="legend-box" style="background:${colors[i]}"></span>
                    ${label}
                </div>
            `).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }

    if (
        ["air_pm25", "air_pm10", "air_o3"].includes(currentHazard)
        || (currentHazard === "module_risk" && currentModule === "air_quality")
    ) {
        const labels = currentLanguage === "sr"
            ? ["0–20 — добар", "21–40 — прихватљив", "41–60 — умерен", "61–80 — лош", "81–100 — веома лош", ">100 — изузетно лош"]
            : ["0–20 — good", "21–40 — fair", "41–60 — moderate", "61–80 — poor", "81–100 — very poor", ">100 — extremely poor"];
        const colors = ["#a6d96a", "#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        element.innerHTML = `
            <div class="legend-title">${t.airQualityGroup}</div>
            ${labels.map((label, i) => `<div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>`).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }

    if (
        currentHazard === "uv_index"
        || (currentHazard === "module_risk" && currentModule === "uv")
    ) {
        const labels = currentLanguage === "sr"
            ? ["0–2 — низак", "3–5 — умерен", "6–7 — висок", "8–10 — веома висок", "≥11 — екстреман"]
            : ["0–2 — low", "3–5 — moderate", "6–7 — high", "8–10 — very high", "≥11 — extreme"];
        const colors = ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        element.innerHTML = `
            <div class="legend-title">${t.uvGroup}</div>
            ${labels.map((label, i) => `<div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>`).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }

    if (
        currentHazard === "module_risk"
        && currentModule === "storm"
    ) {
        const labels = currentLanguage === "sr"
            ? [
                "без значајног ризика од олује",
                "могућност грмљавине",
                "повећан ризик од грмљавине, уз могућност града",
                "висок ризик од грмљавине и града",
                "изражен ризик од грмљавине и града"
            ]
            : [
                "no significant storm risk",
                "thunderstorm possible",
                "increased thunderstorm risk, with hail possible",
                "high risk of thunderstorms and hail",
                "pronounced risk of thunderstorms and hail"
            ];

        const colors = [
            "#a6d96a",
            "#ffffbf",
            "#fdae61",
            "#d7191c",
            "#7b3294"
        ];

        element.innerHTML = `
            <div class="legend-title">
                ${currentLanguage === "sr"
                    ? "ОЛУЈА — степен ризика"
                    : "STORM — risk level"}
            </div>
            ${labels.map((label, i) => `
                <div class="legend-row">
                    <span class="legend-box" style="background:${colors[i]}"></span>
                    ${label}
                </div>
            `).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }

    if (
        currentHazard === "overall_risk"
        || currentHazard === "module_risk"
        || currentHazard === "wind_risk_level"
    ) {
        const labels = currentLanguage === "sr"
            ? ["без значајног ризика", "низак", "умерен", "висок", "веома висок"]
            : ["no significant risk", "low", "moderate", "high", "very high"];
        const colors = ["#a6d96a", "#ffffbf", "#fdae61", "#d7191c", "#7b3294"];
        const count = 5;
        element.innerHTML = `
            <div class="legend-title">${currentLanguage === "sr" ? "Ниво ризика" : "Risk level"}</div>
            ${labels.slice(0, count).map((label, i) => `
                <div class="legend-row"><span class="legend-box" style="background:${colors[i]}"></span>${label}</div>
            `).join("")}
            ${legendUnavailableHtml()}
        `;
        return;
    }

    element.innerHTML = `
        <div class="legend-title">${t.legend}</div>
        <div class="legend-row"><span class="legend-box" style="background:#a6d96a"></span>&lt; 10%</div>
        <div class="legend-row"><span class="legend-box" style="background:#ffffbf"></span>10–20%</div>
        <div class="legend-row"><span class="legend-box" style="background:#fdae61"></span>20–30%</div>
        <div class="legend-row"><span class="legend-box" style="background:#d7191c"></span>30–50%</div>
        <div class="legend-row"><span class="legend-box" style="background:#7b3294"></span>≥ 50%</div>
        ${legendUnavailableHtml()}
    `;
}


legend.addTo(
    map
);


/* ============================================================
   STATUS
   ============================================================ */

let statusTimeout =
    null;


function showStatus(
    message,
    duration = 4000
) {

    const element =
        document.getElementById(
            "status-message"
        );

    if (
        statusTimeout
    ) {

        clearTimeout(
            statusTimeout
        );
    }

    element.textContent =
        message;

    element.style.display =
        "block";

    statusTimeout =
        setTimeout(
            () => {

                element.style.display =
                    "none";

            },
            duration
        );
}


window.addEventListener("resize", () => {
    if (!isMobileView()) {
        closeMobileDetail();
    }
});



/* ============================================================
   METEORISK M1 POPUP ACTIONS + APP LOADER
   ============================================================ */
function hideAppLoader() {
    const overlay = document.getElementById("app-loading-overlay");
    if (!overlay) return;
    overlay.setAttribute("aria-busy", "false");
    overlay.classList.add("hidden");
    window.setTimeout(() => {
        if (overlay.parentNode) overlay.remove();
    }, 320);
}

function showAppLoaderError() {
    const overlay = document.getElementById("app-loading-overlay");
    if (!overlay) return;
    overlay.classList.add("error");
    overlay.setAttribute("aria-busy", "false");
    const text = document.getElementById("app-loading-text");
    if (text) {
        text.textContent = currentLanguage === "sr"
            ? "Подаци тренутно нису могли да се учитају."
            : "The data could not be loaded at this time.";
    }
}

function mrPopupActionsHtml() {
    const sr = currentLanguage === "sr";
    return `
        <div class="mr-popup-actions" data-mr-popup-actions>
            <button type="button" class="mr-popup-action primary" data-mr-action="calendar">📅 ${sr ? "5 дана" : "5 days"}</button>
            <button type="button" class="mr-popup-action" data-mr-action="share">↗ ${sr ? "Подели" : "Share"}</button>
            <button type="button" class="mr-popup-action" data-mr-action="print">🖨 ${sr ? "Штампај" : "Print"}</button>
        </div>`;
}

function mrInjectPopupActions(container) {
    if (!container || container.querySelector("[data-mr-popup-actions]")) return;
    container.insertAdjacentHTML("beforeend", mrPopupActionsHtml());
}

async function mrOpenSelectedOverview() {
    if (!selectedLayer || !selectedLayer.feature) return;
    map.closePopup();
    closeMobileDetail();
    await openFiveDayOverview(selectedLayer.feature);
}

async function mrShareSelected() {
    if (typeof navigator.share === "function") {
        await nativeShare();
        return;
    }
    if (sharePanel) sharePanel.style.display = "block";
}

map.on("popupopen", event => {
    const root = event.popup && event.popup.getElement ? event.popup.getElement() : null;
    const content = root ? root.querySelector(".leaflet-popup-content") : null;
    mrInjectPopupActions(content);
});

document.addEventListener("click", event => {
    const button = event.target.closest("[data-mr-action]");
    if (!button) return;
    const action = button.dataset.mrAction;
    if (action === "calendar") mrOpenSelectedOverview();
    else if (action === "share") mrShareSelected();
    else if (action === "print") window.print();
});


/* ============================================================
   START
   ============================================================ */

updateLanguage();

updateTimeButtons();

initializeData();

window.setTimeout(() => {
    const overlay = document.getElementById("app-loading-overlay");
    if (overlay && !overlay.classList.contains("hidden") && appReady) {
        hideAppLoader();
    }
}, 15000);

/* MeteoRisk M1.1.6.1 - VIEWPORT FLOATING POPUP
   Desktop municipality popup is promoted from the Leaflet map pane to
   document.body, so it becomes a true floating detail card and can move
   across the entire browser viewport. Mobile keeps the bottom sheet. */
let mrDesktopPopupDragState = null;

function mrDesktopPopupIsMobile() {
    return window.matchMedia("(max-width: 800px)").matches;
}

function mrPromoteLeafletPopupToViewport(popupElement) {
    if (!popupElement || mrDesktopPopupIsMobile()) {
        return popupElement;
    }

    if (popupElement.classList.contains("mr-viewport-popup")) {
        return popupElement;
    }

    const rect = popupElement.getBoundingClientRect();

    document.body.appendChild(popupElement);

    popupElement.classList.add(
        "mr-viewport-popup",
        "mr-popup-dragged"
    );

    popupElement.style.setProperty(
        "--mr-popup-left",
        `${Math.max(8, rect.left)}px`
    );
    popupElement.style.setProperty(
        "--mr-popup-top",
        `${Math.max(8, rect.top)}px`
    );

    popupElement.style.marginLeft = "";
    popupElement.style.marginTop = "";

    return popupElement;
}

function mrClampViewportPopupPosition(popup, left, top) {
    const margin = 8;
    const rect = popup.getBoundingClientRect();

    const maxLeft = Math.max(
        margin,
        window.innerWidth - rect.width - margin
    );

    const visibleHeight = Math.min(
        rect.height,
        window.innerHeight - 2 * margin
    );

    const maxTop = Math.max(
        margin,
        window.innerHeight - visibleHeight - margin
    );

    return {
        left: Math.min(Math.max(margin, left), maxLeft),
        top: Math.min(Math.max(margin, top), maxTop)
    };
}

function mrDesktopPopupDragAllowed(event) {
    if (mrDesktopPopupIsMobile()) return false;
    if (!event || event.button !== 0) return false;

    const target = event.target;
    if (!(target instanceof Element)) return false;

    if (target.closest(
        "button, a, input, select, textarea, summary, " +
        ".popup-actions, .mr-popup-action-bar"
    )) {
        return false;
    }

    return Boolean(target.closest(".leaflet-popup-content-wrapper"));
}

document.addEventListener("pointerdown", event => {
    if (!mrDesktopPopupDragAllowed(event)) return;

    const wrapper = event.target.closest(".leaflet-popup-content-wrapper");
    let popup = wrapper ? wrapper.closest(".leaflet-popup") : null;
    if (!popup) return;

    popup = mrPromoteLeafletPopupToViewport(popup);

    const rect = popup.getBoundingClientRect();

    mrDesktopPopupDragState = {
        popup,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false
    };

    popup.classList.add("mr-popup-drag-active");
    document.body.classList.add("mr-popup-is-dragging");

    try {
        wrapper.setPointerCapture(event.pointerId);
    } catch (_) {}

    event.preventDefault();
});

document.addEventListener("pointermove", event => {
    const state = mrDesktopPopupDragState;
    if (!state || event.pointerId !== state.pointerId) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (!state.moved && Math.hypot(dx, dy) < 3) return;
    state.moved = true;

    const next = mrClampViewportPopupPosition(
        state.popup,
        state.startLeft + dx,
        state.startTop + dy
    );

    state.popup.style.setProperty(
        "--mr-popup-left",
        `${next.left}px`
    );
    state.popup.style.setProperty(
        "--mr-popup-top",
        `${next.top}px`
    );

    event.preventDefault();
});

function mrStopDesktopPopupDrag(event) {
    const state = mrDesktopPopupDragState;
    if (!state) return;
    if (event && event.pointerId !== state.pointerId) return;

    state.popup.classList.remove("mr-popup-drag-active");
    document.body.classList.remove("mr-popup-is-dragging");
    mrDesktopPopupDragState = null;
}

document.addEventListener("pointerup", mrStopDesktopPopupDrag);
document.addEventListener("pointercancel", mrStopDesktopPopupDrag);

if (typeof map !== "undefined" && map && typeof map.on === "function") {
    map.on("popupopen", event => {
        if (mrDesktopPopupIsMobile()) return;

        window.requestAnimationFrame(() => {
            const popupElement =
                event?.popup?._container
                || document.querySelector(".leaflet-popup");

            if (popupElement) {
                mrPromoteLeafletPopupToViewport(popupElement);
            }
        });
    });
}

window.addEventListener("resize", () => {
    const popup = document.querySelector(".leaflet-popup.mr-viewport-popup");
    if (!popup || mrDesktopPopupIsMobile()) return;

    const rect = popup.getBoundingClientRect();
    const next = mrClampViewportPopupPosition(
        popup,
        rect.left,
        rect.top
    );

    popup.style.setProperty("--mr-popup-left", `${next.left}px`);
    popup.style.setProperty("--mr-popup-top", `${next.top}px`);
});



/* MeteoRisk M1.1.6.1 - VIEWPORT FLOATING POPUP */
