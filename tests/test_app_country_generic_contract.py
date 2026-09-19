from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_shared_config_exposes_generic_country_helpers():
    text = (ROOT / "js" / "config.js").read_text(encoding="utf-8")
    assert "adminUnitName" in text
    assert "mapBounds" in text
    assert "timezone" in text


def test_app_uses_shared_country_configuration():
    text = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
    assert "window.MeteoRiskConfig.adminPath" in text
    assert "window.MeteoRiskConfig.country.timezone" in text
    assert "window.MeteoRiskConfig.adminUnitName" in text
    assert "window.MeteoRiskConfig.mapBounds" in text
    assert 'countryCode: "RS"' not in text
    assert "data/static/municipalities_web.geojson" not in text
    assert 'const METEORISK_TIME_ZONE = "Europe/Belgrade"' not in text
