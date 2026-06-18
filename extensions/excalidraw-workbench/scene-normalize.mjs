const numericElementFields = [
    "x",
    "y",
    "width",
    "height",
    "angle",
    "strokeWidth",
    "roughness",
    "opacity",
    "seed",
    "version",
    "versionNonce",
    "updated",
    "fontSize",
    "fontFamily",
    "baseline",
    "lineHeight",
];

const volatileElementFields = new Set(["baseline", "updated", "version", "versionNonce"]);

export function normalizeImportedScene(scene) {
    return {
        ...(scene ?? {}),
        elements: Array.isArray(scene?.elements)
            ? scene.elements.map(normalizeImportedElement)
            : [],
    };
}

export function sceneRevision(scene) {
    return JSON.stringify(sortJsonValue({
        type: scene?.type ?? "excalidraw",
        version: scene?.version ?? 2,
        source: scene?.source ?? "https://github.com/cirvine-msft/copilot-toolkit",
        elements: Array.isArray(scene?.elements) ? scene.elements.map(comparableElement) : [],
        appState: comparableAppState(scene?.appState ?? {}),
        files: scene?.files ?? {},
    }));
}

export function normalizeImportedElement(element, index = 0) {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
        throw new Error(`Invalid Excalidraw element at index ${index}: expected an object.`);
    }

    const descriptor = elementDescriptor(element, index);
    const normalized = { ...element };

    for (const field of numericElementFields) {
        if (normalized[field] !== undefined && normalized[field] !== null) {
            normalized[field] = coerceFiniteNumber(normalized[field], descriptor, field);
        }
    }

    if (normalized.points !== undefined) {
        normalized.points = normalizePoints(normalized.points, descriptor, "points");
    }

    if (normalized.lastCommittedPoint !== undefined && normalized.lastCommittedPoint !== null) {
        normalized.lastCommittedPoint = normalizePoint(normalized.lastCommittedPoint, descriptor, "lastCommittedPoint");
    }

    for (const field of ["startBinding", "endBinding"]) {
        if (normalized[field] !== undefined && normalized[field] !== null) {
            normalized[field] = normalizeBinding(normalized[field], descriptor, field);
        }
    }

    return normalized;
}

function comparableElement(element) {
    const comparable = {};
    for (const key of Object.keys(element).sort()) {
        if (volatileElementFields.has(key)) {
            continue;
        }

        if (key === "boundElements" && (!element.boundElements || element.boundElements.length === 0)) {
            continue;
        }

        comparable[key] = sortJsonValue(element[key]);
    }

    return comparable;
}

function comparableAppState(appState) {
    return {
        viewBackgroundColor: appState?.viewBackgroundColor ?? "#ffffff",
    };
}

function sortJsonValue(value) {
    if (value instanceof Map) {
        return {};
    }

    if (Array.isArray(value)) {
        return value.map(sortJsonValue);
    }

    if (value && typeof value === "object") {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortJsonValue(value[key]);
        }
        return sorted;
    }

    return value;
}

function elementDescriptor(element, index) {
    return element.id ? `${element.id}` : `at index ${index}`;
}

function coerceFiniteNumber(value, element, field) {
    if (typeof value !== "number" && typeof value !== "string") {
        throw new Error(`Invalid numeric value in element ${element} at ${field}: expected a finite number.`);
    }

    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") {
        throw new Error(`Invalid numeric value in element ${element} at ${field}: expected a finite number.`);
    }

    const number = Number(text);
    if (!Number.isFinite(number)) {
        throw new Error(`Invalid numeric value in element ${element} at ${field}: expected a finite number.`);
    }

    return number;
}

function normalizePoints(points, element, field) {
    if (!Array.isArray(points)) {
        throw new Error(`Invalid point list in element ${element} at ${field}: expected an array.`);
    }

    return points.map((point, index) => normalizePoint(point, element, `${field}[${index}]`));
}

function normalizePoint(point, element, field) {
    if (!Array.isArray(point) || point.length < 2) {
        throw new Error(`Invalid point in element ${element} at ${field}: expected [x, y].`);
    }

    return [
        coerceFiniteNumber(point[0], element, `${field}[0]`),
        coerceFiniteNumber(point[1], element, `${field}[1]`),
    ];
}

function normalizeBinding(binding, element, field) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error(`Invalid binding in element ${element} at ${field}: expected an object.`);
    }

    const normalized = { ...binding };
    for (const numericField of ["focus", "gap"]) {
        if (normalized[numericField] !== undefined && normalized[numericField] !== null) {
            normalized[numericField] = coerceFiniteNumber(normalized[numericField], element, `${field}.${numericField}`);
        }
    }

    if (normalized.fixedPoint !== undefined && normalized.fixedPoint !== null) {
        normalized.fixedPoint = normalizePoint(normalized.fixedPoint, element, `${field}.fixedPoint`);
    }

    return normalized;
}
