/* ============================================================
   METEORISK HAZARD MODULE: MAXIMUM TEMPERATURE
   ============================================================

   Temperature-specific block:
   - data files/cache
   - daily data loading
   - municipality overlay
   - category translation
   - impacts/recommendations
   - popup detail renderer

   Future hazards should be separate files in js/hazards/.
   ============================================================ */

const TEMPERATURE_ARTIFACTS = [
    "temperature_day0.csv",
    "temperature_day1.csv",
    "temperature_day2.csv",
    "temperature_day3.csv",
    "temperature_day4.csv"
];

let temperatureRunPromise = null;

function resolveTemperatureRun() {
    if (!temperatureRunPromise) {
        temperatureRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("temperature_5day");
    }
    return temperatureRunPromise;
}

let temperatureDailyCache = null;

function localDateKeyBelgrade(isoString) {
    if (!isoString) return null;

    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Europe/Belgrade",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).formatToParts(date);

    const values = {};
    parts.forEach(part => {
        if (part.type !== "literal") {
            values[part.type] = part.value;
        }
    });

    return `${values.year}-${values.month}-${values.day}`;
}

async function loadTemperatureDailyRows() {
    if (temperatureDailyCache) {
        return temperatureDailyCache;
    }

    const byDate = new Map();
    let resolvedRun;

    try {
        resolvedRun = await resolveTemperatureRun();
    } catch (error) {
        console.warn("Temperature run unavailable:", error);
        temperatureDailyCache = byDate;
        return temperatureDailyCache;
    }

    for (const artifact of TEMPERATURE_ARTIFACTS) {
        const path =
            window.MeteoRiskPublicData.artifactPath(
                resolvedRun,
                artifact
            );
        try {
            const response = await fetch(
                path,
                { cache: "no-store" }
            );

            if (!response.ok) {
                console.warn(
                    "Temperature file unavailable:",
                    path,
                    response.status
                );
                continue;
            }

            const rows = parseCsv(
                await response.text()
            );

            rows.forEach(row => {
                const dateKey = String(row.date || "").trim();
                if (!dateKey) return;

                if (!byDate.has(dateKey)) {
                    byDate.set(dateKey, new Map());
                }

                byDate.get(dateKey).set(
                    normalizeMunicipalityName(row.Value_sc),
                    row
                );
            });

        } catch (error) {
            console.warn(
                "Temperature file load error:",
                path,
                error
            );
        }
    }

    temperatureDailyCache = byDate;
    return byDate;
}

async function applyTemperatureOverlay(data) {
    if (!data || !geometryData) return data;

    const dateKey = localDateKeyBelgrade(
        data.valid_time
    );

    if (!dateKey) {
        data.temperature_multimodel = false;
        return data;
    }

    const allDays =
        await loadTemperatureDailyRows();

    const rowsByName =
        allDays.get(dateKey);

    if (!rowsByName) {
        data.temperature_multimodel = false;
        return data;
    }

    let matched = 0;
    let availableMatched = 0;

    geometryData.features.forEach(feature => {
        const properties = feature.properties || {};

        const name = normalizeMunicipalityName(
            properties.Value_sc
            || properties.Value_sl
            || properties.Value_e
        );

        const row = rowsByName.get(name);
        if (!row) return;

        const id = municipalityId(properties);

        if (!data.municipalities || !data.municipalities[id]) {
            return;
        }

        const target = data.municipalities[id];

        target.temperature_multimodel = true;
        target.max_temperature = optionalNumber(row.multimodel_tmax);
        target.temperature_color = row.temperature_color || "GREEN";
        target.temperature_category_sr = row.temperature_category_sr || "";
        target.temperature_category_key = row.dominant_category || "";

        target.temperature_category_probability =
            optionalNumber(row.dominant_category_probability);

        target.temperature_p_below_30 =
            optionalNumber(row.p_below_30);

        target.temperature_p_30_35 =
            optionalNumber(row.p_30_35);

        target.temperature_p_35_38 =
            optionalNumber(row.p_35_38);

        target.temperature_p_38_40 =
            optionalNumber(row.p_38_40);

        target.temperature_p_ge_40 =
            optionalNumber(row.p_ge_40);

        target.temperature_gefs_tmax =
            optionalNumber(row.gefs_tmax);

        target.temperature_icon_tmax =
            optionalNumber(row.icon_tmax);

        target.temperature_warmest_period =
            row.warmest_period_local || "—";

        target.temperature_date =
            row.date || dateKey;

        target.temperature_model_run =
            row.model_run || "";

        matched += 1;
    });

    data.temperature_multimodel = matched > 0;
    data.temperature_multimodel_matches = matched;

    return data;
}

