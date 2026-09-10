/* ============================================================
   METEORISK - VETAR v2
   ------------------------------------------------------------
   Standalone multimodel overlay keyed by actual valid_time.

   Public product:
   - one VETAR risk layer
   - final risk: green/yellow/orange/red/purple
   - expected gust range and direction

   Expert details:
   - P17 / P20 / P25 / P32
   - GEFS vs ICON-EU EPS
   - model agreement / confidence
   - provenance and purple agreement gate

   IMPORTANT:
   Missing ICON native 3-hour terms are never interpolated and never
   treated as zero. Terms with fewer available RATIFIED streams are represented explicitly through Registry provenance.
   ============================================================ */

const WIND_V2_MANIFEST_FILE = "data/wind/manifest.json";
const WIND_V2_DATA_ROOT = "data/wind/";

let windV2ManifestPromise = null;
const windV2TermCache = new Map();


function windV2NormalizeIso(value) {
    if (!value) return "";

    const date = new Date(value);

    return Number.isFinite(date.getTime())
        ? date.toISOString()
        : "";
}


async function loadWindV2Manifest() {
    if (windV2ManifestPromise) {
        return windV2ManifestPromise;
    }

    windV2ManifestPromise = (async () => {
        try {
            const response = await fetch(
                WIND_V2_MANIFEST_FILE,
                { cache: "no-store" }
            );

            if (!response.ok) {
                console.warn(
                    "VETAR v2 manifest unavailable: HTTP "
                    + response.status
                );
                return null;
            }

            const manifest = await response.json();

            if (
                !manifest
                || manifest.schema !== "meteorisk_wind_v2"
                || !Array.isArray(manifest.terms)
            ) {
                console.warn(
                    "VETAR v2 manifest has an invalid schema."
                );
                return null;
            }

            manifest.byValidTime = new Map();

            manifest.terms.forEach(term => {
                const key = windV2NormalizeIso(
                    term.valid_time
                );

                if (key) {
                    manifest.byValidTime.set(
                        key,
                        term
                    );
                }
            });

            return manifest;

        } catch (error) {
            console.warn(
                "VETAR v2 manifest could not be loaded.",
                error
            );
            return null;
        }
    })();

    return windV2ManifestPromise;
}


async function windV2LatestValidTime() {
    const manifest = await loadWindV2Manifest();

    if (!manifest || !manifest.terms.length) {
        return null;
    }

    let latestMs = NaN;

    manifest.terms.forEach(term => {
        const ms = new Date(
            term.valid_time
        ).getTime();

        if (!Number.isFinite(ms)) return;

        if (
            !Number.isFinite(latestMs)
            || ms > latestMs
        ) {
            latestMs = ms;
        }
    });

    return Number.isFinite(latestMs)
        ? new Date(latestMs).toISOString()
        : null;
}


async function loadWindV2Term(term) {
    if (!term || !term.file) return null;

    const key = String(term.file);

    if (windV2TermCache.has(key)) {
        return windV2TermCache.get(key);
    }

    try {
        const response = await fetch(
            WIND_V2_DATA_ROOT + key,
            { cache: "no-store" }
        );

        if (!response.ok) {
            console.warn(
                "VETAR v2 term unavailable: "
                + key
                + " | HTTP "
                + response.status
            );
            return null;
        }

        const payload = await response.json();

        if (
            !payload
            || payload.schema !== "meteorisk_wind_v2_term"
            || !payload.municipalities
        ) {
            console.warn(
                "VETAR v2 term has an invalid schema: "
                + key
            );
            return null;
        }

        windV2TermCache.set(
            key,
            payload
        );

        return payload;

    } catch (error) {
        console.warn(
            "VETAR v2 term could not be loaded: "
            + key,
            error
        );
        return null;
    }
}


