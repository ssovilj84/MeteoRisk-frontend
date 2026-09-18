/* ============================================================
   METEORISK HAZARD MODULE: FIRES v1
   ============================================================

   Architecture:
   - FWI = daily background fire danger from deterministic EFFIS (ECMWF or Météo-France).
   - HDW = deterministic 3-hour atmospheric fire-weather signal.
   - Timeline remains the ONLY valid-time authority.
   - Module click = max(FWI risk, HDW risk) for the active slot.
   - Parameter click = only that parameter.

   Data contracts expected by the frontend:

   fire_fwi is RETIRED in the public product registry and is not loaded by this frontend
     date,Value_sc,fwi,fwi_effis_class_id,fwi_effis_class,fwi_range,fwi_color,source,model_run

   The public operational EFFIS WMS is categorical. `fwi` may therefore be
   blank; the authoritative fields are fwi_effis_class(_id), fwi_range and
   fwi_color. Numeric FWI must never be reconstructed from rendered colours.

   B5 fire_hdw immutable artifacts hdw_f003.csv ... hdw_f120.csv
     valid_time,Value_sc,hdw,hdw_percentile,hdw_color,source,model_run

   Color fields use: GREEN / YELLOW / ORANGE / RED / PURPLE.

   FWI MeteoRisk color mapping follows the current six EFFIS classes:
     LOW (<11.2) GREEN; MODERATE (11.2-21.3) YELLOW;
     HIGH (21.3-38) ORANGE; VERY HIGH (38-50) RED;
     EXTREME (50-70) PURPLE; VERY EXTREME (>70) PURPLE.

   HDW has no universal fixed danger thresholds. hdw_color must therefore
   be produced against a Serbia/location-season climatology. The planned
   developmental MeteoRisk calibration is percentile based and is kept
   outside the raw HDW formula so it can be recalibrated without changing
   this frontend module.
   ============================================================ */

const FIRE_HDW_HOURS =
    Array.from({ length: 40 }, (_, i) => (i + 1) * 3);

let fireHdwRunPromise = null;
let fireHdwCache = {};

function resolveFireHdwRun() {
    if (!fireHdwRunPromise) {
        fireHdwRunPromise =
            window.MeteoRiskPublicData.resolveCurrentRun("fire_hdw");
    }
    return fireHdwRunPromise;
}

function fireRunIdFromModelRun(value) {
    if (!value) return "";
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return (
        String(d.getUTCFullYear()).padStart(4, "0")
        + String(d.getUTCMonth() + 1).padStart(2, "0")
        + String(d.getUTCDate()).padStart(2, "0")
        + "_"
        + String(d.getUTCHours()).padStart(2, "0")
    );
}

function fireColorFromFwi(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n >= 50) return "PURPLE";
    if (n >= 38) return "RED";
    if (n >= 21.3) return "ORANGE";
    if (n >= 11.2) return "YELLOW";
    return "GREEN";
}

function fireColorLevel(color) {
    const levels = {
        GREEN: 0,
        YELLOW: 1,
        ORANGE: 2,
        RED: 3,
        PURPLE: 4
    };
    return levels[String(color || "GREEN").toUpperCase()] ?? 0;
}

function fireColorHex(color) {
    const colors = {
        GREEN: "#a6d96a",
        YELLOW: "#ffffbf",
        ORANGE: "#fdae61",
        RED: "#d7191c",
        PURPLE: "#7b3294"
    };
    return colors[String(color || "").toUpperCase()] || "#c7c7c7";
}

async function loadFireHdwRows(hour) {
    if (!FIRE_HDW_HOURS.includes(hour)) return new Map();
    if (fireHdwCache[hour]) return fireHdwCache[hour];

    const byName = new Map();

    try {
        const resolvedRun = await resolveFireHdwRun();
        const artifact =
            "hdw_f" + String(hour).padStart(3, "0") + ".csv";
        const path = window.MeteoRiskPublicData.artifactPath(
            resolvedRun,
            artifact
        );
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) {
            console.warn("HDW file unavailable:", path, response.status);
            fireHdwCache[hour] = byName;
            return byName;
        }

        const rows = parseCsv(await response.text());
        const expectedRun = String(resolvedRun.pointer.current_run);
        const validRows = rows.every(
            row => fireRunIdFromModelRun(row.model_run) === expectedRun
        );
        if (!validRows) {
            console.warn("HDW term run identity mismatch:", artifact);
            fireHdwCache[hour] = byName;
            return byName;
        }

        rows.forEach(row => {
            const name = normalizeMunicipalityName(window.MeteoRiskConfig.adminUnitMatchName(row));
            if (name) byName.set(name, row);
        });
    } catch (error) {
        console.warn("HDW file load error:", error);
    }

    fireHdwCache[hour] = byName;
    return byName;
}


