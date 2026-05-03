/**
 * Application entry point — orchestrates copilot bridge, tabs, and views.
 * Uses window.copilot (injected by /__bridge.js) for extension communication.
 */
import { DiffView } from './diff-view.js';
import { VizPanel } from './viz-panel.js';

// ── Transport adapter for DiffView ────────────────────────────
const transport = {
    addComment: (filePath, line, endLine, side, text) =>
        copilot.addComment(filePath, line, endLine, side, text),
    addReply: (threadId, text) =>
        copilot.addReply(threadId, text),
    resolveThread: (threadId) =>
        copilot.resolveThread(threadId),
    submitBatch: (comments) =>
        copilot.submitBatch(comments),
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

// ── Connection status indicator ───────────────────────────────
const statusEl = document.getElementById('connectionStatus');

function setConnected() {
    statusEl.classList.add('connected');
    statusEl.classList.remove('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Connected';
}

function setDisconnected() {
    statusEl.classList.remove('connected');
    statusEl.classList.add('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Disconnected';
}

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
if (treeToggle) {
    if (diffView.treeMode) {
        treeToggle.title = 'Switch to flat view';
    }
    treeToggle.addEventListener('click', () => {
        const isTree = diffView.toggleTreeMode();
        treeToggle.title = isTree ? 'Switch to flat view' : 'Switch to tree view';
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
