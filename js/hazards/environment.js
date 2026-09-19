/* ============================================================
   METEORISK HAZARD MODULES: AIR QUALITY + UV INDEX v1
   ============================================================

   Shared backend products:
     B5 product air_quality_3h via validated current.json
     B5 product uv_3h via validated current.json

   Architecture:
   - MeteoRisk timeline remains the ONLY valid-time authority.
   - AIR QUALITY module risk = European AQI category for the active 3h slot.
   - Dominant pollutant = largest European AQI component among
     PM2.5, PM10, O3, NO2 and SO2.
   - PM2.5 / PM10 / O3 can be selected individually.
   - Dust is context/diagnostic only in v1; it does not independently
     set a risk colour.
   - UV module is standalone; 3h risk uses maximum hourly UV index
     already aggregated by the backend.
   ============================================================ */

let airQualityRunPromise = null;
let uvRunPromise = null;
let environmentAirCache = null;
let environmentUvCache = null;

function resolveAirQualityRun() {
    if (!airQualityRunPromise) {
        airQualityRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("air_quality_3h");
    }
    return airQualityRunPromise;
}

function resolveUvRun() {
    if (!uvRunPromise) {
        uvRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("uv_3h");
    }
    return uvRunPromise;
}

function environmentTimeKey(value) {
    if (!value) return "";
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? String(d.getTime()) : "";
}

function environmentRowKey(validTime, municipalityName) {
    return `${environmentTimeKey(validTime)}|${normalizeMunicipalityName(municipalityName)}`;
}

async function loadEnvironmentCsv(resolvedRun, artifactName) {
    const path = window.MeteoRiskPublicData.artifactPath(
        resolvedRun,
        artifactName
    );
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
        console.warn("Environment file unavailable:", path, response.status);
        return new Map();
    }

    const rows = parseCsv(await response.text());
    const byKey = new Map();

    rows.forEach(row => {
        const name = window.MeteoRiskConfig.adminUnitMatchName(row) || "";
        const key = environmentRowKey(row.valid_time, name);
        if (key && !key.startsWith("|")) byKey.set(key, row);
    });

    return byKey;
}

async function loadAirQualityRows() {
    if (!environmentAirCache) {
        try {
            const resolvedRun = await resolveAirQualityRun();
            environmentAirCache = await loadEnvironmentCsv(
                resolvedRun,
                "air_quality_3h.csv"
            );
        } catch (error) {
            console.warn("Air-quality run unavailable:", error);
            environmentAirCache = new Map();
        }
    }
    return environmentAirCache;
}

async function loadUvRows() {
    if (!environmentUvCache) {
        try {
            const resolvedRun = await resolveUvRun();
            environmentUvCache = await loadEnvironmentCsv(
                resolvedRun,
                "uv_3h.csv"
            );
        } catch (error) {
            console.warn("UV run unavailable:", error);
            environmentUvCache = new Map();
        }
    }
    return environmentUvCache;
}

function environmentAqiInfo(value) {
    const n = optionalNumber(value);
    if (n === null) return { eea: "", color: "", level: null };
    if (n <= 20) return { eea: "GOOD", color: "GREEN", level: 0 };
    if (n <= 40) return { eea: "FAIR", color: "GREEN", level: 0 };
    if (n <= 60) return { eea: "MODERATE", color: "YELLOW", level: 1 };
    if (n <= 80) return { eea: "POOR", color: "ORANGE", level: 2 };
    if (n <= 100) return { eea: "VERY_POOR", color: "RED", level: 3 };
    return { eea: "EXTREMELY_POOR", color: "PURPLE", level: 4 };
}

function environmentUvInfo(value) {
    const n = optionalNumber(value);
    if (n === null) return { category: "", color: "", level: null };
    if (n < 3) return { category: "LOW", color: "GREEN", level: 0 };
    if (n < 6) return { category: "MODERATE", color: "YELLOW", level: 1 };
    if (n < 8) return { category: "HIGH", color: "ORANGE", level: 2 };
    if (n < 11) return { category: "VERY_HIGH", color: "RED", level: 3 };
    return { category: "EXTREME", color: "PURPLE", level: 4 };
}

function environmentColorLevel(color) {
    return ({ GREEN:0, YELLOW:1, ORANGE:2, RED:3, PURPLE:4 })[
        String(color || "").toUpperCase()
    ] ?? 0;
}