function fireLeadHourForValidTime(
    validTime,
    leadHourOverride = null
) {
    const override =
        Number(leadHourOverride);

    if (Number.isFinite(override)) {
        return override;
    }

    if (!validTime) return null;

    if (typeof displayLeadHour === "function") {
        const lead =
            Number(
                displayLeadHour(
                    validTime
                )
            );

        if (Number.isFinite(lead)) {
            return lead;
        }
    }

    return null;
}

async function applyFireOverlay(
    data,
    leadHourOverride = null
) {
    if (!data || !geometryData) return data;

    const leadHour =
        fireLeadHourForValidTime(
            data.valid_time,
            leadHourOverride
        );
    const hdwRows = Number.isFinite(leadHour)
        ? await loadFireHdwRows(leadHour)
        : new Map();

    let hdwMatched = 0;

    geometryData.features.forEach(feature => {
        const properties = feature.properties || {};
        const name = normalizeMunicipalityName(
            window.MeteoRiskConfig.adminUnitMatchName(properties)
        );
        const id = municipalityId(properties);
        const target = data.municipalities?.[id];
        if (!target) return;

        target.fire_fwi_available = false;
        target.fire_hdw_available = false;

        const hdwRow = hdwRows.get(name);
        if (hdwRow) {
            const hdw = optionalNumber(hdwRow.hdw);
            const percentile = optionalNumber(hdwRow.hdw_percentile);
            const color = String(hdwRow.hdw_color || "").toUpperCase();

            if (hdw !== null && color) {
                target.fire_hdw_available = true;
                target.fire_hdw = hdw;
                target.fire_hdw_percentile = percentile;
                target.fire_hdw_color = color;
                target.fire_hdw_valid_time = hdwRow.valid_time || data.valid_time;
                target.fire_hdw_source = hdwRow.source || "ECMWF IFS";
                target.fire_hdw_model_run = hdwRow.model_run || "";
                hdwMatched += 1;
            }
        }
    });

    data.fire_fwi_matches = 0;
    data.fire_hdw_matches = hdwMatched;
    data.fire_fwi_available = false;
    data.fire_hdw_available = hdwMatched > 0;
    data.fire_available = data.fire_hdw_available;

    return data;
}

function fireFwiRiskLevel(data) {
    if (!data || !data.fire_fwi_available) return 0;
    return fireColorLevel(data.fire_fwi_color);
}

function fireHdwRiskLevel(data) {
    if (!data || !data.fire_hdw_available) return 0;
    return fireColorLevel(data.fire_hdw_color);
}

function translatedFireFwiCategory(data) {
    const classId = Number(data?.fire_fwi_effis_class_id);
    if (Number.isFinite(classId) && classId >= 1 && classId <= 6) {
        const sr6 = ["ниска", "умерена", "висока", "веома висока", "екстремна", "веома екстремна"];
        const en6 = ["low", "moderate", "high", "very high", "extreme", "very extreme"];
        return (currentLanguage === "sr" ? sr6 : en6)[classId - 1];
    }

    const level = fireFwiRiskLevel(data);
    const sr = ["ниска", "умерена", "висока", "веома висока", "екстремна"];
    const en = ["low", "moderate", "high", "very high", "extreme"];
    return (currentLanguage === "sr" ? sr : en)[level] || "—";
}

function fireFwiValueLabel(data) {
    const n = optionalNumber(data?.fire_fwi);
    if (n !== null) return `FWI ${formatNumber(n, 1)}`;
    const range = String(data?.fire_fwi_range || "").trim();
    return range
        ? `${currentLanguage === "sr" ? "EFFIS FWI класа" : "EFFIS FWI class"} (${range})`
        : (currentLanguage === "sr" ? "EFFIS FWI класа" : "EFFIS FWI class");
}