async function applyWindV2Overlay(data) {
    if (!data || !data.municipalities) {
        return data;
    }

    data.wind_available = false;
    data.wind_v2_available = false;
    data.wind_v2_matches = 0;

    const validKey = windV2NormalizeIso(
        data.valid_time
    );

    if (!validKey) return data;

    const manifest = await loadWindV2Manifest();

    if (!manifest || !manifest.byValidTime) {
        return data;
    }

    const term = manifest.byValidTime.get(
        validKey
    );

    if (!term) {
        return data;
    }

    const payload = await loadWindV2Term(
        term
    );

    if (!payload) {
        return data;
    }

    const payloadValid = windV2NormalizeIso(
        payload.valid_time
    );

    if (payloadValid !== validKey) {
        console.warn(
            "VETAR v2 valid_time mismatch. Timeline=",
            validKey,
            "payload=",
            payloadValid
        );
        return data;
    }

    let matched = 0;

    Object.entries(
        payload.municipalities
    ).forEach(([id, source]) => {
        const target = data.municipalities[id];
        if (!target) return;

        Object.assign(
            target,
            source
        );

        target.wind_v2_available = true;
        matched += 1;
    });

    data.wind_available = matched > 0;
    data.wind_v2_available = matched > 0;
    data.wind_v2_matches = matched;
    data.wind_stream_ids = Array.isArray(payload.stream_ids) ? payload.stream_ids : (term.stream_ids || []);
    data.wind_model_count = Number(payload.model_count ?? term.model_count ?? 0);
    data.wind_source_runs = payload.source_runs || {};
    data.wind_data_status = payload.data_status || term.data_status || "";
    data.wind_fallback_used = Boolean(payload.fallback_used ?? term.fallback_used);
    data.wind_initialization_skew_hours = Number(payload.initialization_skew_hours ?? 0);
    data.wind_source = data.wind_stream_ids.join(", ");
    data.wind_run_id = manifest.run_id || "";
    data.wind_valid_time = payload.valid_time || term.valid_time || "";
    data.wind_forecast_hour = Number(
        payload.forecast_hour ?? term.forecast_hour
    );
    data.wind_experimental = true;

    return data;
}


function windV2DataAvailable(data) {
    return Boolean(
        data
        && data.wind_v2_available === true
    );
}


function windV2RiskLevel(data) {
    if (!windV2DataAvailable(data)) {
        return 0;
    }

    const explicit = Number(
        data.wind_risk_level_num
    );

    if (
        Number.isInteger(explicit)
        && explicit >= 0
        && explicit <= 4
    ) {
        return explicit;
    }

    const levels = {
        green: 0,
        yellow: 1,
        orange: 2,
        red: 3,
        purple: 4
    };

    return levels[
        String(
            data.wind_risk_level || "green"
        ).toLowerCase()
    ] ?? 0;
}


function windV2ColorHex(level) {
    const colors = {
        green: "#a6d96a",
        yellow: "#ffffbf",
        orange: "#fdae61",
        red: "#d7191c",
        purple: "#7b3294"
    };

    return colors[
        String(level || "green").toLowerCase()
    ] || "#c7c7c7";
}


function windV2RiskName(level) {
    const key = String(
        level || "green"
    ).toLowerCase();

    const sr = {
        green: "без значајног ризика",
        yellow: "повишен",
        orange: "умерен",
        red: "висок",
        purple: "веома висок"
    };

    const en = {
        green: "no significant risk",
        yellow: "elevated",
        orange: "moderate",
        red: "high",
        purple: "very high"
    };

    return (
        currentLanguage === "sr"
        ? sr
        : en
    )[key] || key;
}


function windV2ConfidenceName(value) {
    const key = String(
        value || ""
    ).toLowerCase();

    const sr = {
        high: "висока",
        medium: "средња",
        low: "ниска",
        single_model: "један модел"
    };

    const en = {
        high: "high",
        medium: "medium",
        low: "low",
        single_model: "single model"
    };

    return (
        currentLanguage === "sr"
        ? sr
        : en
    )[key] || value || "—";
}