function environmentColorHex(color) {
    return ({
        GREEN: "#a6d96a",
        YELLOW: "#ffffbf",
        ORANGE: "#fdae61",
        RED: "#d7191c",
        PURPLE: "#7b3294"
    })[String(color || "").toUpperCase()] || "#c7c7c7";
}

async function applyEnvironmentOverlay(data) {
    if (!data || !geometryData) return data;

    const [airRows, uvRows] = await Promise.all([
        loadAirQualityRows(),
        loadUvRows()
    ]);

    let airMatched = 0;
    let uvMatched = 0;

    geometryData.features.forEach(feature => {
        const p = feature.properties || {};
        const name = window.MeteoRiskConfig.adminUnitMatchName(p) || "";
        const id = municipalityId(p);
        const target = data.municipalities?.[id];
        if (!target) return;

        target.air_quality_available = false;
        target.uv_available = false;

        const key = environmentRowKey(data.valid_time, name);
        const air = airRows.get(key);
        if (air) {
            const aqi = optionalNumber(air.european_aqi);
            const color = String(air.aqi_color || "").trim().toUpperCase();

            if (aqi !== null && color) {
                target.air_quality_available = true;
                target.european_aqi = aqi;
                target.aqi_band = String(air.aqi_band || "").trim().toUpperCase();
                target.aqi_color = color;
                target.aqi_level = optionalNumber(air.aqi_level);
                target.air_dominant_pollutant = String(air.dominant_pollutant || "").trim();
                target.air_dominant_pollutant_aqi = optionalNumber(air.dominant_pollutant_aqi);
                target.air_critical_time = air.critical_time || "";

                target.air_pm2_5 = optionalNumber(air.pm2_5);
                target.air_pm10 = optionalNumber(air.pm10);
                target.air_o3 = optionalNumber(air.ozone);
                target.air_no2 = optionalNumber(air.nitrogen_dioxide);
                target.air_so2 = optionalNumber(air.sulphur_dioxide);
                target.air_dust = optionalNumber(air.dust);

                target.air_aqi_pm2_5 = optionalNumber(air.aqi_pm2_5);
                target.air_aqi_pm10 = optionalNumber(air.aqi_pm10);
                target.air_aqi_o3 = optionalNumber(air.aqi_o3);
                target.air_aqi_no2 = optionalNumber(air.aqi_no2);
                target.air_aqi_so2 = optionalNumber(air.aqi_so2);

                target.air_source = air.source || "CAMS via Open-Meteo";
                target.air_source_domain = air.source_domain || "";
                airMatched += 1;
            }
        }

        const uv = uvRows.get(key);
        if (uv) {
            const value = optionalNumber(uv.uv_index);
            const color = String(uv.uv_color || "").trim().toUpperCase();
            if (value !== null && color) {
                target.uv_available = true;
                target.uv_index = value;
                target.uv_category = String(uv.uv_category || "").trim().toUpperCase();
                target.uv_color = color;
                target.uv_level = optionalNumber(uv.uv_level);
                target.uv_max_time = uv.uv_max_time || "";
                target.uv_source = uv.source || "CAMS/Open-Meteo UV index";
                target.uv_source_domain = uv.source_domain || "";
                uvMatched += 1;
            }
        }
    });

    data.air_quality_matches = airMatched;
    data.uv_matches = uvMatched;
    data.air_quality_available = airMatched > 0;
    data.uv_available = uvMatched > 0;

    return data;
}

function airQualityRiskLevel(data) {
    if (!data?.air_quality_available) return 0;
    return environmentColorLevel(data.aqi_color);
}

function airPollutantField(parameter) {
    return ({
        air_pm25: { label: "PM2.5", aqi: "air_aqi_pm2_5", concentration: "air_pm2_5" },
        air_pm10: { label: "PM10", aqi: "air_aqi_pm10", concentration: "air_pm10" },
        air_o3: { label: "O3", aqi: "air_aqi_o3", concentration: "air_o3" }
    })[parameter] || null;
}

function airPollutantRiskLevel(data, parameter) {
    if (!data?.air_quality_available) return 0;
    const config = airPollutantField(parameter);
    if (!config) return 0;
    return environmentAqiInfo(data[config.aqi]).level ?? 0;
}

