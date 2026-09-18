from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = (ROOT / "js" / "hazards" / "environment.js").read_text(encoding="utf-8")


def test_air_quality_and_uv_use_shared_b5_consumer():
    assert 'resolveCurrentRun("air_quality_3h")' in ENV
    assert 'resolveCurrentRun("uv_3h")' in ENV
    assert "MeteoRiskPublicData.artifactPath" in ENV
    assert '"air_quality_3h.csv"' in ENV
    assert '"uv_3h.csv"' in ENV


def test_environment_has_no_flat_public_data_bypass():
    assert "data/air_quality/" not in ENV
    assert "data/uv/" not in ENV
    assert "AIR_QUALITY_FILE" not in ENV
    assert "UV_FILE" not in ENV


def test_environment_run_resolution_is_cached_per_product():
    assert "airQualityRunPromise" in ENV
    assert "uvRunPromise" in ENV
    assert "loadEnvironmentCsv" in ENV
