from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIRE = (ROOT / "js" / "hazards" / "fire.js").read_text(encoding="utf-8")
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")
INDEX = (ROOT / "index.html").read_text(encoding="utf-8")


def test_fire_hdw_uses_shared_b5_consumer():
    assert 'resolveCurrentRun("fire_hdw")' in FIRE
    assert "MeteoRiskPublicData.artifactPath" in FIRE
    assert '"hdw_f"' in FIRE


def test_fire_has_no_flat_public_data_bypass():
    assert "data/fire/hdw_f" not in FIRE
    assert "data/fire/fwi_" not in FIRE
    assert "FIRE_FWI_FILES" not in FIRE


def test_retired_fwi_is_not_loaded_or_advertised_as_active():
    assert "loadFireFwiDailyRows" not in FIRE
    assert 'parameters: ["fire_hdw"]' in APP
    assert 'parameters: ["fire_fwi", "fire_hdw"]' not in APP
    assert 'data-layer="fire_fwi"' not in INDEX
    assert 'id="btn-fire-fwi"' not in INDEX


def test_fire_availability_is_hdw_only():
    assert "data.fire_available = data.fire_hdw_available;" in FIRE
    assert "return Boolean(data.fire_hdw_available);" in APP
    assert "Boolean(data.fire_fwi_available || data.fire_hdw_available)" not in APP
    assert "if (municipality.fire_fwi_available)" not in APP


def test_retired_fire_fwi_button_is_not_referenced_by_app_js():
    app = (Path(__file__).resolve().parents[1] / "js" / "app.js").read_text(encoding="utf-8")
    assert "btn-fire-fwi" not in app