function airPollutantColorHex(data, parameter) {
    if (!data?.air_quality_available) return "#c7c7c7";
    const config = airPollutantField(parameter);
    if (!config) return "#c7c7c7";
    return environmentColorHex(environmentAqiInfo(data[config.aqi]).color);
}

function uvRiskLevel(data) {
    if (!data?.uv_available) return 0;
    return environmentColorLevel(data.uv_color);
}

function translatedAqiBand(dataOrValue) {
    const raw = typeof dataOrValue === "object"
        ? String(dataOrValue?.aqi_band || "").toUpperCase()
        : environmentAqiInfo(dataOrValue).eea;

    const sr = {
        GOOD: "добар",
        FAIR: "прихватљив",
        MODERATE: "умерен",
        POOR: "лош",
        VERY_POOR: "веома лош",
        EXTREMELY_POOR: "изузетно лош"
    };
    const en = {
        GOOD: "good",
        FAIR: "fair",
        MODERATE: "moderate",
        POOR: "poor",
        VERY_POOR: "very poor",
        EXTREMELY_POOR: "extremely poor"
    };
    return (currentLanguage === "sr" ? sr : en)[raw] || "—";
}

function translatedUvCategory(data) {
    const key = String(data?.uv_category || environmentUvInfo(data?.uv_index).category || "").toUpperCase();
    const sr = { LOW:"низак", MODERATE:"умерен", HIGH:"висок", VERY_HIGH:"веома висок", EXTREME:"екстреман" };
    const en = { LOW:"low", MODERATE:"moderate", HIGH:"high", VERY_HIGH:"very high", EXTREME:"extreme" };
    return (currentLanguage === "sr" ? sr : en)[key] || "—";
}

function translatedPollutantName(key) {
    const value = String(key || "").toUpperCase();
    const map = {
        "PM2.5": "PM2.5",
        "PM10": "PM10",
        "O3": currentLanguage === "sr" ? "приземни озон (O₃)" : "ground-level ozone (O₃)",
        "NO2": "NO₂",
        "SO2": "SO₂"
    };
    return map[value] || key || "—";
}

function airQualityImpactRecommendationForLevel(level) {
    const safe = Math.max(0, Math.min(4, Number(level) || 0));
    const sr = [
        [
            "Квалитет ваздуха не указује на значајан краткорочни здравствени ризик за већину становништва.",
            "Уобичајене активности на отвореном могу се наставити."
        ],
        [
            "Код осетљивих особа могу се јавити тегобе при дужој или интензивној активности на отвореном.",
            "Осетљиве групе нека прилагоде дужу физичку активност ако осете симптоме."
        ],
        [
            "Загађење може неповољно утицати на осетљиве групе, а код дела опште популације изазвати нелагодност при већем напору.",
            "Осетљиве особе треба да смање продужену и интензивну активност на отвореном; остали нека прилагоде активност ако осете тегобе."
        ],
        [
            "Веома лош квалитет ваздуха повећава вероватноћу здравствених тегоба, посебно код осетљивих група.",
            "Осетљиве групе треба да избегавају интензивну активност на отвореном, а остали да смање продужени физички напор."
        ],
        [
            "Изузетно лош квалитет ваздуха представља висок краткорочни здравствени ризик, нарочито за осетљиве групе.",
            "Избегавати напорне активности на отвореном; осетљиве групе треба да сведу боравак и физички напор напољу на минимум."
        ]
    ];
    const en = [
        ["Air quality does not indicate a significant short-term health risk for most people.", "Normal outdoor activities can continue."],
        ["Sensitive people may experience symptoms during prolonged or intense outdoor activity.", "Sensitive groups should adjust prolonged activity if symptoms occur."],
        ["Pollution may adversely affect sensitive groups and can cause discomfort in some people during exertion.", "Sensitive people should reduce prolonged strenuous outdoor activity; others should adjust activity if symptoms occur."],
        ["Very poor air quality increases the likelihood of health effects, especially for sensitive groups.", "Sensitive groups should avoid strenuous outdoor activity and others should reduce prolonged physical exertion."],
        ["Extremely poor air quality represents a high short-term health risk, particularly for sensitive groups.", "Avoid strenuous outdoor activity; sensitive groups should minimize outdoor exposure and exertion."]
    ];
    const item = (currentLanguage === "sr" ? sr : en)[safe];
    return { impact: item[0], recommendation: item[1] };
}

