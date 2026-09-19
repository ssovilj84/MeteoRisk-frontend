from pathlib import Path
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]
BACKEND_CONFIG = ROOT.parent / "config" / "public_products.json"
OUTPUT = ROOT / "js" / "public_product_registry.js"


def build_text():
    source = json.loads(BACKEND_CONFIG.read_text(encoding="utf-8"))
    if source.get("schema_version") != "1.0":
        raise ValueError("Unsupported backend public product registry schema_version")
    payload = {
        "schema": "meteorisk.frontend_public_product_registry.v1",
        "pointer_schema": source["pointer_schema"],
        "products": source["products"],
    }
    return "/* AUTO-GENERATED from ../config/public_products.json. Do not edit by hand. */\nwindow.METEORISK_PUBLIC_PRODUCT_REGISTRY = Object.freeze(" + json.dumps(payload, ensure_ascii=False, indent=2) + ");\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = build_text()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != expected:
            raise SystemExit("Frontend public product registry is missing or stale")
        print("PUBLIC PRODUCT REGISTRY CHECK: PASS")
        return
    OUTPUT.write_text(expected, encoding="utf-8", newline="\n")
    print("PUBLIC PRODUCT REGISTRY SYNC: PASS")


if __name__ == "__main__":
    main()
