/* MeteoRisk shared B5 public-data consumer. */
(function () {
    "use strict";

    const registry = window.METEORISK_PUBLIC_PRODUCT_REGISTRY;
    const config = window.MeteoRiskConfig;
    if (!registry || !registry.products || !registry.pointer_schema) {
        throw new Error("MeteoRisk public product registry is unavailable");
    }
    if (!config || typeof config.dataPath !== "function" || !config.countryCode) {
        throw new Error("MeteoRisk country configuration is unavailable");
    }

    function assertSafeRelativePath(value, label) {
        const path = String(value || "");
        if (!path || path.startsWith("/") || path.includes("\\") || path.includes("//")) {
            throw new Error("Unsafe " + label);
        }
        const segments = path.split("/");
        if (segments.some((segment) => segment === "." || segment === ".." || !segment)) {
            throw new Error("Unsafe " + label);
        }
        return path;
    }

    function publishedProduct(productId) {
        const product = registry.products[productId];
        if (!product) throw new Error("Unknown public product: " + productId);
        if (product.public_state !== "PUBLISHED") {
            throw new Error("Product is not published: " + productId + " (" + product.public_state + ")");
        }
        assertSafeRelativePath(product.public_namespace, "public namespace");
        return product;
    }

    function validatePointer(pointer, productId) {
        if (!pointer || typeof pointer !== "object") throw new Error("Invalid public run pointer");
        if (pointer.schema !== registry.pointer_schema) throw new Error("Invalid pointer schema");
        if (pointer.product_id !== productId) throw new Error("Pointer product mismatch");
        if (pointer.country_code !== config.countryCode) throw new Error("Pointer country mismatch");

        const currentRun = assertSafeRelativePath(pointer.current_run, "current_run");
        if (currentRun.includes("/")) throw new Error("Invalid current_run");

        const runPath = assertSafeRelativePath(pointer.run_path, "run_path");
        if (runPath !== "runs/" + currentRun) throw new Error("Non-canonical run_path");
        return pointer;
    }

    async function resolveCurrentRun(productId) {
        const product = publishedProduct(productId);
        const productRoot = config.dataPath(product.public_namespace);
        const response = await fetch(productRoot + "/current.json", { cache: "no-store" });
        if (!response.ok) {
            throw new Error("Unable to load current pointer for " + productId + ": HTTP " + response.status);
        }
        const pointer = validatePointer(await response.json(), productId);
        return Object.freeze({
            productId,
            product,
            productRoot,
            pointer: Object.freeze(pointer),
            runRoot: productRoot + "/" + pointer.run_path
        });
    }

    function artifactPath(resolvedRun, artifactName) {
        if (!resolvedRun || !resolvedRun.runRoot) throw new Error("Resolved run is required");
        const artifact = assertSafeRelativePath(artifactName, "artifact path");
        return resolvedRun.runRoot + "/" + artifact;
    }

    window.MeteoRiskPublicData = Object.freeze({
        resolveCurrentRun,
        artifactPath
    });
})();