function airQualityImpactRecommendation(data) {
    return airQualityImpactRecommendationForLevel(airQualityRiskLevel(data));
}

function uvImpactRecommendation(data) {
    const level = uvRiskLevel(data);
    const sr = [
        ["UV зрачење је ниско; ризик од оштећења незаштићене коже и очију је мали.", "Уобичајена заштита је довољна; при дужем боравку на сунцу користити основну заштиту."],
        ["Умерен UV ниво може изазвати оштећење незаштићене коже при дужем излагању.", "Око средине дана користити хлад, одећу, наочаре и заштиту коже."],
        ["Висок UV ниво може релативно брзо оштетити незаштићену кожу и очи.", "Смањити директно излагање око средине дана и доследно користити заштиту од сунца."],
        ["Веома висок UV ниво носи велики ризик од брзог оштећења незаштићене коже и очију.", "Максимално ограничити директно сунце око средине дана; користити хлад, покривну одећу, наочаре и заштиту коже."],
        ["Екстреман UV ниво може изазвати оштећење незаштићене коже и очију за веома кратко време.", "Избегавати директно сунце око средине дана и применити највиши ниво личне заштите."
        ]
    ];
    const en = [
        ["UV radiation is low and the risk of damage to unprotected skin and eyes is small.", "Normal protection is sufficient; use basic sun protection during prolonged exposure."],
        ["Moderate UV can damage unprotected skin during prolonged exposure.", "Around midday use shade, protective clothing, sunglasses and skin protection."],
        ["High UV can damage unprotected skin and eyes relatively quickly.", "Reduce direct midday exposure and use consistent sun protection."],
        ["Very high UV carries a high risk of rapid damage to unprotected skin and eyes.", "Minimize direct midday sun; use shade, covering clothing, sunglasses and skin protection."],
        ["Extreme UV can damage unprotected skin and eyes in a very short time.", "Avoid direct midday sun and use the highest level of personal sun protection."]
    ];
    const item = (currentLanguage === "sr" ? sr : en)[level] || ["—", "—"];
    return { impact: item[0], recommendation: item[1] };
}

function airQualityTechnicalHtml(data) {
    if (!data?.air_quality_available) return "";
    const sourceDomain = data.air_source_domain === "cams_europe"
        ? "CAMS Europe (~11 km)"
        : data.air_source_domain === "cams_global"
            ? "CAMS Global (~45 km)"
            : (data.air_source_domain || "—");

    return `
        <div class="multimodel-card">
            <div class="popup-section">${currentLanguage === "sr" ? "Компоненте квалитета ваздуха" : "Air-quality components"}</div>
            <div class="popup-row">PM2.5: <b>${formatNumber(data.air_pm2_5, 1)} µg/m³</b> · AQI <b>${formatNumber(data.air_aqi_pm2_5, 0)}</b></div>
            <div class="popup-row">PM10: <b>${formatNumber(data.air_pm10, 1)} µg/m³</b> · AQI <b>${formatNumber(data.air_aqi_pm10, 0)}</b></div>
            <div class="popup-row">O₃: <b>${formatNumber(data.air_o3, 1)} µg/m³</b> · AQI <b>${formatNumber(data.air_aqi_o3, 0)}</b></div>
            <div class="popup-row">NO₂: <b>${formatNumber(data.air_no2, 1)} µg/m³</b> · AQI <b>${formatNumber(data.air_aqi_no2, 0)}</b></div>
            <div class="popup-row">SO₂: <b>${formatNumber(data.air_so2, 1)} µg/m³</b> · AQI <b>${formatNumber(data.air_aqi_so2, 0)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Минерална прашина" : "Mineral dust"}: <b>${formatNumber(data.air_dust, 1)} µg/m³</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Изворни домен" : "Source domain"}: <b>${sourceDomain}</b></div>
            <div class="popup-note">${currentLanguage === "sr"
                ? "Прашина је у v1 информативни сигнал и не подиже самостално боју ризика. Укупни European AQI одређује најнеповољнији подиндекс PM2.5, PM10, O₃, NO₂ или SO₂."
                : "In v1 dust is contextual information and does not independently raise the risk colour. The overall European AQI is set by the worst PM2.5, PM10, O₃, NO₂ or SO₂ sub-index."}</div>
        </div>
    `;
}

