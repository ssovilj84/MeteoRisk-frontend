from pathlib import Path
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]
BACKEND_CONFIG = ROOT.parent / "config" / "countries.json"
OUTPUT = ROOT / "js" / "country_registry.js"

def build_text():
    source = json.loads(BACKEND_CONFIG.read_text(encoding="utf-8"))
    countries = {}
    for code, item in source["countries"].items():
        public_file = item["public_admin_file"].replace("\\", "/")
        if not public_file.startswith("web/"):
            raise ValueError(f"Unexpected public_admin_file for {code}: {public_file}")
        public_file = public_file[4:]
        marker = "/static/"
        data_root = public_file.split(marker, 1)[0] if marker in public_file else str(Path(public_file).parent).replace("\\", "/")
        countries[code] = {
            "code": code,
            "iso3": item["iso3"],
            "name_en": item["name_en"],
            "name_local": item["name_local"],
            "timezone": item["timezone"],
            "expected_admin_units": item["expected_admin_units"],
            "id_column": item["id_column"],
            "name_columns": item["name_columns"],
            "geometry_bounds": item["geometry_bounds"],
            "forecast_bbox": item["forecast_bbox"],
            "admin_unit_label": item["admin_unit_label"],
            "public_admin_file": public_file,
            "data_root": data_root,
        }
    payload = {
        "schema": "meteorisk.frontend_country_registry.v1",
        "default_country": source["default_country"],
        "countries": countries,
    }
    return "/* AUTO-GENERATED from ../config/countries.json. Do not edit by hand. */\nwindow.METEORISK_COUNTRY_REGISTRY = Object.freeze(" + json.dumps(payload, ensure_ascii=False, indent=2) + ");\n"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = build_text()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != expected:
            raise SystemExit("Frontend country registry is missing or stale")
        print("COUNTRY REGISTRY CHECK: PASS")
        return
    OUTPUT.write_text(expected, encoding="utf-8", newline="\n")
    print(f"COUNTRY REGISTRY SYNC: PASS | {OUTPUT}")

if __name__ == "__main__":
    main()
