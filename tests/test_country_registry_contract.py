from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def test_frontend_country_registry_is_generated_from_backend_config():
    generator = ROOT / "tools" / "sync_country_registry.py"
    assert generator.is_file(), "Missing country-registry generator"
    result = subprocess.run([sys.executable, str(generator), "--check"], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_country_registry_loads_before_hazard_modules():
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    registry = index.index("js/country_registry.js")
    config = index.index("js/config.js")
    first_hazard = index.index("js/hazards/temperature.js")
    assert registry < config < first_hazard