function airQualityDetailHtml(data, options = {}) {
    if (!data?.air_quality_available) {
        return `<div class="popup-note">${currentLanguage === "sr" ? "Прогноза квалитета ваздуха није доступна за овај термин." : "Air-quality forecast is unavailable for this time slot."}</div>`;
    }
    if (options.technicalOnly) return airQualityTechnicalHtml(data);

    const ir = airQualityImpactRecommendation(data);
    return riskSummaryHtml({
        title: translations[currentLanguage].airQualityGroup,
        level: airQualityRiskLevel(data),
        category: translatedAqiBand(data),
        badge: translatedAqiBand(data),
        value: `${translations[currentLanguage].airEuropeanAqi}: <b>${formatNumber(data.european_aqi, 0)}</b>`,
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta: `${translations[currentLanguage].airDominant}: ${translatedPollutantName(data.air_dominant_pollutant)}`
    }) + expertDetailsHtml(airQualityTechnicalHtml(data));
}

function airPollutantDetailHtml(data, parameter) {
    if (!data?.air_quality_available) return riskSummaryHtml({ title: parameter, available: false });
    const config = airPollutantField(parameter);
    if (!config) return "";
    const aqi = data[config.aqi];
    const concentration = data[config.concentration];
    if (!Number.isFinite(Number(aqi))) return riskSummaryHtml({ title: config.label, available: false });
    const info = environmentAqiInfo(aqi);
    const ir = airQualityImpactRecommendationForLevel(info.level);
    return riskSummaryHtml({
        title: config.label,
        level: info.level,
        category: translatedAqiBand(aqi),
        badge: translatedAqiBand(aqi),
        value: `${config.label}: <b>${formatNumber(concentration, 1)} µg/m³</b> · AQI <b>${formatNumber(aqi, 0)}</b>`,
        impact: ir.impact,
        recommendation: ir.recommendation
    }) + expertDetailsHtml(airQualityTechnicalHtml(data));
}

function uvTechnicalHtml(data) {
    if (!data?.uv_available) return "";
    const sourceDomain = data.uv_source_domain === "cams_global"
        ? "CAMS Global (~45 km)"
        : data.uv_source_domain === "cams_europe"
            ? "CAMS Europe (~11 km)"
            : (data.uv_source_domain || "—");
    return `
        <div class="multimodel-card">
            <div class="popup-row">${currentLanguage === "sr" ? "Максимални сатни UVI у 3 h слоту" : "Maximum hourly UVI in 3h slot"}: <b>${formatNumber(data.uv_index, 1)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Изворни домен" : "Source domain"}: <b>${sourceDomain}</b></div>
            <div class="popup-note">${currentLanguage === "sr" ? "Боја представља највиши сатни UV индекс у активном 3-часовном термину." : "The colour represents the maximum hourly UV index within the active 3-hour slot."}</div>
        </div>`;
}

function uvDetailHtml(data, options = {}) {
    if (!data?.uv_available) {
        return `<div class="popup-note">${currentLanguage === "sr" ? "UV индекс није доступан за овај термин." : "UV index is unavailable for this time slot."}</div>`;
    }
    if (options.technicalOnly) return uvTechnicalHtml(data);
    const ir = uvImpactRecommendation(data);
    return riskSummaryHtml({
        title: translations[currentLanguage].uvGroup,
        level: uvRiskLevel(data),
        category: translatedUvCategory(data),
        badge: translatedUvCategory(data),
        value: `${translations[currentLanguage].uvIndex}: <b>${formatNumber(data.uv_index, 1)}</b>`,
        impact: ir.impact,
        recommendation: ir.recommendation
    }) + expertDetailsHtml(uvTechnicalHtml(data));
}

