from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "js" / "app.js").read_text(encoding="utf-8")


def test_storm_v2_uses_shared_b5_consumer():
    assert 'resolveCurrentRun("storm_v2")' in APP
    assert "MeteoRiskPublicData.artifactPath" in APP


def test_storm_v2_has_no_flat_or_legacy_bypass():
    assert 'data/storm/manifest.json' not in APP
    assert '"data/storm/" + term.file' not in APP
    assert "MULTIMODEL_STORMS_FILES" not in APP
    assert "loadMultimodelStormsRows" not in APP
    assert "applyLegacyMultimodelStormsOverlay" not in APP
    assert "legacy multimodel CSV remains fallback only" not in APP


def test_storm_v2_uses_country_admin_contract():
    assert "window.MeteoRiskConfig.country.expected_admin_units" in APP
    assert "municipality_count) !== 194" not in APP
    assert "matched === 194" not in APP


def test_storm_v2_validates_run_identity():
    assert "manifest.run_id" in APP
    assert "resolvedRun.pointer.current_run" in APP
    assert "payload.run_id" in APP
    assert "const expectedTermFile" in APP
    assert "String(term.file) !== expectedTermFile" in APP


def test_legacy_multimodel_artifacts_are_removed():
    legacy = list((ROOT / "data" / "multimodel").glob("storms_f*"))
    assert legacy == []