function translatedFireHdwCategory(data) {
    const level = fireHdwRiskLevel(data);
    const sr = [
        "без значајно повишеног атмосферског сигнала",
        "повишен",
        "изражен",
        "веома висок",
        "екстреман"
    ];
    const en = [
        "no significantly elevated atmospheric signal",
        "elevated",
        "marked",
        "very high",
        "extreme"
    ];
    return (currentLanguage === "sr" ? sr : en)[level] || "—";
}

function fireFwiImpactRecommendation(data) {
    const level = fireFwiRiskLevel(data);

    const sr = [
        [
            "Општа метеоролошка пожарна опасност је ниска, али локално паљење и ширење пожара нису искључени.",
            "Примењивати уобичајене мере опреза и избегавати неконтролисано коришћење ватре на отвореном."
        ],
        [
            "Услови су повољнији за настанак и ширење пожара, нарочито у сувом и лако запаљивом горивом материјалу.",
            "Повећати опрез при свим активностима са отвореним пламеном и благовремено пријавити уочени пожар."
        ],
        [
            "Пожари могу брже да се развијају и шире, а локално је могуће отежано почетно гашење.",
            "Избегавати паљење на отвореном; појачати осматрање и спремност за брзу реакцију у пожарно осетљивим подручјима."
        ],
        [
            "Веома висока пожарна опасност; започети пожар може брзо да добије на интензитету и постане тежак за контролу.",
            "Не користити ватру на отвореном; надлежне службе и локалне заједнице треба да појачају превентивне мере и оперативну приправност."
        ],
        [
            "Екстремна метеоролошка пожарна опасност; у погодном горивом материјалу могућ је веома брз развој интензивног пожара и веома тешко сузбијање.",
            "Максимално ограничити изворе паљења, појачати надзор и приправност и поступати у складу са упутствима надлежних служби."
        ]
    ];

    const en = [
        ["General meteorological fire danger is low, although local ignition and spread remain possible.", "Use normal fire-safety precautions and avoid uncontrolled open burning."],
        ["Conditions are more supportive of ignition and fire spread, especially where fuels are dry and easily ignited.", "Use increased caution with any open flame and report observed fires promptly."],
        ["Fires may develop and spread more rapidly and initial attack may locally become more difficult.", "Avoid open burning; increase surveillance and readiness for rapid response in fire-prone areas."],
        ["Very high fire danger; a new fire may intensify quickly and become difficult to control.", "Do not use open fire; authorities and local communities should strengthen preventive measures and operational readiness."],
        ["Extreme meteorological fire danger; where fuels are receptive, very rapid development of an intense and difficult-to-control fire is possible.", "Minimize ignition sources, strengthen surveillance and readiness, and follow instructions from competent authorities."]
    ];

    const item = (currentLanguage === "sr" ? sr : en)[level] || ["—", "—"];
    return { impact: item[0], recommendation: item[1] };
}

function fireHdwImpactRecommendation(data) {
    const level = fireHdwRiskLevel(data);

    const sr = [
        [
            "Атмосферски услови нису значајно повишени у односу на климатологију за овај део године.",
            "Пратити основну пожарну опасност (FWI) и локално стање горивог материјала."
        ],
        [
            "Топли, суви и ветровити услови могу подржати брже ширење већ насталог пожара.",
            "Обратити већу пажњу на период са повишеним HDW сигналом, нарочито ако је и FWI повишен."
        ],
        [
            "Изражена атмосферска подршка бржем и интензивнијем понашању пожара уколико је гориви материјал погодан.",
            "Појачати осматрање и оперативну спремност током овог 3-часовног периода и избегавати активности које могу изазвати паљење."
        ],
        [
            "Веома јака комбинација топлоте, сувоће и ветра може знатно отежати контролу активног пожара и убрзати његово ширење.",
            "Третирати овај термин као критичан fire-weather период; појачати превентивне мере, осматрање и спремност за брзу интервенцију."
        ],
        [
            "Екстремно аномални топли, суви и ветровити услови могу снажно подржати опасно понашање активног пожара.",
            "Највиши ниво пажње током овог термина; максимално ограничити изворе паљења и обезбедити појачану оперативну приправност."
        ]
    ];

    const en = [
        ["Atmospheric conditions are not significantly elevated relative to the climatology for this time of year.", "Track the background FWI fire danger and local fuel conditions."],
        ["Hot, dry and windy conditions may support faster spread of an established fire.", "Pay increased attention during the elevated HDW period, especially when FWI is also elevated."],
        ["Marked atmospheric support for faster and more intense fire behaviour is possible where fuels are receptive.", "Increase surveillance and operational readiness during this 3-hour period and avoid activities that can cause ignition."],
        ["A very strong combination of heat, dryness and wind may substantially accelerate spread and make an active fire harder to control.", "Treat this slot as a critical fire-weather period; strengthen prevention, surveillance and rapid-response readiness."],
        ["Extremely anomalous hot, dry and windy conditions may strongly support dangerous behaviour of an active fire.", "Use the highest level of attention during this period; minimize ignition sources and ensure enhanced operational readiness."]
    ];

    const item = (currentLanguage === "sr" ? sr : en)[level] || ["—", "—"];
    return { impact: item[0], recommendation: item[1] };
}