function windV2ImpactRecommendation(data) {
    const key = String(
        data?.wind_risk_level || "green"
    ).toLowerCase();

    const sr = {
        green: [
            "Не очекују се значајнији утицаји ветра.",
            "Нису потребне посебне мере ван уобичајеног праћења прогнозе."
        ],
        yellow: [
            "Могући су локални проблеми са лаким и слабо причвршћеним предметима и отежано кретање на изложеним деоницама.",
            "Обезбедити лаке предмете на отвореном и обратити пажњу на изложене деонице."
        ],
        orange: [
            "Могући су израженији проблеми у саобраћају, ломљење мањих грана и померање или оштећење лакших предмета и конструкција.",
            "Избегавати непотребно задржавање испод дрвећа и нестабилних конструкција и обезбедити предмете на отвореном."
        ],
        red: [
            "Могућа су значајнија оштећења, ломљење грана и стабала, проблеми у саобраћају и локални прекиди инфраструктурних система.",
            "Ограничити боравак на изложеним местима, обезбедити имовину и пратити званична упозорења и упутства надлежних служби."
        ],
        purple: [
            "Могуће су веома озбиљне последице услед екстремних удара ветра, укључујући већу материјалну штету и поремећаје инфраструктуре.",
            "Избегавати кретање и боравак на изложеним местима, предузети мере заштите имовине и строго пратити упутства надлежних служби."
        ]
    };

    const en = {
        green: [
            "No significant wind impacts are expected.",
            "No special measures are needed beyond normal forecast monitoring."
        ],
        yellow: [
            "Localized impacts on loose objects and exposed travel routes are possible.",
            "Secure loose outdoor objects and use caution on exposed routes."
        ],
        orange: [
            "More notable transport disruption, small branch damage and displacement or damage of light objects and structures are possible.",
            "Avoid unnecessary exposure near trees or unstable structures and secure outdoor objects."
        ],
        red: [
            "Significant damage, tree or branch failure, transport disruption and localized infrastructure interruptions are possible.",
            "Limit exposure, secure property and follow official warnings and instructions from competent authorities."
        ],
        purple: [
            "Very serious impacts from extreme wind gusts are possible, including major material damage and infrastructure disruption.",
            "Avoid exposed areas, protect property and closely follow instructions from competent authorities."
        ]
    };

    const item = (
        currentLanguage === "sr"
        ? sr
        : en
    )[key] || ["—", "—"];

    return {
        impact: item[0],
        recommendation: item[1]
    };
}


function windV2ProbabilityRows(prefix, data) {
    const thresholds = [
        [15, 54],
        [20, 72],
        [25, 90],
        [32, 115]
    ];

    return thresholds.map(
        ([threshold, kmh]) => `
            <div class="popup-row">
                P(${currentLanguage === "sr" ? "удар" : "gust"} ≥ ${threshold} m/s / ${kmh} km/h):
                <b>${formatProbability(data[`${prefix}${threshold}`])}</b>
            </div>
        `
    ).join("");
}


