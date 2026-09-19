from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMP = (ROOT / "js" / "hazards" / "temperature.js").read_text(encoding="utf-8")
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")


def test_temperature_family_uses_shared_b5_consumer():
    assert 'resolveCurrentRun("temperature_5day")' in TEMP
    assert 'resolveCurrentRun("heat_stress_5day")' in TEMP
    assert 'resolveCurrentRun("thermal_stress_24h")' in TEMP
    assert "MeteoRiskPublicData.artifactPath" in TEMP


def test_temperature_family_has_no_flat_public_data_bypass():
    for flat in (
        "data/temperature/",
        "data/heat_stress/",
        "data/thermal_stress_24h/",
    ):
        assert flat not in TEMP


def test_latest_run_discovery_uses_b5_pointers_not_flat_csvs():
    assert 'resolveCurrentRun("temperature_5day")' in APP
    assert 'resolveCurrentRun("thermal_stress_24h")' in APP
    assert ".pointer.current_run" in APP
    assert "data/temperature/temperature_day0.csv" not in APP
    assert "data/thermal_stress_24h/thermal_stress_f003.csv" not in APP