function translatedTemperatureCategory(data) {
    const key = String(
        data.temperature_category_key || ""
    );

    const sr = {
        below_30: "Уобичајена температура",
        "30_35": "Тропски дан",
        "35_38": "Врео дан",
        "38_40": "Веома врео дан",
        ge_40: "Екстремно врео дан"
    };

    const en = {
        below_30: "Usual temperature",
        "30_35": "Tropical day",
        "35_38": "Hot day",
        "38_40": "Very hot day",
        ge_40: "Extremely hot day"
    };

    return (
        currentLanguage === "sr"
        ? sr[key]
        : en[key]
    )
    || data.temperature_category_sr
    || "—";
}

function temperatureImpactRecommendation(data) {
    const key = String(data.temperature_category_key || "");

    const sr = {
        below_30: ["Без значајнијег утицаја високе температуре.", "Уобичајене дневне активности."],
        "30_35": ["Повећана топлотна нелагодност, нарочито код осетљивих група и при дужем боравку на сунцу.", "Редовно уносити течност и смањити дуже излагање сунцу и напор у најтоплијем делу дана."],
        "35_38": ["Изражено топлотно оптерећење; већи ризик од исцрпљености при раду и физичкој активности на отвореном.", "Ограничити напорне активности на отвореном, правити чешће паузе, боравити у хладу или расхлађеном простору и редовно уносити течност."],
        "38_40": ["Високо топлотно оптерећење и повећан ризик од здравствених тегоба при дужем излагању и физичком напору.", "Избегавати напор и дуже излагање у најтоплијем делу дана; активности планирати за раније јутарње или вечерње сате и посебно обратити пажњу на осетљиве групе."],
        ge_40: ["Екстремна врућина са веома високим топлотним оптерећењем, нарочито за старије, децу, хроничне болеснике и особе које раде на отвореном.", "Избегавати физички напор и дуже излагање топлоти, обезбедити често расхлађивање и унос течности и активности на отвореном свести на неопходни минимум."]
    };

    const en = {
        below_30: ["No significant high-temperature impact.", "Normal daily activities."],
        "30_35": ["Increased heat discomfort, especially for vulnerable groups and during prolonged sun exposure.", "Drink fluids regularly and reduce prolonged sun exposure and strenuous activity during the hottest part of the day."],
        "35_38": ["Marked heat load with increased risk of exhaustion during outdoor work and physical activity.", "Limit strenuous outdoor activity, take more frequent breaks, stay in shade or cooled spaces and drink fluids regularly."],
        "38_40": ["High heat load and increased risk of heat-related health problems during prolonged exposure and physical exertion.", "Avoid strenuous activity and prolonged exposure during the hottest part of the day; schedule activities for early morning or evening and pay special attention to vulnerable groups."],
        ge_40: ["Extreme heat with very high heat load, particularly for older people, children, people with chronic illness and outdoor workers.", "Avoid physical exertion and prolonged heat exposure, cool down frequently, drink fluids regularly and keep outdoor activity to the necessary minimum."]
    };

    const item = (currentLanguage === "sr" ? sr : en)[key] || ["—", "—"];

    return {
        impact: item[0],
        recommendation: item[1]
    };
}