function windV2TechnicalHtml(data) {
    if (!windV2DataAvailable(data)) return "";

    const difference = Number(data.wind_model_max_probability_difference);
    const trigger = Number(data.wind_trigger_threshold_ms);
    const triggerProbability = Number(data.wind_trigger_probability);
    const streamIds = String(data.wind_stream_ids || data.wind_models_available || "").split(",").map(x => x.trim()).filter(Boolean);
    const modelCount = Number(data.wind_model_count || streamIds.length || 0);
    const dataStatus = data.wind_data_status || "—";
    const fallbackUsed = Boolean(data.wind_fallback_used);
    let sourceRuns = data.wind_source_runs || "";
    if (typeof sourceRuns === "string") {
        try { sourceRuns = JSON.parse(sourceRuns); } catch (_) { sourceRuns = {}; }
    }
    const runText = sourceRuns && typeof sourceRuns === "object"
        ? Object.entries(sourceRuns).map(([stream, run]) => `${stream}: ${run}`).join(" · ")
        : "";

    return `
        <div class="multimodel-card">
            <div class="popup-section">
                ${currentLanguage === "sr" ? "Коначне мултимоделске вероватноће" : "Final multimodel probabilities"}
            </div>
            ${windV2ProbabilityRows("wind_p", data)}
            <div class="popup-row">
                ${currentLanguage === "sr" ? "Активни stream-ови" : "Active streams"}:
                <b>${streamIds.join(", ") || "—"}</b>
            </div>
            <div class="popup-row">
                ${currentLanguage === "sr" ? "Број модела" : "Model count"}:
                <b>${modelCount || "—"}</b>
            </div>
            <div class="popup-row">
                ${currentLanguage === "sr" ? "Статус података" : "Data status"}:
                <b>${dataStatus}</b>
            </div>
            <div class="popup-row">
                ${currentLanguage === "sr" ? "Поузданост" : "Confidence"}:
                <b>${windV2ConfidenceName(data.wind_confidence)}</b>
            </div>
            ${Number.isFinite(difference) ? `<div class="popup-row">${currentLanguage === "sr" ? "Максимална разлика модела" : "Maximum model difference"}: <b>${formatNumber(difference, 1)} pp</b></div>` : ""}
            ${Number.isFinite(trigger) ? `<div class="popup-row">${currentLanguage === "sr" ? "Праг који одређује ризик" : "Risk-determining threshold"}: <b>${formatNumber(trigger, 0)} m/s @ ${formatProbability(triggerProbability)}</b></div>` : ""}
            ${runText ? `<div class="popup-row">${currentLanguage === "sr" ? "Изворни run-ови" : "Source runs"}: <b>${runText}</b></div>` : ""}
            ${fallbackUsed ? `<div class="popup-note">${currentLanguage === "sr" ? "Коришћен је Registry fallback за најмање један stream." : "Registry fallback was used for at least one stream."}</div>` : ""}
            ${data.wind_purple_agreement_gate_applied ? `<div class="popup-note">${currentLanguage === "sr" ? "Кандидат за љубичасти ниво није имао довољну подршку свих активних модела; примењен је multimodel agreement gate." : "The purple-level candidate lacked sufficient support from all active models; the multimodel agreement gate was applied."}</div>` : ""}
            <div class="popup-note">
                ${currentLanguage === "sr" ? "MeteoRisk развојни производ: вероватноће се комбинују једнаким тежинама 1/N по сваком доступном RATIFIED моделу. Физички прагови удара су 15 / 20 / 25 / 32 m/s. Производ није калибрисан и није званично упозорење." : "MeteoRisk developmental product: probabilities use equal 1/N weights across all available RATIFIED models. Physical gust thresholds are 15 / 20 / 25 / 32 m/s. The product is uncalibrated and is not an official warning."}
            </div>
        </div>
    `;
}


function windV2SummaryHtml(data, options = {}) {
    if (!windV2DataAvailable(data)) {
        return riskSummaryHtml({
            title: translations[currentLanguage].windGroup,
            available: false
        });
    }

    const ir = windV2ImpactRecommendation(data);
    const level = windV2RiskLevel(data);

    const median = Number(
        data.wind_gust_median
    );

    const p90 = Number(
        data.wind_gust_p90
    );

    const gustValue = (
        Number.isFinite(median)
        && Number.isFinite(p90)
    )
        ? `${currentLanguage === "sr" ? "Очекивани удари" : "Expected gusts"}: <b>${formatNumber(median, 1)}–${formatNumber(p90, 1)} m/s (${formatNumber(median * 3.6, 0)}–${formatNumber(p90 * 3.6, 0)} km/h)</b>`
        : `${currentLanguage === "sr" ? "Очекивани удари" : "Expected gusts"}: <b>—</b>`;

    const direction = Number(
        data.wind_direction
    );

    const meanSpeed = Number(
        data.wind_speed
    );

    const meta = (
        Number.isFinite(meanSpeed)
        && Number.isFinite(direction)
    )
        ? `${currentLanguage === "sr" ? "Средњи ветар" : "Mean wind"}: ${formatNumber(meanSpeed, 1)} m/s · ${data.wind_direction_text || "—"} (${formatNumber(direction, 0)}°)`
        : "";

    const summary = riskSummaryHtml({
        title: translations[currentLanguage].windGroup,
        level,
        category: windV2RiskName(
            data.wind_risk_level
        ),
        value: gustValue,
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta
    });

    if (!options.expert) {
        return summary;
    }

    return summary + expertDetailsHtml(
        windV2TechnicalHtml(data),
        currentLanguage === "sr"
            ? "Стручни детаљи ветра"
            : "Wind technical details"
    );
}


