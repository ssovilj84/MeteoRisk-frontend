from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIND = (ROOT / "js" / "hazards" / "wind.js").read_text(encoding="utf-8")


def test_wind_v2_uses_shared_b5_consumer():
    assert 'resolveCurrentRun("wind_v2")' in WIND
    assert 'MeteoRiskPublicData.artifactPath' in WIND
    assert '"manifest.json"' in WIND


def test_wind_v2_has_no_flat_public_data_bypass():
    assert "data/wind/" not in WIND
    assert "WIND_V2_MANIFEST_FILE" not in WIND
    assert "WIND_V2_DATA_ROOT" not in WIND


def test_wind_manifest_and_terms_are_bound_to_resolved_run():
    assert "resolvedRun.pointer.current_run" in WIND
    assert "manifest.run_id" in WIND
    assert '"f" + String(term.forecast_hour).padStart(3, "0") + ".json"' in WIND
    assert "term.file" in WIND
    assert "resolvedRun.pointer.run_path" in WIND