function temperatureDetailHtml(data, options = {}) {
    const t = translations[currentLanguage];

    if (!data || !data.temperature_multimodel) {
        return riskSummaryHtml({
            title: t.maxTemperature,
            available: false
        });
    }

    const ir = temperatureImpactRecommendation(data);
    const level = stormColorLevelNumber(data.temperature_color);

    const technical = `
        <div class="multimodel-card">
            <div class="popup-section">${t.maxTemperature}</div>
            <div class="popup-row">${t.multimodelTmax}: <b>${formatNumber(data.max_temperature, 1)} °C</b></div>
            <div class="popup-row">${t.temperatureCategory}: <b>${translatedTemperatureCategory(data)}</b></div>
            <div class="popup-row">${t.categoryProbability}: <b>${formatProbability(data.temperature_category_probability)}</b></div>
            <div class="popup-row">${t.warmestPeriod}: <b>${data.temperature_warmest_period || "—"}</b></div>

            <div class="popup-section">${currentLanguage === "sr" ? "Модели" : "Models"}</div>
            <div class="multimodel-model-grid">
                <div><span>GEFS</span><b>${formatNumber(data.temperature_gefs_tmax, 1)} °C</b></div>
                <div><span>ICON-EU EPS</span><b>${formatNumber(data.temperature_icon_tmax, 1)} °C</b></div>
                <div><span>${currentLanguage === "sr" ? "Мултимодел" : "Multimodel"}</span><b>${formatNumber(data.max_temperature, 1)} °C</b></div>
            </div>

            <div class="popup-section">${currentLanguage === "sr" ? "Расподела категорија" : "Category distribution"}</div>
            <div class="popup-row">&lt;30 °C: <b>${formatProbability(data.temperature_p_below_30)}</b></div>
            <div class="popup-row">30–35 °C: <b>${formatProbability(data.temperature_p_30_35)}</b></div>
            <div class="popup-row">35–38 °C: <b>${formatProbability(data.temperature_p_35_38)}</b></div>
            <div class="popup-row">38–40 °C: <b>${formatProbability(data.temperature_p_38_40)}</b></div>
            <div class="popup-row">≥40 °C: <b>${formatProbability(data.temperature_p_ge_40)}</b></div>

            <div class="popup-note">${currentLanguage === "sr"
                ? "Дневни развојни мултимоделски производ: GEFS и ICON-EU EPS имају једнаку тежину 50:50. Категоријске вероватноће још нису калибрисане."
                : "Daily developmental multimodel product: GEFS and ICON-EU EPS have equal 50:50 weight. Category probabilities are not yet calibrated."}</div>
        </div>
    `;

    if (options.technicalOnly) return technical;

    return riskSummaryHtml({
        title: t.maxTemperature,
        level,
        category: translatedTemperatureCategory(data),
        value: `${t.multimodelTmax}: <b>${formatNumber(data.max_temperature, 1)} °C</b>`,
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta: `${t.warmestPeriod}: ${data.temperature_warmest_period || "—"}`
    }) + expertDetailsHtml(technical);
}



/* ============================================================
   METEORISK HAZARD MODULE: 24H THERMAL STRESS
   Day: Heat Index
   Night: tropical-night Tmin
   Transition: blended backend score
   ============================================================ */

let heatStress24hCache = new Map();
let heatStressReferenceRun = null;

const HEAT_STRESS_ARTIFACTS = [
    "heat_stress_day0.csv",
    "heat_stress_day1.csv",
    "heat_stress_day2.csv",
    "heat_stress_day3.csv",
    "heat_stress_day4.csv"
];

let heatStress5dayRunPromise = null;

function resolveHeatStress5dayRun() {
    if (!heatStress5dayRunPromise) {
        heatStress5dayRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("heat_stress_5day");
    }
    return heatStress5dayRunPromise;
}

let heatStressDailyCache = null;

async function loadHeatStressDailyRows() {
    if (heatStressDailyCache) return heatStressDailyCache;

    const byDate = new Map();
    let resolvedRun;

    try {
        resolvedRun = await resolveHeatStress5dayRun();
    } catch (error) {
        console.warn("Daily heat-stress run unavailable:", error);
        heatStressDailyCache = byDate;
        return heatStressDailyCache;
    }

    for (const artifact of HEAT_STRESS_ARTIFACTS) {
        const path =
            window.MeteoRiskPublicData.artifactPath(
                resolvedRun,
                artifact
            );
        try {
            const response = await fetch(
                path,
                { cache: "no-store" }
            );

            if (!response.ok) {
                console.warn(
                    "Daily heat-stress file unavailable:",
                    path,
                    response.status
                );
                continue;
            }

            const rows = parseCsv(
                await response.text()
            );

            rows.forEach(row => {
                const dateKey =
                    String(row.date || "").trim();

                if (!dateKey) return;

                if (!byDate.has(dateKey)) {
                    byDate.set(
                        dateKey,
                        new Map()
                    );
                }

                byDate.get(dateKey).set(
                    normalizeMunicipalityName(
                        row.Value_sc
                        || row.Value_sl
                        || row.Value_e
                    ),
                    row
                );
            });

        } catch (error) {
            console.warn(
                "Daily heat-stress load error:",
                path,
                error
            );
        }
    }

    heatStressDailyCache = byDate;
    return byDate;
}