function windV2OverviewGroupHtml(
    forecasts,
    municipalityID
) {
    if (!Array.isArray(forecasts)) {
        return "";
    }

    const rows = [];

    forecasts.forEach(forecast => {
        if (!forecast) return;

        const municipality = forecast.municipalities?.[
            municipalityID
        ];

        if (!windV2DataAvailable(municipality)) {
            return;
        }

        rows.push({
            valid_time: forecast.valid_time,
            data: municipality,
            level: windV2RiskLevel(municipality)
        });
    });

    if (!rows.length) {
        return "";
    }

    const significant = rows.filter(
        row => row.level >= 1
    );

    if (!significant.length) {
        if (!overviewShowAll) return "";

        return `
            <div class="overview-group">
                <div class="overview-group-title">
                    ${translations[currentLanguage].windGroup}
                </div>
                <div class="overview-muted">
                    ${currentLanguage === "sr"
                        ? "Нема значајног ризика од ветра у изабраном периоду."
                        : "No significant wind risk in the selected period."}
                </div>
            </div>
        `;
    }

    const windows = [];
    let current = null;

    significant.forEach(row => {
        const ms = new Date(
            row.valid_time
        ).getTime();

        if (!current) {
            current = {
                start: row.valid_time,
                end: row.valid_time,
                lastMs: ms,
                maxLevel: row.level,
                maxP90: Number(row.data.wind_gust_p90),
                strongest: row.data
            };
            return;
        }

        const consecutive = (
            Number.isFinite(ms)
            && Number.isFinite(current.lastMs)
            && ms - current.lastMs === 3 * 60 * 60 * 1000
        );

        if (!consecutive) {
            windows.push(current);
            current = {
                start: row.valid_time,
                end: row.valid_time,
                lastMs: ms,
                maxLevel: row.level,
                maxP90: Number(row.data.wind_gust_p90),
                strongest: row.data
            };
            return;
        }

        current.end = row.valid_time;
        current.lastMs = ms;
        current.maxP90 = Math.max(
            Number.isFinite(current.maxP90)
                ? current.maxP90
                : -Infinity,
            Number.isFinite(Number(row.data.wind_gust_p90))
                ? Number(row.data.wind_gust_p90)
                : -Infinity
        );

        if (row.level > current.maxLevel) {
            current.maxLevel = row.level;
            current.strongest = row.data;
        }
    });

    if (current) windows.push(current);

    const riskNameForNumber = level => {
        const colors = [
            "green",
            "yellow",
            "orange",
            "red",
            "purple"
        ];
        return windV2RiskName(
            colors[level] || "green"
        );
    };

    const shownWindows =
        filterOverviewWindowsForSelectedDate(
            windows
        );

    if (!shownWindows.length) {
        if (!overviewShowAll) return "";
    }

    let strongestWindow =
        shownWindows[0] || windows[0];

    shownWindows.forEach(window => {
        if (
            window.maxLevel
            > strongestWindow.maxLevel
        ) {
            strongestWindow = window;
        }
    });

    const periods = shownWindows.map(window => `
        <div class="overview-period">
            ${formatOverviewInterval(
                window.start,
                window.end,
                {
                    clipToSelectedDay: true
                }
            )}
            — <b>${riskNameForNumber(window.maxLevel)}</b>
            ${Number.isFinite(window.maxP90) && window.maxP90 >= 0
                ? ` · P90 ${formatNumber(window.maxP90, 1)} m/s`
                : ""}
        </div>
    `).join("");

    let impactHtml = "";

    if (
        overviewSelectedDate
        && strongestWindow?.strongest
    ) {
        const ir = windV2ImpactRecommendation(
            strongestWindow.strongest
        );

        impactHtml = `
            <div class="overview-muted" style="margin-top:7px;">
                <b>${translations[currentLanguage].impacts}:</b>
                ${ir.impact}
            </div>
            <div class="overview-muted" style="margin-top:5px;">
                <b>${translations[currentLanguage].recommendations}:</b>
                ${ir.recommendation}
            </div>
        `;
    }

    return `
        <div class="overview-group">
            <div class="overview-group-title">
                ${translations[currentLanguage].windGroup}
            </div>
            <div class="overview-risk">
                <div class="overview-risk-name">
                    ${currentLanguage === "sr" ? "Ризик од ветра" : "Wind risk"}
                </div>
                ${periods}
                ${impactHtml}
            </div>
        </div>
    `;
}
