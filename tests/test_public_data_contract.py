from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "js" / "public_data.js"


def _source():
    return HELPER.read_text(encoding="utf-8")


def test_shared_b5_consumer_exists_and_loads_before_hazards():
    assert HELPER.is_file()
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    config = index.index("js/config.js")
    helper = index.index("js/public_data.js")
    hazards = [index.index("js/hazards/temperature.js"), index.index("js/hazards/fire.js"), index.index("js/hazards/environment.js"), index.index("js/hazards/wind.js")]
    assert config < helper < min(hazards)


def test_helper_uses_generated_product_registry_and_country_data_root():
    source = _source()
    assert "METEORISK_PUBLIC_PRODUCT_REGISTRY" in source
    assert "window.MeteoRiskConfig" in source
    assert "config.dataPath" in source
    assert "config.countryCode" in source
    assert "public_namespace" in source
    assert "public_state" in source
    assert "PUBLISHED" in source


def test_pointer_validation_is_fail_closed():
    source = _source()
    assert "pointer_schema" in source
    assert "pointer.schema" in source
    assert "pointer.product_id" in source
    assert "pointer.country_code" in source
    assert "pointer.current_run" in source
    assert "pointer.run_path" in source
    assert "runs/" in source
    assert "current.json" in source


def test_paths_reject_unsafe_segments_and_flat_bypass():
    source = _source()
    assert ".." in source
    assert "\\" in source
    assert "artifactPath" in source
    assert "resolveCurrentRun" in source
    assert 'cache: "no-store"' in source
