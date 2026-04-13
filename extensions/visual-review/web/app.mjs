/**
 * Application entry point — orchestrates WebSocket, tabs, and views.
 */
import { DiffView } from './diff-view.mjs';
import { VizPanel } from './viz-panel.mjs';
import { WsClient } from './ws-client.mjs';

// ── Initialize WebSocket ──────────────────────────────────────
const ws = new WsClient();

// ── Initialize views ──────────────────────────────────────────
const diffView = new DiffView(document.getElementById('diffContainer'), ws);
const vizPanel = new VizPanel(document.getElementById('vizContainer'));

// ── Handle incoming WebSocket messages ────────────────────────
ws.on('diff:data', (data) => diffView.render(data));
ws.on('comment:update', (data) => diffView.updateComments(data.threads ?? []));
ws.on('comment:agent_reply', (data) => diffView.addAgentReply(data.threadId, data.text));
ws.on('viz:data', (data) => vizPanel.addVisualization(data));

// ── Connection status indicator ───────────────────────────────
const statusEl = document.getElementById('connectionStatus');

ws.on('open', () => {
    statusEl.classList.add('connected');
    statusEl.classList.remove('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Connected';
});

ws.on('close', () => {
    statusEl.classList.remove('connected');
    statusEl.classList.add('disconnected');
    statusEl.querySelector('.vr-status-text').textContent = 'Disconnected';
});

// ── Tab switching ─────────────────────────────────────────────
const diffPanel = document.getElementById('diffPanel');
const vizPanelEl = document.getElementById('vizPanel');

document.querySelectorAll('.vr-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        // Update active tab
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

// ── Sidebar toggle ────────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');

sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    document.querySelector('.vr-main').classList.toggle('sidebar-collapsed');
});

// ── Submit all pending comments ───────────────────────────────
const submitAllBtn = document.getElementById('submitAllBtn');
const pendingBadge = document.getElementById('pendingBadge');

// Watch for pending badge changes to show/hide the submit button
const observer = new MutationObserver(() => {
    submitAllBtn.classList.toggle('hidden', !pendingBadge.classList.contains('has-pending'));
});
observer.observe(pendingBadge, { attributes: true, attributeFilter: ['class'] });

submitAllBtn.addEventListener('click', () => {
    diffView.submitPendingComments();
});
