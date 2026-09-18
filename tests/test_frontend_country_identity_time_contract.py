from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / "js" / "config.js").read_text(encoding="utf-8")
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
TEMP = (ROOT / "js" / "hazards" / "temperature.js").read_text(encoding="utf-8")
FIRE = (ROOT / "js" / "hazards" / "fire.js").read_text(encoding="utf-8")
ENV = (ROOT / "js" / "hazards" / "environment.js").read_text(encoding="utf-8")


def test_shared_country_identity_helpers_exist():
    assert "function adminUnitId(" in CONFIG
    assert "function adminUnitMatchName(" in CONFIG
    assert "adminUnitId," in CONFIG
    assert "adminUnitMatchName," in CONFIG


def test_shared_country_local_date_helper_exists():
    assert "function localDateKey(" in CONFIG
    assert "timeZone: country.timezone" in CONFIG
    assert "localDateKey," in CONFIG


def test_app_has_no_rs_specific_identity_or_timezone_runtime():
    assert "properties.Municipality_DOM_ID" not in APP
    assert "p.Value_sc" not in APP
    assert "p.Value_sl" not in APP
    assert "p.Value_e" not in APP
    assert "localDateKeyBelgrade" not in APP
    assert 'timeZone: "Europe/Belgrade"' not in APP


def test_hazard_modules_use_country_generic_identity_and_time():
    combined = TEMP + FIRE + ENV
    assert "row.Value_sc" not in combined
    assert "properties.Value_sc" not in combined
    assert "p.Value_sc" not in combined
    assert "localDateKeyBelgrade" not in combined
    assert 'timeZone: "Europe/Belgrade"' not in combined
    assert "MeteoRiskConfig.adminUnitMatchName" in TEMP
    assert "MeteoRiskConfig.adminUnitMatchName" in FIRE
    assert "MeteoRiskConfig.adminUnitMatchName" in ENV


def test_timezone_qc_is_country_generic():
    assert "T00:00:00+02:00" not in APP
    assert "function startOfLocalToday(" not in APP
    assert "offsets.springBefore === 60" not in APP
    assert "offsets.springAfter === 120" not in APP
    assert "offsets.autumnBefore === 120" not in APP
    assert "offsets.autumnAfter === 60" not in APP
