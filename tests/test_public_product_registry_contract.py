from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT.parent
GENERATOR = ROOT / "tools" / "sync_public_product_registry.py"
OUTPUT = ROOT / "js" / "public_product_registry.js"


def _generated_payload():
    text = OUTPUT.read_text(encoding="utf-8")
    prefix = "window.METEORISK_PUBLIC_PRODUCT_REGISTRY = Object.freeze("
    assert text.startswith("/* AUTO-GENERATED")
    start = text.index(prefix) + len(prefix)
    end = text.rindex(");")
    return json.loads(text[start:end])


def test_public_product_registry_is_generated_from_backend_contract():
    assert GENERATOR.is_file()
    result = subprocess.run([sys.executable, str(GENERATOR), "--check"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_generated_public_product_registry_matches_backend_contract():
    source = json.loads((BACKEND / "config" / "public_products.json").read_text(encoding="utf-8"))
    payload = _generated_payload()
    assert payload["schema"] == "meteorisk.frontend_public_product_registry.v1"
    assert payload["pointer_schema"] == source["pointer_schema"]
    assert payload["products"] == source["products"]


def test_public_product_registry_loads_before_frontend_config_and_hazards():
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    registry = index.index("js/public_product_registry.js")
    config = index.index("js/config.js")
    temperature = index.index("js/hazards/temperature.js")
    assert registry < config < temperature


def test_retired_and_unpublished_products_remain_explicit():
    products = _generated_payload()["products"]
    assert products["fire_fwi"] == {"public_namespace": None, "public_state": "RETIRED"}
    assert products["storm_v23"]["public_state"] == "UNPUBLISHED"
    assert products["storm_v23_hail"]["public_state"] == "UNPUBLISHED"