async function applyHeatStressOverlay(data) {
    if (!data || !geometryData) return data;

    const dateKey =
        localDateKeyBelgrade(
            data.valid_time
        );

    if (!dateKey) {
        data.heat_stress_multimodel = false;
        data.heat_stress_multimodel_matches = 0;
        return data;
    }

    const allDays =
        await loadHeatStressDailyRows();

    const rowsByName =
        allDays.get(dateKey);

    if (!rowsByName) {
        data.heat_stress_multimodel = false;
        data.heat_stress_multimodel_matches = 0;
        return data;
    }

    let matched = 0;

    geometryData.features.forEach(feature => {
        const properties =
            feature.properties || {};

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
            municipalityId(properties);

        if (
            !data.municipalities
            || !data.municipalities[id]
        ) return;

        const target =
            data.municipalities[id];

        target.heat_stress_multimodel = true;
        target.heat_stress =
            optionalNumber(
                row.multimodel_heat_index_max
            );
        target.heat_stress_color =
            row.heat_stress_color || "GREEN";
        target.heat_stress_category_sr =
            row.heat_stress_category_sr || "";
        target.heat_stress_category_key =
            row.dominant_category || "";
        target.heat_stress_category_probability =
            optionalNumber(
                row.dominant_category_probability
            );

        target.heat_stress_p_below_27 =
            optionalNumber(row.p_below_27);
        target.heat_stress_p_27_32 =
            optionalNumber(row.p_27_32);
        target.heat_stress_p_32_41 =
            optionalNumber(row.p_32_41);
        target.heat_stress_p_41_54 =
            optionalNumber(row.p_41_54);
        target.heat_stress_p_ge_54 =
            optionalNumber(row.p_ge_54);

        target.heat_stress_gefs =
            optionalNumber(
                row.gefs_heat_index_max
            );
        target.heat_stress_icon =
            optionalNumber(
                row.icon_heat_index_max
            );

        target.heat_stress_date =
            row.date || dateKey;
        target.heat_stress_model_run =
            row.model_run || "";
        target.heat_stress_timeline = false;

        matched += 1;
    });

    data.heat_stress_multimodel =
        matched > 0;
    data.heat_stress_multimodel_matches =
        matched;

    return data;
}


let thermalStress24hRunPromise = null;

function resolveThermalStress24hRun() {
    if (!thermalStress24hRunPromise) {
        thermalStress24hRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("thermal_stress_24h");
    }
    return thermalStress24hRunPromise;
}

async function heatStress3hFile(hour) {
    const resolvedRun = await resolveThermalStress24hRun();
    return window.MeteoRiskPublicData.artifactPath(
        resolvedRun,
        "thermal_stress_f"
            + String(hour).padStart(3, "0")
            + ".csv"
    );
}

async function ensureHeatStressReferenceRun() {
    if (heatStressReferenceRun) return heatStressReferenceRun;

    try {
        const response = await fetch(
            await heatStress3hFile(3),
            { cache: "no-store" }
        );

        if (!response.ok) return null;

        const rows = parseCsv(await response.text());
        if (!rows.length) return null;

        const first = rows[0];
        const referenceText =
            first.reference_run
            || first.model_run
            || "";

        if (referenceText) {
            const parsed = new Date(referenceText);
            if (Number.isFinite(parsed.getTime())) {
                heatStressReferenceRun = parsed;
                return heatStressReferenceRun;
            }
        }

        const validText = first.valid_time || "";
        const valid = validText ? new Date(validText) : null;

        if (valid && Number.isFinite(valid.getTime())) {
            heatStressReferenceRun = new Date(
                valid.getTime() - 3 * 60 * 60 * 1000
            );
            return heatStressReferenceRun;
        }

        return null;

    } catch (error) {
        console.warn(
            "24h thermal-stress reference run could not be determined.",
            error
        );
        return null;
    }
}

async function forecastHourFromHeatStressValidTime(validTime) {
    if (!validTime) return null;

    const referenceRun = await ensureHeatStressReferenceRun();
    if (!referenceRun) return null;

    const valid = new Date(validTime);
    if (!Number.isFinite(valid.getTime())) return null;

    const hour = Math.round(
        (valid.getTime() - referenceRun.getTime())
        / (60 * 60 * 1000)
    );

    return (
        hour >= 3
        && hour <= 120
        && hour % 3 === 0
    ) ? hour : null;
}

async function loadHeatStress3hRows(hour) {
    if (!Number.isFinite(Number(hour))) return null;

    const h = Number(hour);

    if (heatStress24hCache.has(h)) {
        return heatStress24hCache.get(h);
    }

    const path = await heatStress3hFile(h);

    try {
        const response = await fetch(
            path,
            { cache: "no-store" }
        );

        if (!response.ok) {
            console.warn(
                "24h thermal-stress file unavailable:",
                path,
                response.status
            );
            heatStress24hCache.set(h, null);
            return null;
        }

        const rows = parseCsv(await response.text());
        const byName = new Map();

        rows.forEach(row => {
            byName.set(
                normalizeMunicipalityName(
                    row.Value_sc
                    || row.Value_sl
                    || row.Value_e
                ),
                row
            );
        });

        heatStress24hCache.set(h, byName);
        return byName;

    } catch (error) {
        console.warn(
            "24h thermal-stress file load error:",
            path,
            error
        );
        heatStress24hCache.set(h, null);
        return null;
    }
}