function environmentRiskWindows(
    forecasts,
    municipalityID,
    moduleKey
) {
    const items = forecasts
        .map(forecast => {
            const data =
                forecast.municipalities?.[
                    municipalityID
                ];

            if (!data) return null;

            const available =
                moduleKey === "air_quality"
                ? data.air_quality_available
                : data.uv_available;

            if (!available) return null;

            const level =
                moduleKey === "air_quality"
                ? airQualityRiskLevel(data)
                : uvRiskLevel(data);

            return {
                forecast,
                data,
                level
            };
        })
        .filter(Boolean)
        .filter(
            item =>
                overviewShowAll
                || item.level >= 1
        );

    if (!items.length) return [];

    const windows = [];
    let current = null;

    items.forEach(item => {
        if (!current) {
            current = {
                start:
                    item.forecast.valid_time,
                end:
                    item.forecast.valid_time,
                strongest: item
            };
            return;
        }

        const prev =
            new Date(current.end).getTime();

        const now =
            new Date(
                item.forecast.valid_time
            ).getTime();

        if (
            now - prev
            === 3 * 60 * 60 * 1000
        ) {
            current.end =
                item.forecast.valid_time;

            if (
                item.level
                > current.strongest.level
            ) {
                current.strongest = item;
            }
        } else {
            windows.push(current);
            current = {
                start:
                    item.forecast.valid_time,
                end:
                    item.forecast.valid_time,
                strongest: item
            };
        }
    });

    if (current) {
        windows.push(current);
    }

    return filterOverviewWindowsForSelectedDate(
        windows
    );
}


function airQualityOverviewGroupHtml(forecasts, municipalityID) {
    const windows =
        environmentRiskWindows(
            forecasts,
            municipalityID,
            "air_quality"
        );

    if (!windows.length) return "";

    const t = translations[currentLanguage];

    const rows = windows.map(window => {
        const d = window.strongest.data;
        const ir = airQualityImpactRecommendation(d);

        const adviceHtml =
            overviewSelectedDate && ir
            ? `
                <div class="overview-muted" style="margin-top:7px;">
                    <b>${t.impacts}:</b> ${ir.impact}
                </div>
                <div class="overview-muted" style="margin-top:5px;">
                    <b>${t.recommendations}:</b> ${ir.recommendation}
                </div>
            `
            : "";

        return `
            <div class="overview-day-block">
                <div class="overview-period">
                    ${formatOverviewInterval(
                        window.start,
                        window.end,
                        {
                            clipToSelectedDay: true
                        }
                    )}
                    — <b>${translatedAqiBand(d)}</b>
                    · ${t.airEuropeanAqi}:
                    <b>${formatNumber(d.european_aqi, 0)}</b>
                    · ${t.airDominant}:
                    <b>${translatedPollutantName(
                        d.air_dominant_pollutant
                    )}</b>
                </div>
                ${adviceHtml}
            </div>
        `;
    }).join("");

    return `
        <div class="overview-group">
            <div class="overview-group-title">${t.airQualityGroup}</div>
            <div class="overview-risk">
                <div class="overview-risk-name">${t.airQualityGroup}</div>
                ${rows}
            </div>
        </div>
    `;
}


function uvOverviewGroupHtml(forecasts, municipalityID) {
    const windows =
        environmentRiskWindows(
            forecasts,
            municipalityID,
            "uv"
        );

    if (!windows.length) return "";

    const t = translations[currentLanguage];

    const rows = windows.map(window => {
        const d = window.strongest.data;
        const ir = uvImpactRecommendation(d);

        const adviceHtml =
            overviewSelectedDate && ir
            ? `
                <div class="overview-muted" style="margin-top:7px;">
                    <b>${t.impacts}:</b> ${ir.impact}
                </div>
                <div class="overview-muted" style="margin-top:5px;">
                    <b>${t.recommendations}:</b> ${ir.recommendation}
                </div>
            `
            : "";

        return `
            <div class="overview-day-block">
                <div class="overview-period">
                    ${formatOverviewInterval(
                        window.start,
                        window.end,
                        {
                            clipToSelectedDay: true
                        }
                    )}
                    — <b>${translatedUvCategory(d)}</b>
                    · ${t.uvIndex}:
                    <b>${formatNumber(d.uv_index, 1)}</b>
                </div>
                ${adviceHtml}
            </div>
        `;
    }).join("");

    return `
        <div class="overview-group">
            <div class="overview-group-title">${t.uvGroup}</div>
            <div class="overview-risk">
                <div class="overview-risk-name">${t.uvGroup}</div>
                ${rows}
            </div>
        </div>
    `;
}


/* MeteoRisk M1.1.7 - ENVIRONMENT OVERVIEW IMPACTS
   UI contract:
   availability -> risk/category -> value -> valid period -> impact ->
   recommendation. Classification remains inside the hazard module. */
