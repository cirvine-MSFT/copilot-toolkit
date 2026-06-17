export function scenePayload(scene, files = {}, options = {}) {
  const appState = normalizeAppState(scene?.appState, options);
  return {
    type: scene?.type ?? "excalidraw",
    version: scene?.version ?? 2,
    source: scene?.source ?? "https://github.com/cirvine-msft/copilot-toolkit",
    elements: Array.isArray(scene?.elements) ? scene.elements : [],
    appState,
    files: scene?.files ?? files ?? {},
  };
}

export function normalizeAppState(appState, options = {}) {
  const normalized = { ...(appState ?? {}) };
  if (options.forExcalidraw) {
    normalized.collaborators = normalized.collaborators instanceof Map
      ? normalized.collaborators
      : new Map();
  } else {
    delete normalized.collaborators;
  }

  return normalized;
}

export function activeComments(comments) {
  return Array.isArray(comments) ? comments.filter((comment) => !comment.resolved) : [];
}

export function commentAnchorFromSelection(elements, appState) {
  const selectedIds = appState?.selectedElementIds ?? {};
  const selectedId = Object.keys(selectedIds).find((id) => selectedIds[id]);
  const selected = Array.isArray(elements) ? elements.find((element) => element.id === selectedId) : null;
  if (!selected) {
    return { x: 0, y: 0, elementId: "", elementType: "", elementLabel: "" };
  }

  return {
    x: Number(selected.x || 0) + Number(selected.width || 0) / 2,
    y: Number(selected.y || 0) + Number(selected.height || 0) / 2,
    elementId: selected.id,
    elementType: selected.type,
    elementLabel: selected.type === "text" && selected.text ? selected.text : `${selected.type} ${String(selected.id).slice(0, 8)}`,
  };
}

export function zoomValue(appState) {
  const raw = appState?.zoom?.value ?? appState?.zoom ?? 1;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function scenePointToViewport(point, appState) {
  const zoom = zoomValue(appState);
  return {
    x: (point.x + Number(appState?.scrollX ?? 0)) * zoom,
    y: (point.y + Number(appState?.scrollY ?? 0)) * zoom,
  };
}

export function viewportPointToScene(point, appState) {
  const zoom = zoomValue(appState);
  return {
    x: point.x / zoom - Number(appState?.scrollX ?? 0),
    y: point.y / zoom - Number(appState?.scrollY ?? 0),
  };
}

export function elementAtScenePoint(elements, point) {
  const visibleElements = Array.isArray(elements)
    ? elements.filter((element) => !element.isDeleted)
    : [];

  for (const element of visibleElements.slice().reverse()) {
    const bounds = elementBounds(element);
    if (
      point.x >= bounds.x
      && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y
      && point.y <= bounds.y + bounds.height
    ) {
      return element;
    }
  }

  return null;
}

export function elementBounds(element) {
  const points = Array.isArray(element?.points) ? element.points : null;
  if (points && points.length > 0) {
    const xs = points.map((point) => Number(point[0]) || 0);
    const ys = points.map((point) => Number(point[1]) || 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return {
      x: Number(element.x) + minX,
      y: Number(element.y) + minY,
      width: Math.max(8, maxX - minX),
      height: Math.max(8, maxY - minY),
    };
  }

  return {
    x: Number(element?.x) || 0,
    y: Number(element?.y) || 0,
    width: Math.max(8, Number(element?.width) || 8),
    height: Math.max(8, Number(element?.height) || 8),
  };
}

export function elementLabel(element) {
  if (!element) {
    return "";
  }

  return element.type === "text" && element.text
    ? String(element.text)
    : `${element.type} ${String(element.id).slice(0, 8)}`;
}

export function nextStatus(message) {
  return {
    message,
    updatedAt: new Date().toISOString(),
  };
}