function fireFwiDetailHtml(data, options = {}) {
    const t = translations[currentLanguage];

    if (!data || !data.fire_fwi_available) {
        return riskSummaryHtml({ title: t.fireDanger, available: false });
    }

    const ir = fireFwiImpactRecommendation(data);
    const level = fireFwiRiskLevel(data);

    const technical = `
        <div class="multimodel-card">
            <div class="popup-section">${t.fireDanger} · FWI</div>
            ${optionalNumber(data.fire_fwi) !== null
                ? `<div class="popup-row">FWI: <b>${formatNumber(data.fire_fwi, 1)}</b></div>`
                : `<div class="popup-row">${currentLanguage === "sr" ? "EFFIS FWI опсег" : "EFFIS FWI range"}: <b>${data.fire_fwi_range || "—"}</b></div>`}
            <div class="popup-row">${t.fireCategory}: <b>${translatedFireFwiCategory(data)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Извор" : "Source"}: <b>${data.fire_fwi_source || "EFFIS deterministic FWI"}</b></div>
            <div class="popup-note">${currentLanguage === "sr"
                ? "FWI је дневни индекс метеоролошке пожарне опасности. Не представља прогнозу места настанка пожара."
                : "FWI is a daily meteorological fire-danger index. It does not predict where a fire will ignite."}</div>
        </div>
    `;

    if (options.technicalOnly) return technical;

    return riskSummaryHtml({
        title: `${t.fireDanger} · FWI`,
        level,
        category: translatedFireFwiCategory(data),
        value: fireFwiValueLabel(data),
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta: currentLanguage === "sr" ? "Дневна позадинска пожарна опасност" : "Daily background fire danger"
    }) + expertDetailsHtml(technical);
}


function fireHdwDetailHtml(data, options = {}) {
    const t = translations[currentLanguage];

    if (!data || !data.fire_hdw_available) {
        return riskSummaryHtml({ title: t.fireSpread, available: false });
    }

    const ir = fireHdwImpactRecommendation(data);
    const percentile = optionalNumber(data?.fire_hdw_percentile);
    const level = fireHdwRiskLevel(data);

    const technical = `
        <div class="multimodel-card">
            <div class="popup-section">${t.fireSpread} · HDW</div>
            <div class="popup-row">HDW: <b>${formatNumber(data.fire_hdw, 1)}</b></div>
            <div class="popup-row">${t.fireHdwCategory}: <b>${translatedFireHdwCategory(data)}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Климатолошки перцентил" : "Climatological percentile"}: <b>${percentile !== null ? formatNumber(percentile, 0) + "." : "—"}</b></div>
            <div class="popup-row">${currentLanguage === "sr" ? "Извор" : "Source"}: <b>${data.fire_hdw_source || "ECMWF IFS"}</b></div>
            <div class="popup-note">${currentLanguage === "sr"
                ? "HDW описује само атмосферску компоненту (топло–суво–ветровито). Не садржи стање горивог материјала, топографију нити вероватноћу паљења; зато се тумачи заједно са FWI."
                : "HDW describes only the atmospheric component (hot-dry-windy). It does not include fuel condition, topography or ignition probability and should therefore be interpreted together with FWI."}</div>
        </div>
    `;

    if (options.technicalOnly) return technical;

    return riskSummaryHtml({
        title: `${t.fireSpread} · HDW`,
        level,
        category: translatedFireHdwCategory(data),
        value: `HDW <b>${formatNumber(data.fire_hdw, 1)}</b>${Number.isFinite(percentile) ? ` · P${formatNumber(percentile, 0)}` : ""}`,
        impact: ir.impact,
        recommendation: ir.recommendation,
        meta: currentLanguage === "sr" ? "3-часовни атмосферски потенцијал брзог ширења" : "3-hour atmospheric rapid-spread potential"
    }) + expertDetailsHtml(technical);
}


