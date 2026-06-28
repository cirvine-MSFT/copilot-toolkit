import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, exportToBlob, exportToSvg, restore } from "@excalidraw/excalidraw";
import {
  activeComments,
  commentAnchorFromSelection,
  normalizeImportedScene,
  nextStatus,
  scenePayload,
  sceneFingerprint,
  scenePointToViewport,
  shouldPersistSceneChange,
} from "./state.js";
import "./styles.css";

const config = window.EXCALIDRAW_WORKBENCH_CONFIG ?? {};
window.EXCALIDRAW_ASSET_PATH = config.assetPath ?? "/assets/";

export async function api(path, options) {
  const headers = new Headers(options?.headers ?? {});
  headers.set("X-Excalidraw-Workbench-Token", config.apiToken);
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || text || response.statusText);
  }
  return payload;
}

export function App() {
  const [scene, setScene] = useState(null);
  const [comments, setComments] = useState([]);
  const [status, setStatus] = useState(nextStatus("Loading drawing..."));
  const [loadError, setLoadError] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [activeTab, setActiveTab] = useState("comments");
  const [selectedCommentId, setSelectedCommentId] = useState("");
  const [draftComment, setDraftComment] = useState(null);
  const [expandedCommentIds, setExpandedCommentIds] = useState(() => new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [markerAppState, setMarkerAppState] = useState(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const saveTimer = useRef(null);
  const sceneSaveQueue = useRef(Promise.resolve());
  const queuedSceneSaves = useRef(0);
  const lastSceneJson = useRef("");
  const lastSceneFingerprint = useRef("");
  const hasDrawingInteraction = useRef(false);
  const inFlightSceneSaves = useRef(0);
  const sourceDirty = useRef(false);
  const canvasSaveConflict = useRef(false);
  const sourceBaseRevision = useRef("");
  const clientId = useRef(`webview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const visibleComments = useMemo(() => activeComments(comments), [comments]);

  const loadScene = useCallback(async (options = {}) => {
    const resetInteraction = options.resetInteraction !== false;
    const payload = await api("/api/scene");
    const restored = restore(normalizeImportedScene(payload.scene), null, null, { repairBindings: true });
    const normalized = scenePayload(restored, {}, { forExcalidraw: true });
    const persisted = scenePayload(restored);
    setScene(normalized);
    setMarkerAppState(normalized.appState);
    setComments(payload.comments ?? []);
    setSourceText(JSON.stringify(persisted, null, 2));
    sourceDirty.current = false;
    canvasSaveConflict.current = false;
    const revision = payload.revision ?? sceneFingerprint(persisted);
    lastSceneJson.current = JSON.stringify(persisted);
    lastSceneFingerprint.current = revision;
    sourceBaseRevision.current = revision;
    if (resetInteraction) {
      hasDrawingInteraction.current = false;
    }
    setLoadError("");
    excalidrawAPI?.updateScene({
      elements: normalized.elements,
      appState: normalized.appState,
      files: normalized.files,
    });
    setStatus(nextStatus("Loaded"));
  }, [excalidrawAPI]);

  useEffect(() => {
    loadScene().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      setStatus(nextStatus(message));
    });
  }, [loadScene]);

  const saveScene = useCallback(async (nextScene) => {
    const normalized = scenePayload(nextScene);
    const json = JSON.stringify(normalized);
    if (!sourceDirty.current) {
      setSourceText(JSON.stringify(normalized, null, 2));
    }

    if (json === lastSceneJson.current || !shouldPersistSceneChange({
      hasUserInteracted: hasDrawingInteraction.current,
      lastSceneFingerprint: lastSceneFingerprint.current,
      scene: normalized,
    })) {
      return;
    }

    inFlightSceneSaves.current += 1;
    let response;
    try {
      response = await api("/api/scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene: normalized,
          clientId: clientId.current,
          baseRevision: lastSceneFingerprint.current,
        }),
      });
    } finally {
      inFlightSceneSaves.current -= 1;
    }
    lastSceneJson.current = json;
    const revision = response.revision ?? sceneFingerprint(normalized);
    lastSceneFingerprint.current = revision;
    canvasSaveConflict.current = false;
    if (!sourceDirty.current) {
      sourceBaseRevision.current = revision;
    }
    setStatus(nextStatus("Saved"));
  }, []);

  const queueSceneSave = useCallback((nextScene) => {
    queuedSceneSaves.current += 1;
    const run = async () => {
      try {
        await saveScene(nextScene);
      } catch (error) {
        canvasSaveConflict.current = true;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(nextStatus(message));
      } finally {
        queuedSceneSaves.current -= 1;
      }
    };
    const queued = sceneSaveQueue.current.catch(() => {}).then(run);
    sceneSaveQueue.current = queued.catch(() => {});
  }, [saveScene]);

  const onSceneChange = useCallback((elements, appState, files) => {
    const nextScene = scenePayload({ ...scene, elements, appState, files }, {}, { forExcalidraw: true });
    setMarkerAppState(nextScene.appState);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      queueSceneSave(nextScene);
    }, 750);
  }, [queueSceneSave, scene]);

  useEffect(() => {
    const markDrawingInteraction = (event) => {
      if (event.target instanceof Element && event.target.closest(".canvas")) {
        hasDrawingInteraction.current = true;
      }
    };

    window.addEventListener("pointerdown", markDrawingInteraction, true);
    window.addEventListener("keydown", markDrawingInteraction, true);
    window.addEventListener("drop", markDrawingInteraction, true);
    window.addEventListener("paste", markDrawingInteraction, true);
    return () => {
      window.removeEventListener("pointerdown", markDrawingInteraction, true);
      window.removeEventListener("keydown", markDrawingInteraction, true);
      window.removeEventListener("drop", markDrawingInteraction, true);
      window.removeEventListener("paste", markDrawingInteraction, true);
    };
  }, []);

  const refreshComments = useCallback(async () => {
    const payload = await api("/api/comments");
    setComments(payload.comments ?? []);
  }, []);

  const beginComment = useCallback(() => {
    if (!excalidrawAPI) {
      setStatus(nextStatus("Excalidraw is not ready yet."));
      return;
    }

    const anchor = commentAnchorFromSelection(excalidrawAPI.getSceneElements(), excalidrawAPI.getAppState());
    if (!anchor.elementId) {
      setStatus(nextStatus("Select an element before adding an anchored comment."));
      return;
    }

    setActiveTab("comments");
    setSidebarCollapsed(false);
    setSelectedCommentId("__draft");
    setDraftComment({ anchor, body: "", notifyAgent: true });
  }, [excalidrawAPI]);

  const cancelDraftComment = useCallback(() => {
    setDraftComment(null);
    setSelectedCommentId("");
  }, []);

  const submitDraftComment = useCallback(async () => {
    const body = draftComment?.body.trim() ?? "";
    if (!draftComment || !body) {
      return;
    }

    const response = await api("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draftComment.anchor, body, notifyAgent: draftComment.notifyAgent }),
    });
    setDraftComment(null);
    await refreshComments();
    setSelectedCommentId(response.comment.id);
    setExpandedCommentIds((current) => new Set([...current, response.comment.id]));
    setStatus(nextStatus("Comment added"));
  }, [draftComment, refreshComments]);

  const addReply = useCallback(async (commentId, body) => {
    const text = body.trim();
    if (!text) {
      return;
    }

    await api(`/api/comments/${encodeURIComponent(commentId)}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text, author: "user" }),
    });
    await refreshComments();
    setExpandedCommentIds((current) => new Set([...current, commentId]));
  }, [refreshComments]);

  const resolveComment = useCallback(async (commentId) => {
    await api(`/api/comments/${encodeURIComponent(commentId)}/resolve`, { method: "POST" });
    await refreshComments();
  }, [refreshComments]);

  const saveSource = useCallback(async () => {
    try {
      const parsed = JSON.parse(sourceText);
      inFlightSceneSaves.current += 1;
      try {
        await api("/api/scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scene: parsed,
            clientId: clientId.current,
            baseRevision: sourceBaseRevision.current || lastSceneFingerprint.current,
          }),
        });
      } finally {
        inFlightSceneSaves.current -= 1;
      }
      sourceDirty.current = false;
      await loadScene();
      setStatus(nextStatus("Source saved"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(nextStatus(message));
    }
  }, [loadScene, sourceText]);

  const exportSnapshot = useCallback(async (format) => {
    if (!excalidrawAPI) {
      throw new Error("Excalidraw is not ready.");
    }

    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();

    if (format === "png") {
      const blob = await exportToBlob({
        elements,
        appState: scenePayload({ appState }).appState,
        files,
        mimeType: "image/png",
      });
      return {
        format: "png",
        dataUrl: await blobToDataUrl(blob),
      };
    }

    const svg = await exportToSvg({ elements, appState: scenePayload({ appState }).appState, files });
    return {
      format: "svg",
      svg: new XMLSerializer().serializeToString(svg),
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    const events = new EventSource(`/events?token=${encodeURIComponent(config.apiToken)}`);
    events.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "comments-updated") {
        await refreshComments();
        return;
      }

      if (payload.type === "refresh-scene") {
        if (payload.reason === "scene-saved" && payload.clientId === clientId.current) {
          return;
        }

        const hasLocalSceneWork = saveTimer.current !== null
          || queuedSceneSaves.current > 0
          || inFlightSceneSaves.current > 0
          || canvasSaveConflict.current
          || sourceDirty.current;
        if (hasLocalSceneWork) {
          setStatus(nextStatus("Remote changes detected; finish saving local changes before refresh."));
          return;
        }

        await loadScene().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setLoadError(message);
          setStatus(nextStatus(message));
        });
        return;
      }

      if (payload.type !== "snapshot-request") {
        return;
      }

      try {
        const snapshot = await exportSnapshot(payload.format);
        await api(`/api/snapshots/${encodeURIComponent(payload.requestId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        });
      } catch (error) {
        await api(`/api/snapshots/${encodeURIComponent(payload.requestId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        }).catch(() => {});
      }
    };
    return () => events.close();
  }, [exportSnapshot, loadScene, refreshComments]);

  if (!scene) {
    return <LoadState error={loadError} message={loadError || status.message} />;
  }

  return (
    <div className="workbench">
      <header className="topbar">
        <div>
          <h1>{config.title ?? "Excalidraw Workbench"}</h1>
          <code>{config.displayPath}</code>
        </div>
        <span className="spacer" />
        <span className="status">{status.message}</span>
        <button type="button" onClick={() => loadScene().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setLoadError(message);
          setStatus(nextStatus(message));
        })}>Refresh</button>
      </header>
      <main className={`content ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <section className="canvas">
          <Excalidraw
            excalidrawAPI={setExcalidrawAPI}
            initialData={scene}
            onChange={onSceneChange}
            theme={document.documentElement.dataset.colorMode === "dark" ? "dark" : "light"}
          />
          <CommentMarkers
            comments={visibleComments}
            draftComment={draftComment}
            appState={markerAppState}
            selectedCommentId={selectedCommentId}
            onSelect={(commentId) => {
              setSelectedCommentId(commentId);
              setActiveTab("comments");
              setSidebarCollapsed(false);
              setExpandedCommentIds((current) => new Set([...current, commentId]));
            }}
          />
        </section>
        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <div className="sidebar-header">
            {sidebarCollapsed ? (
              <button className="sidebar-rail-button" type="button" onClick={() => setSidebarCollapsed(false)} title="Show comments pane">Comments</button>
            ) : (
              <>
                <div className="tabs">
                  <button className={activeTab === "comments" ? "active" : ""} type="button" onClick={() => setActiveTab("comments")}>Comments</button>
                  <button className={activeTab === "source" ? "active" : ""} type="button" onClick={() => setActiveTab("source")}>Source</button>
                </div>
                <button className="icon-button" type="button" onClick={() => setSidebarCollapsed(true)} title="Collapse comments pane" aria-label="Collapse comments pane">›</button>
              </>
            )}
          </div>
          {!sidebarCollapsed && activeTab === "comments" ? (
            <CommentsPanel
              comments={visibleComments}
              draftComment={draftComment}
              selectedCommentId={selectedCommentId}
              setSelectedCommentId={setSelectedCommentId}
              expandedCommentIds={expandedCommentIds}
              setExpandedCommentIds={setExpandedCommentIds}
              beginComment={beginComment}
              setDraftComment={setDraftComment}
              submitDraftComment={submitDraftComment}
              cancelDraftComment={cancelDraftComment}
              addReply={addReply}
              resolveComment={resolveComment}
            />
          ) : null}
          {!sidebarCollapsed && activeTab === "source" ? (
            <SourcePanel
              sourceText={sourceText}
              setSourceText={(value) => {
                if (!sourceDirty.current) {
                  sourceBaseRevision.current = lastSceneFingerprint.current;
                }
                sourceDirty.current = true;
                setSourceText(value);
              }}
              saveSource={saveSource}
            />
          ) : null}
        </aside>
      </main>
    </div>
  );
}

export function LoadState({ error, message }) {
  const failed = Boolean(error);
  return (
    <div className={`loading ${failed ? "error" : ""}`} role={failed ? "alert" : "status"}>
      <strong>{failed ? "Could not load Excalidraw drawing." : "Loading Excalidraw Workbench..."}</strong>
      {message ? <p>{message}</p> : null}
    </div>
  );
}

function CommentMarkers({ comments, draftComment, appState, selectedCommentId, onSelect }) {
  if (!appState || (comments.length === 0 && !draftComment)) {
    return null;
  }

  const markerComments = draftComment
    ? [...comments, { ...draftComment.anchor, id: "__draft", body: draftComment.body || "Draft comment", draft: true }]
    : comments;

  return (
    <div className="comment-marker-layer" aria-hidden="false">
      {markerComments.map((comment, index) => {
        const point = scenePointToViewport(comment, appState);
        return (
          <button
            key={comment.id}
            type="button"
            className={`comment-marker ${selectedCommentId === comment.id ? "selected" : ""} ${comment.draft ? "draft" : ""}`}
            style={{ left: `${point.x}px`, top: `${point.y}px` }}
            title={comment.body}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(comment.id);
            }}
          >
            {index + 1}
          </button>
        );
      })}
    </div>
  );
}

function CommentsPanel({
  comments,
  draftComment,
  selectedCommentId,
  setSelectedCommentId,
  expandedCommentIds,
  setExpandedCommentIds,
  beginComment,
  setDraftComment,
  submitDraftComment,
  cancelDraftComment,
  addReply,
  resolveComment,
}) {
  return (
    <div className="panel">
      <div className="panel-toolbar">
        <p className="hint">Numbered markers show unresolved comment locations. Click a marker to highlight its comment here.</p>
        <button className="primary" type="button" onClick={beginComment}>Add comment</button>
      </div>
      {draftComment ? (
        <DraftComment
          index={comments.length}
          draftComment={draftComment}
          setDraftComment={setDraftComment}
          submitDraftComment={submitDraftComment}
          cancelDraftComment={cancelDraftComment}
        />
      ) : null}
      <div className="comment-list">
        {comments.length === 0 ? <p className="hint">No active comments.</p> : comments.map((comment, index) => (
          <Comment
            key={comment.id}
            comment={comment}
            index={index}
            selected={selectedCommentId === comment.id}
            expanded={expandedCommentIds.has(comment.id)}
            select={() => {
              setSelectedCommentId(comment.id);
              setExpandedCommentIds((current) => new Set([...current, comment.id]));
            }}
            toggleExpanded={() => {
              setExpandedCommentIds((current) => {
                const next = new Set(current);
                if (next.has(comment.id)) {
                  next.delete(comment.id);
                } else {
                  next.add(comment.id);
                }
                return next;
              });
            }}
            addReply={addReply}
            resolveComment={resolveComment}
          />
        ))}
      </div>
    </div>
  );
}

function DraftComment({ index, draftComment, setDraftComment, submitDraftComment, cancelDraftComment }) {
  return (
    <article className="comment selected draft-card">
      <strong>#{index + 1} Draft</strong>
      <div className="hint">Anchored to {draftComment.anchor.elementLabel || draftComment.anchor.elementType} · x={Math.round(draftComment.anchor.x)}, y={Math.round(draftComment.anchor.y)}</div>
      <textarea
        autoFocus
        value={draftComment.body}
        onChange={(event) => setDraftComment((current) => ({ ...current, body: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitDraftComment();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancelDraftComment();
          }
        }}
        placeholder="Leave a comment for the agent..."
      />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={draftComment.notifyAgent}
          onChange={(event) => setDraftComment((current) => ({ ...current, notifyAgent: event.target.checked }))}
        />
        Send this comment to the agent
      </label>
      <div className="row">
        <button className="primary" type="button" onClick={submitDraftComment}>Add comment</button>
        <button type="button" onClick={cancelDraftComment}>Cancel</button>
      </div>
      <div className="hint">Press Enter to submit, Shift+Enter for a new line, Esc to cancel.</div>
    </article>
  );
}

function Comment({ comment, index, selected, expanded, select, toggleExpanded, addReply, resolveComment }) {
  const [replyBody, setReplyBody] = useState("");
  const submitReply = () => {
    addReply(comment.id, replyBody);
    setReplyBody("");
  };

  return (
    <article className={`comment ${selected ? "selected" : ""}`} onClick={select}>
      <div className="comment-header">
        <strong>#{index + 1}</strong>
        <button
          className="subtle-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleExpanded();
          }}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <p>{comment.body}</p>
      <div className="hint">Source: x={Math.round(comment.x)}, y={Math.round(comment.y)}{comment.elementLabel ? ` · ${comment.elementLabel}` : ""}</div>
      {!expanded && comment.replies?.length ? <div className="hint">{comment.replies.length} repl{comment.replies.length === 1 ? "y" : "ies"}</div> : null}
      {expanded ? (
        <>
          {comment.replies?.map((reply) => (
            <blockquote key={reply.id}><strong>{reply.author}</strong>: {reply.body}</blockquote>
          ))}
          <textarea
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submitReply();
              }
            }}
            placeholder="Reply..."
          />
          <div className="row">
            <button type="button" onClick={submitReply}>Reply</button>
            <button type="button" onClick={() => resolveComment(comment.id)}>Resolve</button>
          </div>
        </>
      ) : null}
    </article>
  );
}

function SourcePanel({ sourceText, setSourceText, saveSource }) {
  return (
    <div className="panel source-panel">
      <p className="hint">Saving replaces the checked-out Excalidraw scene JSON.</p>
      <textarea spellCheck="false" value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
      <button className="primary" type="button" onClick={saveSource}>Save source</button>
    </div>
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (typeof console !== "undefined" && console.error) {
      console.error("Excalidraw Workbench render error:", error, info);
    }
  }

  handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    if (this.state.error) {
      const message = this.state.error instanceof Error
        ? this.state.error.message
        : String(this.state.error);
      return (
        <div className="loading error" role="alert">
          <strong>Excalidraw Workbench failed to render.</strong>
          {message ? <p>{message}</p> : null}
          <p>
            <button type="button" onClick={this.handleReload}>Reload</button>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

if (!import.meta.env?.TEST) {
  createRoot(document.getElementById("root")).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