function thermalStressModeTranslation(mode) {
    const key = String(mode || "").toUpperCase();

    const sr = {
        DAY: "Дневни топлотни стрес",
        NIGHT: "Ноћни топлотни стрес",
        TRANSITION: "Прелазни период"
    };

    const en = {
        DAY: "Daytime heat stress",
        NIGHT: "Night-time heat stress",
        TRANSITION: "Transition period"
    };

    return (currentLanguage === "sr" ? sr : en)[key] || "—";
}

function thermalStressCategoryFromColor(color) {
    const key = String(color || "").toUpperCase();

    const sr = {
        GREEN: "Без значајног топлотног стреса",
        YELLOW: "Повишен топлотни стрес",
        ORANGE: "Изражен топлотни стрес",
        RED: "Веома висок топлотни стрес",
        PURPLE: "Екстреман топлотни стрес"
    };

    const en = {
        GREEN: "No significant heat stress",
        YELLOW: "Elevated heat stress",
        ORANGE: "Marked heat stress",
        RED: "Very high heat stress",
        PURPLE: "Extreme heat stress"
    };

    return (currentLanguage === "sr" ? sr : en)[key] || "—";
}

function firstOptional(row, names) {
    for (const name of names) {
        const value = optionalNumber(row[name]);
        if (value !== null) return value;
    }
    return null;
}

async function applyHeatStressTimelineOverlay(data) {
    if (!data || !geometryData) return data;

    const hour = await forecastHourFromHeatStressValidTime(
        data.valid_time
    );

    if (hour === null) {
        data.heat_stress_multimodel = false;
        data.heat_stress_multimodel_matches = 0;
        return data;
    }

    const rowsByName = await loadHeatStress3hRows(hour);

    if (!rowsByName) {
        data.heat_stress_multimodel = false;
        data.heat_stress_multimodel_matches = 0;
        return data;
    }

    let matched = 0;
    let availableMatched = 0;

    geometryData.features.forEach(feature => {
        const properties = feature.properties || {};

        const name = normalizeMunicipalityName(
            properties.Value_sc
            || properties.Value_sl
            || properties.Value_e
        );

        const row = rowsByName.get(name);
        if (!row) return;

        const id = municipalityId(properties);
        if (!data.municipalities || !data.municipalities[id]) return;

        const target = data.municipalities[id];

        /* Remove values inherited from the daily Heat Index overlay.
           Otherwise the last incomplete night can retain an older
           orange/red value even though the 24h product is unavailable. */
        target.heat_stress = null;
        target.heat_stress_gefs = null;
        target.heat_stress_icon = null;
        target.heat_stress_p_below_27 = null;
        target.heat_stress_p_27_32 = null;
        target.heat_stress_p_32_41 = null;
        target.heat_stress_p_41_54 = null;
        target.heat_stress_p_ge_54 = null;
        target.heat_stress_night_tmin = null;
        target.heat_stress_gefs_night_tmin = null;
        target.heat_stress_icon_night_tmin = null;
        target.heat_stress_p_tmin_lt20 = null;
        target.heat_stress_p_tmin_20_22 = null;
        target.heat_stress_p_tmin_22_24 = null;
        target.heat_stress_p_tmin_24_26 = null;
        target.heat_stress_p_tmin_ge26 = null;

        const color = String(
            row.thermal_stress_color || ""
        ).toUpperCase();

        const unavailable =
            color === "UNAVAILABLE"
            || String(row.night_qc || "").toUpperCase() === "INCOMPLETE"
               && String(row.thermal_stress_mode || "").toUpperCase() === "NIGHT";

        target.heat_stress_multimodel = !unavailable;
        target.heat_stress_timeline = true;

        target.heat_stress_color =
            unavailable ? "GREY" : (color || "GREEN");

        target.heat_stress_mode =
            row.thermal_stress_mode || "";

        target.heat_stress_score =
            optionalNumber(row.thermal_stress_score);

        target.heat_stress_day_weight =
            optionalNumber(row.day_weight);

        target.heat_stress_night_weight =
            optionalNumber(row.night_weight);

        target.heat_stress_night_qc =
            row.night_qc || "";

        target.heat_stress_valid_time =
            row.valid_time || data.valid_time;

        target.heat_stress_local_time =
            row.local_time || "";

        target.heat_stress_forecast_hour =
            optionalNumber(row.forecast_hour) ?? hour;

        /* Daytime Heat Index diagnostics */
        target.heat_stress =
            optionalNumber(row.multimodel_heat_index);

        target.heat_stress_gefs =
            firstOptional(row, [
                "gefs_heat_index",
                "gefs_hi"
            ]);

        target.heat_stress_icon =
            firstOptional(row, [
                "icon_heat_index",
                "icon_hi"
            ]);

        target.heat_stress_p_below_27 =
            optionalNumber(row.p_below_27);
        target.heat_stress_p_27_32 =
            optionalNumber(row.p_27_32);
        target.heat_stress_p_32_41 =
            optionalNumber(row.p_32_41);
        target.heat_stress_p_41_54 =
            optionalNumber(row.p_41_54);
        target.heat_stress_p_ge_54 =
            optionalNumber(row.p_ge_54);

        /* Tropical-night diagnostics */
        target.heat_stress_night_tmin =
            optionalNumber(row.multimodel_night_tmin);

        target.heat_stress_gefs_night_tmin =
            optionalNumber(row.gefs_night_tmin);

        target.heat_stress_icon_night_tmin =
            optionalNumber(row.icon_night_tmin);

        target.heat_stress_p_tmin_lt20 =
            optionalNumber(row.p_tmin_lt20);
        target.heat_stress_p_tmin_20_22 =
            optionalNumber(row.p_tmin_20_22);
        target.heat_stress_p_tmin_22_24 =
            optionalNumber(row.p_tmin_22_24);
        target.heat_stress_p_tmin_24_26 =
            optionalNumber(row.p_tmin_24_26);
        target.heat_stress_p_tmin_ge26 =
            optionalNumber(row.p_tmin_ge26);

        target.heat_stress_category_sr =
            thermalStressCategoryFromColor(
                target.heat_stress_color
            );

        target.heat_stress_category_key =
            target.heat_stress_color;

        matched += 1;

        if (!unavailable) {
            availableMatched += 1;
        }
    });

    data.heat_stress_multimodel = availableMatched > 0;
    data.heat_stress_multimodel_matches = availableMatched;
    data.heat_stress_timeline = matched > 0;
    data.heat_stress_forecast_hour = hour;

    return data;
}