function fireOverviewGroupHtml(forecasts, municipalityID) {
    const t = translations[currentLanguage];

    const relevant = forecasts.filter(forecast => {
        if (!overviewSelectedDate) return true;
        return window.MeteoRiskConfig.localDateKey(forecast.valid_time) === overviewSelectedDate;
    });

    const fwiByDate = new Map();
    const hdwItems = [];

    relevant.forEach(forecast => {
        const data = forecast.municipalities?.[municipalityID];
        if (!data) return;

        const dateKey = window.MeteoRiskConfig.localDateKey(forecast.valid_time);

        if (
            data.fire_fwi_available
            && dateKey
            && !fwiByDate.has(dateKey)
        ) {
            fwiByDate.set(dateKey, data);
        }

        if (data.fire_hdw_available) {
            hdwItems.push({
                forecast,
                data,
                level: fireHdwRiskLevel(data)
            });
        }
    });

    if (!fwiByDate.size && !hdwItems.length) {
        return "";
    }

    let fwiHtml = "";

    if (fwiByDate.size) {
        const fwiRows =
            Array.from(fwiByDate.keys())
            .sort()
            .map(dateKey => {
                const data = fwiByDate.get(dateKey);
                const ir = fireFwiImpactRecommendation(data);

                return `
                    <div class="overview-day-block">
                        <div class="overview-period">
                            <b>${formatOverviewDateKey(dateKey)}</b>
                            — ${fireFwiValueLabel(data)}
                            — <b>${translatedFireFwiCategory(data)}</b>
                        </div>
                        ${overviewSelectedDate ? `
                            <div class="overview-muted" style="margin-top:7px;">
                                <b>${t.impacts}:</b> ${ir.impact}
                            </div>
                            <div class="overview-muted" style="margin-top:5px;">
                                <b>${t.recommendations}:</b> ${ir.recommendation}
                            </div>
                        ` : ""}
                    </div>
                `;
            })
            .join("");

        fwiHtml = `
            <div class="overview-risk">
                <div class="overview-risk-name">${t.fireDanger}</div>
                ${fwiRows}
            </div>
        `;
    }

    let hdwHtml = "";
    const significant = hdwItems.filter(item => item.level >= 1);
    const shown =
        significant.length
        ? significant
        : (overviewShowAll ? hdwItems : []);

    if (shown.length) {
        let periods = "";

        shown.forEach(item => {
            periods += `
                <div class="overview-period">
                    ${formatOverviewInterval(
                        item.forecast.valid_time,
                        item.forecast.valid_time
                    )}
                    — HDW ${formatNumber(item.data.fire_hdw, 1)}
                    ${Number.isFinite(Number(item.data.fire_hdw_percentile))
                        ? ` — P${formatNumber(item.data.fire_hdw_percentile, 0)}`
                        : ""}
                    — <b>${translatedFireHdwCategory(item.data)}</b>
                </div>
            `;
        });

        let details = "";

        if (overviewSelectedDate && shown.length) {
            const strongest =
                shown.reduce(
                    (best, item) =>
                        !best || item.level > best.level
                        ? item
                        : best,
                    null
                );

            const ir =
                fireHdwImpactRecommendation(strongest.data);

            details = `
                <div class="overview-muted" style="margin-top:7px;">
                    <b>${t.impacts}:</b> ${ir.impact}
                </div>
                <div class="overview-muted" style="margin-top:5px;">
                    <b>${t.recommendations}:</b> ${ir.recommendation}
                </div>
            `;
        }

        hdwHtml = `
            <div class="overview-risk">
                <div class="overview-risk-name">${t.fireSpread}</div>
                ${periods}
                ${details}
            </div>
        `;
    }

    return `
        <div class="overview-group">
            <div class="overview-group-title">${t.fireGroup}</div>
            ${fwiHtml}
            ${hdwHtml}
        </div>
    `;
}
