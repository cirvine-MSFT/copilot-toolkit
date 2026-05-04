/**
 * Application entry point — orchestrates copilot bridge, tabs, and views.
 * Uses window.copilot (injected by /__bridge.js) for extension communication.
 */
import { DiffView } from './diff-view.js';
import { VizPanel } from './viz-panel.js';

// ── Transport adapter for DiffView ────────────────────────────
function showToast(message, isError = false) {
    const existing = document.querySelector('.vr-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `vr-toast ${isError ? 'vr-toast-error' : 'vr-toast-info'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

async function safeCall(fn, errorMsg) {
    try {
        return await fn();
    } catch (err) {
        console.error(errorMsg, err);
        showToast(`${errorMsg} — try reloading (↻)`, true);
        throw err;
    }
}

const transport = {
    addComment: (filePath, line, endLine, side, text) =>
        safeCall(() => copilot.addComment(filePath, line, endLine, side, text), 'Failed to submit comment'),
    addReply: (threadId, text) =>
        safeCall(() => copilot.addReply(threadId, text), 'Failed to send reply'),
    resolveThread: (threadId) =>
        safeCall(() => copilot.resolveThread(threadId), 'Failed to resolve thread'),
    submitBatch: (comments) =>
        safeCall(() => copilot.submitBatch(comments), 'Failed to submit batch'),
};

// ── Initialize views ──────────────────────────────────────────
const diffView = new DiffView(document.getElementById('diffContainer'), transport);
const vizPanel = new VizPanel(document.getElementById('vizContainer'));

// ── Expose global functions for extension push via eval() ─────
// The extension calls webview.eval('window.addAgentReply(...)') to push data.
// These are best-effort live updates — stored state is the source of truth.
window.addAgentReply = (threadId, text) => {
    diffView.addAgentReply(threadId, text);
};

window.addVisualization = (data) => {
    vizPanel.addVisualization(data);
};

window.updateComments = (threads) => {
    diffView.updateComments(threads);
};

window.updateDiff = (data) => {
    diffView.render(data);
};

// ── Connection health monitoring ──────────────────────────────
const statusEl = document.getElementById('connectionStatus');
let isConnected = false;

function setConnected() {
    isConnected = true;
    statusEl.classList.add('connected');
    statusEl.classList.remove('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Connected';
}

function setDisconnected() {
    isConnected = false;
    statusEl.classList.remove('connected');
    statusEl.classList.add('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Disconnected — click reload ↻';
}

// Periodic heartbeat — detect dropped WebSocket
setInterval(async () => {
    try {
        await copilot.getConfig();
        if (!isConnected) setConnected();
    } catch {
        if (isConnected) setDisconnected();
    }
}, 5000);

// ── Initialize: load config, diff, comments, and viz ──────────
async function init() {
    try {
        // Get initial config
        const config = await copilot.getConfig();
        
        // Apply theme
        if (config.theme) {
            document.documentElement.dataset.theme = config.theme;
            // Also update mermaid theme if loaded
            if (window.mermaid) {
                window.mermaid.initialize({ startOnLoad: false, theme: config.theme === 'dark' ? 'dark' : 'default' });
            }
        }

        // Set scope dropdown
        const scopeSelect = document.getElementById('scopeSelect');
        if (scopeSelect && config.scope) {
            scopeSelect.value = config.scope;
        }

        setConnected();

        // Load diff data
        const diffData = await copilot.getDiff();
        diffView.render(diffData);

        // Load existing comments
        const threads = await copilot.getComments();
        if (threads && threads.length > 0) {
            diffView.updateComments(threads);
        }

        // Load existing visualizations
        const vizs = await copilot.getVisualizations();
        if (vizs && vizs.length > 0) {
            for (const viz of vizs) {
                await vizPanel.addVisualization(viz);
            }
        }
    } catch (err) {
        console.error('[visual-review] init failed:', err);
        setDisconnected();
    }
}

// ── Tab switching ─────────────────────────────────────────────
const diffPanel = document.getElementById('diffPanel');
const vizPanelEl = document.getElementById('vizPanel');

document.querySelectorAll('.vr-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.vr-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const target = tab.dataset.panel;
        diffPanel.classList.toggle('hidden', target !== 'diff');
        vizPanelEl.classList.toggle('hidden', target !== 'viz');
    });
});

// ── View toggle (split ↔ unified) ────────────────────────────
const viewToggle = document.getElementById('viewToggle');
const viewToggleLabel = document.getElementById('viewToggleLabel');

viewToggle.addEventListener('click', () => {
    const current = diffView.outputFormat;
    const next = current === 'side-by-side' ? 'line-by-line' : 'side-by-side';
    diffView.setOutputFormat(next);
    viewToggleLabel.textContent = next === 'side-by-side' ? 'Split' : 'Unified';
});

// ── Scope toggle ──────────────────────────────────────────────
const scopeSelect = document.getElementById('scopeSelect');
if (scopeSelect) {
    scopeSelect.addEventListener('change', async () => {
        try {
            const data = await copilot.getDiff(scopeSelect.value);
            diffView.render(data);
        } catch (err) {
            console.error('[visual-review] scope change failed:', err);
        }
    });
}

// ── Sidebar toggle ────────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    document.querySelector('.vr-main').classList.toggle('sidebar-collapsed');
});