function translatedHeatStressCategory(data) {
    return thermalStressCategoryFromColor(
        data ? data.heat_stress_color : ""
    );
}

function thermalStressImpactRecommendation(data) {
    const mode =
        String(data?.heat_stress_mode || "DAY").toUpperCase();

    const color =
        String(data?.heat_stress_color || "GREEN").toUpperCase();

    const daySr = {
        GREEN: ["Без значајног дневног топлотног оптерећења.", "Уобичајене дневне активности."],
        YELLOW: ["Повећана топлотна нелагодност, нарочито код осетљивих група и при дужем боравку на сунцу.", "Редовно уносити течност и смањити дуже излагање сунцу и напор у најтоплијем делу дана."],
        ORANGE: ["Изражено топлотно оптерећење и повећан ризик од исцрпљености током рада и физичке активности на отвореном.", "Ограничити напорне активности, правити чешће паузе, боравити у хладу или расхлађеном простору и редовно уносити течност."],
        RED: ["Веома високо топлотно оптерећење са значајним ризиком од здравствених тегоба при дужем излагању.", "Избегавати физички напор и дуже излагање топлоти; активности планирати за јутарње или вечерње сате и посебно заштитити осетљиве групе."],
        PURPLE: ["Екстремно топлотно оптерећење са високим ризиком од озбиљних здравствених последица.", "Боравак и физичку активност на отвореном свести на неопходни минимум, обезбедити расхлађивање и редован унос течности."]
    };

    const nightSr = {
        GREEN: ["Очекује се довољно ноћно расхлађивање.", "Уобичајене мере за проветравање и одмор."],
        YELLOW: ["Тропска ноћ може смањити опоравак организма од дневне врућине.", "Расхладити простор пред спавање, проветравати када су спољне температуре ниже и обезбедити довољан унос течности."],
        ORANGE: ["Изражено одсуство ноћног расхлађивања повећава кумулативно топлотно оптерећење, посебно код осетљивих група.", "Обезбедити што хладнији простор за спавање, ограничити додатне изворе топлоте у просторији и обратити пажњу на старије, децу и хроничне болеснике."],
        RED: ["Веома топла ноћ значајно ограничава физиолошки опоравак и повећава ризик током вишедневне врућине.", "Обезбедити активно расхлађивање простора и појачан надзор осетљивих особа; избегавати додатно топлотно оптерећење у вечерњим сатима."],
        PURPLE: ["Екстремно топла ноћ практично онемогућава ефикасно ноћно расхлађивање организма.", "Приоритет су активно расхлађивање, доступност течности и посебна брига о најосетљивијим групама током целе ноћи."]
    };

    const dayEn = {
        GREEN: ["No significant daytime heat load.", "Normal daily activities."],
        YELLOW: ["Increased heat discomfort, especially for vulnerable groups and during prolonged sun exposure.", "Drink fluids regularly and reduce prolonged sun exposure and strenuous activity during the hottest part of the day."],
        ORANGE: ["Marked heat load with increased risk of exhaustion during outdoor work and physical activity.", "Limit strenuous activity, take frequent breaks, stay in shade or cooled spaces and drink fluids regularly."],
        RED: ["Very high heat load with a significant risk of heat-related health effects during prolonged exposure.", "Avoid physical exertion and prolonged heat exposure; schedule activities for morning or evening and protect vulnerable groups."],
        PURPLE: ["Extreme heat load with a high risk of serious heat-related health effects.", "Keep outdoor exposure and physical activity to the necessary minimum, ensure cooling and regular fluid intake."]
    };

    const nightEn = {
        GREEN: ["Sufficient night-time cooling is expected.", "Normal ventilation and rest measures."],
        YELLOW: ["A tropical night may reduce recovery from daytime heat.", "Cool the sleeping space, ventilate when outdoor temperatures are lower and maintain adequate hydration."],
        ORANGE: ["Marked lack of night-time cooling increases cumulative heat load, especially for vulnerable groups.", "Provide the coolest possible sleeping environment, limit indoor heat sources and pay particular attention to older people, children and people with chronic illness."],
        RED: ["A very warm night substantially limits physiological recovery and increases risk during multi-day heat.", "Provide active cooling and increased attention to vulnerable people; avoid additional heat load during the evening."],
        PURPLE: ["An extremely warm night largely prevents effective overnight body cooling.", "Prioritize active cooling, fluid availability and special care for the most vulnerable groups throughout the night."]
    };

    const transition =
        mode === "TRANSITION";

    const nightDominant =
        mode === "NIGHT"
        || (
            transition
            && Number(data?.heat_stress_night_weight || 0) >= 0.5
        );

    const table =
        currentLanguage === "sr"
        ? (nightDominant ? nightSr : daySr)
        : (nightDominant ? nightEn : dayEn);

    const item =
        table[color]
        || table.GREEN;

    return {
        impact: item[0],
        recommendation: item[1]
    };
}

function heatStressDetailHtml(data, options = {}) {
    if (!data || !data.heat_stress_multimodel) {
        return riskSummaryHtml({
            title: translations[currentLanguage].heatStress,
            available: false
        });
    }

    const mode = String(data.heat_stress_mode || "").toUpperCase();
    const showDay = mode === "DAY" || mode === "TRANSITION";
    const showNight = mode === "NIGHT" || mode === "TRANSITION";
    const ir = thermalStressImpactRecommendation(data);
    const level = stormColorLevelNumber(data.heat_stress_color);

    const dayBlock = showDay ? `
        <div class="popup-section">${currentLanguage === "sr" ? "Дневни топлотни стрес (Heat Index)" : "Daytime heat stress (Heat Index)"}</div>
        <div class="popup-row">${currentLanguage === "sr" ? "Мултимоделски Heat Index" : "Multimodel Heat Index"}: <b>${formatNumber(data.heat_stress, 1)} °C</b></div>
        <div class="multimodel-model-grid">
            <div><span>GEFS</span><b>${data.heat_stress_gefs == null ? "—" : formatNumber(data.heat_stress_gefs, 1) + " °C"}</b></div>
            <div><span>ICON global EPS</span><b>${data.heat_stress_icon == null ? "—" : formatNumber(data.heat_stress_icon, 1) + " °C"}</b></div>
            <div><span>${currentLanguage === "sr" ? "Мултимодел" : "Multimodel"}</span><b>${formatNumber(data.heat_stress, 1)} °C</b></div>
        </div>
        <div class="popup-section">${currentLanguage === "sr" ? "Расподела Heat Index категорија" : "Heat Index category distribution"}</div>
        <div class="popup-row">&lt;27 °C: <b>${formatProbability(data.heat_stress_p_below_27)}</b></div>
        <div class="popup-row">27–32 °C: <b>${formatProbability(data.heat_stress_p_27_32)}</b></div>
        <div class="popup-row">32–41 °C: <b>${formatProbability(data.heat_stress_p_32_41)}</b></div>
        <div class="popup-row">41–54 °C: <b>${formatProbability(data.heat_stress_p_41_54)}</b></div>
        <div class="popup-row">≥54 °C: <b>${formatProbability(data.heat_stress_p_ge_54)}</b></div>
    ` : "";

    const nightBlock = showNight ? `
        <div class="popup-section">${currentLanguage === "sr" ? "Ноћни топлотни стрес" : "Night-time heat stress"}</div>
        <div class="popup-row">${currentLanguage === "sr" ? "Мултимоделски минимум током ноћи" : "Multimodel overnight minimum"}: <b>${formatNumber(data.heat_stress_night_tmin, 1)} °C</b></div>
        <div class="multimodel-model-grid">
            <div><span>GEFS</span><b>${data.heat_stress_gefs_night_tmin == null ? "—" : formatNumber(data.heat_stress_gefs_night_tmin, 1) + " °C"}</b></div>
            <div><span>ICON global EPS</span><b>${data.heat_stress_icon_night_tmin == null ? "—" : formatNumber(data.heat_stress_icon_night_tmin, 1) + " °C"}</b></div>
            <div><span>${currentLanguage === "sr" ? "Мултимодел" : "Multimodel"}</span><b>${formatNumber(data.heat_stress_night_tmin, 1)} °C</b></div>
        </div>
        <div class="popup-section">${currentLanguage === "sr" ? "Расподела категорија ноћног минимума" : "Overnight-minimum category distribution"}</div>
        <div class="popup-row">&lt;20 °C: <b>${formatProbability(data.heat_stress_p_tmin_lt20)}</b></div>
        <div class="popup-row">20–22 °C: <b>${formatProbability(data.heat_stress_p_tmin_20_22)}</b></div>
        <div class="popup-row">22–24 °C: <b>${formatProbability(data.heat_stress_p_tmin_22_24)}</b></div>
        <div class="popup-row">24–26 °C: <b>${formatProbability(data.heat_stress_p_tmin_24_26)}</b></div>
        <div class="popup-row">≥26 °C: <b>${formatProbability(data.heat_stress_p_tmin_ge26)}</b></div>
    ` : "";

    const technical = `
        <div class="multimodel-card">
            <div class="popup-section">${currentLanguage === "sr" ? "24-часовни топлотни стрес" : "24-hour thermal stress"}</div>
            <div class="popup-row">${currentLanguage === "sr" ? "Режим" : "Mode"}: <b>${thermalStressModeTranslation(mode)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Категорија" : "Category"}: <b>${translatedHeatStressCategory(data)}</b></div>
            ${dayBlock}
            ${nightBlock}
            ${mode === "TRANSITION" ? `<div class="popup-note">${currentLanguage === "sr"
                ? "Прелазни термин комбинује дневни Heat Index и сигнал топле/тропске ноћи постепеним тежинским прелазом."
                : "The transition slot gradually blends the daytime Heat Index with the warm/tropical-night signal."}</div>` : ""}
            <div class="popup-note">${currentLanguage === "sr"
                ? "Развојни мултимоделски производ GEFS + ICON global EPS. Дневни део користи Heat Index, а ноћни део ансамблску прогнозу минималне температуре током ноћи. Производ је експерименталан."
                : "Developmental GEFS + ICON global EPS multimodel product. The daytime component uses Heat Index and the night-time component uses the ensemble overnight-minimum forecast. The product is experimental."}</div>
        </div>
    `;

    if (options.technicalOnly) return technical;

    const value = mode === "NIGHT"
        ? `${currentLanguage === "sr" ? "Ноћни минимум" : "Overnight minimum"}: <b>${formatNumber(data.heat_stress_night_tmin, 1)} °C</b>`
        : `${currentLanguage === "sr" ? "Heat Index / сигнал" : "Heat Index / signal"}: <b>${formatNumber(data.heat_stress, 1)} °C</b>`;

    return riskSummaryHtml({
        title: translations[currentLanguage].heatStress,
        level,
        category: translatedHeatStressCategory(data),
        value,
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta: `${currentLanguage === "sr" ? "Режим" : "Mode"}: ${thermalStressModeTranslation(mode)}`
    }) + expertDetailsHtml(technical);
}