// ── Tree / flat view toggle ──────────────────────────────────
const treeToggle = document.getElementById('treeToggle');
const treeToggleIcon = document.getElementById('treeToggleIcon');

// Tree icon (shows hierarchy) — displayed when in flat mode (click to switch to tree)
const ICON_TREE = '<path d="M4.75 7a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5ZM5 4.75A.75.75 0 0 1 5.75 4h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 5 4.75ZM6.75 10a.75.75 0 0 0 0 1.5h2.5a.75.75 0 0 0 0-1.5h-2.5Z"/><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25Z"/>';
// List icon (flat lines) — displayed when in tree mode (click to switch to flat)
const ICON_LIST = '<path d="M2 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.75-1.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5Zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5h-8.5ZM2 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm0 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>';

function updateTreeToggleIcon(isTree) {
    treeToggleIcon.innerHTML = isTree ? ICON_LIST : ICON_TREE;
    treeToggle.title = isTree ? 'Switch to flat list' : 'Switch to tree view';
}

if (treeToggle) {
    updateTreeToggleIcon(diffView.treeMode);
    treeToggle.addEventListener('click', () => {
        const isTree = diffView.toggleTreeMode();
        updateTreeToggleIcon(isTree);
    });
}

// ── Submit all pending comments ───────────────────────────────
const submitAllBtn = document.getElementById('submitAllBtn');
const pendingBadge = document.getElementById('pendingBadge');

const observer = new MutationObserver(() => {
    submitAllBtn.classList.toggle('hidden', !pendingBadge.classList.contains('has-pending'));
});
observer.observe(pendingBadge, { attributes: true, attributeFilter: ['class'] });

submitAllBtn.addEventListener('click', () => {
    diffView.submitPendingComments();
});

// ── Start initialization ──────────────────────────────────────
init();

// ── Reload button (WebView2 input freeze recovery) ───────────
const reloadBtn = document.getElementById('reloadBtn');
if (reloadBtn) {
    reloadBtn.addEventListener('click', () => location.reload());
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); location.reload(); }
});

// ── Comment navigation ───────────────────────────────────────
const commentNav = document.getElementById('commentNav');
const commentNavLabel = document.getElementById('commentNavLabel');
const prevCommentBtn = document.getElementById('prevComment');
const nextCommentBtn = document.getElementById('nextComment');

function updateCommentNav() {
    const count = diffView.commentCount;
    if (count > 0) {
        commentNav.classList.remove('hidden');
        commentNavLabel.textContent = `${count}`;
    } else {
        commentNav.classList.add('hidden');
    }
}

// Update nav visibility whenever comments change
const origUpdateComments = diffView.updateComments.bind(diffView);
diffView.updateComments = (threads) => {
    origUpdateComments(threads);
    updateCommentNav();
};

const origAddAgentReply = diffView.addAgentReply.bind(diffView);
diffView.addAgentReply = (threadId, text) => {
    origAddAgentReply(threadId, text);
    updateCommentNav();
};

prevCommentBtn.addEventListener('click', () => {
    const pos = diffView.navigateComment('prev');
    commentNavLabel.textContent = `${pos.current}/${pos.total}`;
});

nextCommentBtn.addEventListener('click', () => {
    const pos = diffView.navigateComment('next');
    commentNavLabel.textContent = `${pos.current}/${pos.total}`;
});

// Keyboard shortcuts: F7 = next, Shift+F7 = prev
document.addEventListener('keydown', (e) => {
    if (e.key === 'F7') {
        e.preventDefault();
        const dir = e.shiftKey ? 'prev' : 'next';
        const pos = diffView.navigateComment(dir);
        commentNavLabel.textContent = `${pos.current}/${pos.total}`;
    }
});
