/**
 * Diff view — renders unified diffs via diff2html and adds a GitHub-style
 * inline comment system on top.
 */
export class DiffView {
    /** @type {HTMLElement} */
    #container;
    /** @type {import('./ws-client.mjs').WsClient} */
    #ws;
    /** @type {'side-by-side'|'line-by-line'} */
    #outputFormat = 'side-by-side';
    /** Current raw diff string — kept for re-rendering when toggling format. */
    #rawDiff = '';
    /** Map of threadId → { filePath, line, side, comments[] } */
    #threads = new Map();
    /** Currently-open comment form element, if any. */
    #openForm = null;

    /**
     * @param {HTMLElement} container — the #diffContainer element
     * @param {import('./ws-client.mjs').WsClient} ws
     */
    constructor(container, ws) {
        this.#container = container;
        this.#ws = ws;
    }

    // ── Public API ────────────────────────────────────────────────

    /**
     * Render a unified diff.
     * @param {{ diff: string, files?: Array }} data
     */
    render(data) {
        const diffString = data.diff ?? data.diffString ?? '';
        this.#rawDiff = diffString;

        // Hide empty state
        const emptyEl = document.getElementById('diffEmpty');
        if (emptyEl) emptyEl.classList.add('hidden');

        this.#draw();
        this.#buildFileTree(diffString);

        // Re-apply any existing comment threads
        if (this.#threads.size) {
            this.#renderAllThreads();
        }
    }

    /**
     * Replace all comment threads.
     * @param {Array<{ id: string, filePath: string, line: number, side?: string, comments: Array<{ author: string, body: string, timestamp?: string }> }>} threads
     */
    updateComments(threads) {
        this.#threads.clear();
        for (const t of threads) {
            this.#threads.set(t.id, t);
        }
        this.#renderAllThreads();
        this.#updateFileTreeCommentCounts();
    }

    /**
     * Append an agent reply to an existing thread.
     * @param {string} threadId
     * @param {string} text
     */
    addAgentReply(threadId, text) {
        const thread = this.#threads.get(threadId);
        if (!thread) return;
        thread.comments.push({ author: 'Copilot', body: text, timestamp: 'just now' });
        // Re-render that specific thread row
        const row = this.#container.querySelector(`.vr-comment-thread-row[data-thread-id="${threadId}"]`);
        if (row) {
            row.querySelector('.vr-comment-thread').innerHTML = this.#renderThreadContent(thread);
            this.#wireThreadReply(row, thread);
        }
    }

    /**
     * Switch between side-by-side and line-by-line.
     * @param {'side-by-side'|'line-by-line'} format
     */
    setOutputFormat(format) {
        this.#outputFormat = format;
        if (this.#rawDiff) this.#draw();
    }

    /** Current output format. */
    get outputFormat() { return this.#outputFormat; }

    // ── Diff rendering ────────────────────────────────────────────

    #draw() {
        this.#container.innerHTML = '';
        const Diff2HtmlUI = window.Diff2HtmlUI ?? window.Diff2Html?.Diff2HtmlUI;
        if (!Diff2HtmlUI) {
            this.#container.innerHTML = '<p class="vr-error">diff2html not loaded</p>';
            return;
        }

        const ui = new Diff2HtmlUI(this.#container, this.#rawDiff, {
            drawFileList: false,
            matching: 'lines',
            outputFormat: this.#outputFormat,
            highlight: true,
            renderNothingWhenEmpty: false,
            colorScheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
        });
        ui.draw();
        ui.highlightCode();

        // Attach hover "+" buttons for comments
        this.#attachCommentTriggers();

        // Re-render threads
        this.#renderAllThreads();
    }

    // ── Comment trigger (the "+" button on hover) ─────────────────

    #attachCommentTriggers() {
        const lineNumCells = this.#container.querySelectorAll('.d2h-code-linenumber');
        for (const cell of lineNumCells) {
            cell.classList.add('vr-line-gutter');
            cell.addEventListener('mouseenter', () => this.#showTrigger(cell));
            cell.addEventListener('mouseleave', (e) => {
                // Don't hide if we're moving into the trigger button itself
                const related = e.relatedTarget;
                if (related && related.closest('.vr-add-comment-btn')) return;
                this.#hideTrigger(cell);
            });
        }
    }

    #showTrigger(cell) {
        if (cell.querySelector('.vr-add-comment-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'vr-add-comment-btn';
        btn.setAttribute('aria-label', 'Add comment');
        btn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.25 0.75a.75.75 0 0 1 1.5 0v6.5h6.5a.75.75 0 0 1 0 1.5h-6.5v6.5a.75.75 0 0 1-1.5 0v-6.5h-6.5a.75.75 0 0 1 0-1.5h6.5V0.75Z"/></svg>';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.#openCommentForm(cell);
        });
        btn.addEventListener('mouseleave', (e) => {
            const related = e.relatedTarget;
            if (related && related.closest('.vr-line-gutter') === cell) return;
            this.#hideTrigger(cell);
        });
        cell.style.position = 'relative';
        cell.appendChild(btn);
    }

    #hideTrigger(cell) {
        cell.querySelector('.vr-add-comment-btn')?.remove();
    }

    // ── Comment form ──────────────────────────────────────────────

    #openCommentForm(lineNumCell) {
        // Close any existing form
        this.#closeCommentForm();

        const tr = lineNumCell.closest('tr');
        if (!tr) return;

        const { filePath, line, side } = this.#resolveLineInfo(lineNumCell, tr);

        const colspan = this.#outputFormat === 'side-by-side' ? 4 : 3;
        const formRow = document.createElement('tr');
        formRow.className = 'vr-comment-form-row';
        formRow.innerHTML = `
            <td colspan="${colspan}">
                <div class="vr-comment-form">
                    <div class="vr-comment-avatar">
                        <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor">
                            <path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1
                                     1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07
                                     6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1
                                     5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>
                        </svg>
                    </div>
                    <div class="vr-comment-input">
                        <div class="vr-comment-tab-nav">
                            <button class="vr-comment-tab active" data-write>Write</button>
                            <button class="vr-comment-tab" data-preview>Preview</button>
                        </div>
                        <textarea class="vr-comment-textarea" placeholder="Leave a comment" rows="4"></textarea>
                        <div class="vr-comment-preview hidden"></div>
                        <div class="vr-comment-actions">
                            <button class="vr-btn vr-btn-cancel">Cancel</button>
                            <button class="vr-btn vr-btn-primary">Comment</button>
                        </div>
                    </div>
                </div>
            </td>`;

        tr.after(formRow);
        this.#openForm = formRow;

        // Focus textarea
        const textarea = formRow.querySelector('.vr-comment-textarea');
        textarea.focus();

        // Tab switching (Write / Preview)
        const tabNav = formRow.querySelector('.vr-comment-tab-nav');
        tabNav.addEventListener('click', (e) => {
            const tab = e.target.closest('.vr-comment-tab');
            if (!tab) return;
            tabNav.querySelectorAll('.vr-comment-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const isPreview = tab.hasAttribute('data-preview');
            const preview = formRow.querySelector('.vr-comment-preview');
            if (isPreview) {
                textarea.classList.add('hidden');
                preview.classList.remove('hidden');
                preview.textContent = textarea.value || '(nothing to preview)';
            } else {
                textarea.classList.remove('hidden');
                preview.classList.add('hidden');
            }
        });

        // Cancel
        formRow.querySelector('.vr-btn-cancel').addEventListener('click', () => {
            this.#closeCommentForm();
        });

        // Submit
        formRow.querySelector('.vr-btn-primary').addEventListener('click', () => {
            const body = textarea.value.trim();
            if (!body) return;
            this.#submitComment(filePath, line, side, body, tr);
            this.#closeCommentForm();
        });

        // Ctrl+Enter to submit
        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                const body = textarea.value.trim();
                if (!body) return;
                this.#submitComment(filePath, line, side, body, tr);
                this.#closeCommentForm();
            }
        });
    }

    #closeCommentForm() {
        this.#openForm?.remove();
        this.#openForm = null;
    }

    #submitComment(filePath, line, side, body, anchorRow) {
        const threadId = crypto.randomUUID();
        const thread = {
            id: threadId,
            filePath,
            line,
            side,
            comments: [{ author: 'You', body, timestamp: 'just now' }],
        };
        this.#threads.set(threadId, thread);

        // Insert the thread display row after the anchor row
        this.#insertThreadRow(thread, anchorRow);
        this.#updateFileTreeCommentCounts();

        // Send to server
        this.#ws.send({
            type: 'comment:new',
            threadId,
            filePath,
            line,
            side,
            body,
        });
    }

    // ── Thread display ────────────────────────────────────────────

    #insertThreadRow(thread, afterRow) {
        // Check if a thread row already exists for this thread
        const existing = this.#container.querySelector(
            `.vr-comment-thread-row[data-thread-id="${thread.id}"]`
        );
        if (existing) existing.remove();

        const colspan = this.#outputFormat === 'side-by-side' ? 4 : 3;
        const row = document.createElement('tr');
        row.className = 'vr-comment-thread-row';
        row.dataset.threadId = thread.id;
        row.innerHTML = `
            <td colspan="${colspan}">
                <div class="vr-comment-thread">
                    ${this.#renderThreadContent(thread)}
                </div>
            </td>`;

        afterRow.after(row);
        this.#wireThreadReply(row, thread);
    }

    #renderThreadContent(thread) {
        const comments = thread.comments.map(c => {
            const isCopilot = c.author === 'Copilot';
            return `
                <div class="vr-comment ${isCopilot ? 'vr-comment-copilot' : 'vr-comment-user'}">
                    <div class="vr-comment-header">
                        <span class="vr-comment-avatar-sm">${isCopilot ? '🤖' : '👤'}</span>
                        <strong class="vr-comment-author">${escapeHtml(c.author)}</strong>
                        <span class="vr-comment-timestamp">${escapeHtml(c.timestamp ?? '')}</span>
                    </div>
                    <div class="vr-comment-body">${escapeHtml(c.body)}</div>
                </div>`;
        }).join('');

        return `
            ${comments}
            <div class="vr-thread-reply">
                <textarea class="vr-reply-textarea" placeholder="Reply…" rows="2"></textarea>
                <div class="vr-thread-reply-actions">
                    <button class="vr-btn vr-btn-sm vr-btn-outline vr-resolve-btn">Resolve conversation</button>
                    <button class="vr-btn vr-btn-sm vr-btn-primary vr-reply-btn">Reply</button>
                </div>
            </div>`;
    }

    #wireThreadReply(row, thread) {
        const replyBtn = row.querySelector('.vr-reply-btn');
        const textarea = row.querySelector('.vr-reply-textarea');
        const resolveBtn = row.querySelector('.vr-resolve-btn');

        replyBtn?.addEventListener('click', () => {
            const body = textarea.value.trim();
            if (!body) return;
            thread.comments.push({ author: 'You', body, timestamp: 'just now' });
            row.querySelector('.vr-comment-thread').innerHTML = this.#renderThreadContent(thread);
            this.#wireThreadReply(row, thread);

            this.#ws.send({
                type: 'comment:reply',
                threadId: thread.id,
                body,
            });
        });

        textarea?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                replyBtn?.click();
            }
        });

        resolveBtn?.addEventListener('click', () => {
            row.classList.add('vr-resolved');
            row.querySelector('.vr-thread-reply')?.remove();
            this.#ws.send({ type: 'comment:resolve', threadId: thread.id });
        });
    }

    #renderAllThreads() {
        // Remove existing thread rows
        this.#container.querySelectorAll('.vr-comment-thread-row').forEach(r => r.remove());

        for (const thread of this.#threads.values()) {
            const anchorRow = this.#findAnchorRow(thread.filePath, thread.line, thread.side);
            if (anchorRow) {
                this.#insertThreadRow(thread, anchorRow);
            }
        }
    }

    /**
     * Locate the <tr> in the diff for a given file + line number.
     */
    #findAnchorRow(filePath, line, side) {
        // Find the file wrapper that contains this file path
        const fileHeaders = this.#container.querySelectorAll('.d2h-file-header');
        let fileWrapper = null;
        for (const header of fileHeaders) {
            const nameEl = header.querySelector('.d2h-file-name');
            if (nameEl && nameEl.textContent.includes(filePath)) {
                fileWrapper = header.closest('.d2h-file-wrapper');
                break;
            }
        }
        if (!fileWrapper) return null;

        // Find the line number cell matching the target line
        const lineNumCells = fileWrapper.querySelectorAll('.d2h-code-linenumber');
        for (const cell of lineNumCells) {
            const numText = cell.textContent.trim();
            if (numText && parseInt(numText, 10) === line) {
                return cell.closest('tr');
            }
        }
        return null;
    }

    // ── Helpers ───────────────────────────────────────────────────

    #resolveLineInfo(lineNumCell, tr) {
        // Extract file path from the closest file wrapper header
        const wrapper = tr.closest('.d2h-file-wrapper');
        const nameEl = wrapper?.querySelector('.d2h-file-name');
        const filePath = nameEl?.textContent?.trim() ?? 'unknown';

        // Extract line number from cell text
        const lineText = lineNumCell.textContent.trim();
        const line = parseInt(lineText, 10) || 0;

        // Determine side from cell position (left vs right in side-by-side)
        const cells = Array.from(tr.querySelectorAll('.d2h-code-linenumber'));
        const side = cells.indexOf(lineNumCell) === 0 ? 'left' : 'right';

        return { filePath, line, side };
    }

    // ── File tree (sidebar) ───────────────────────────────────────

    #buildFileTree(diffString) {
        const fileTree = document.getElementById('fileTree');
        const fileCount = document.getElementById('fileCount');
        if (!fileTree) return;

        // Parse file names from unified diff headers
        const files = [];
        const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
        let match;
        while ((match = fileRegex.exec(diffString)) !== null) {
            const oldPath = match[1];
            const newPath = match[2];
            let status = 'M'; // modified
            if (oldPath === '/dev/null' || diffString.includes(`new file mode`)) {
                status = 'A';
            }
            files.push({ path: newPath !== '/dev/null' ? newPath : oldPath, status });
        }

        // Detect deletions by scanning for "deleted file mode"
        const delRegex = /^deleted file mode/gm;
        const diffBlocks = diffString.split(/^diff --git /m).slice(1);
        for (let i = 0; i < diffBlocks.length && i < files.length; i++) {
            if (delRegex.test(diffBlocks[i])) {
                files[i].status = 'D';
            }
            // Reset regex
            delRegex.lastIndex = 0;
        }
        // Detect additions
        const addRegex = /^new file mode/m;
        for (let i = 0; i < diffBlocks.length && i < files.length; i++) {
            if (addRegex.test(diffBlocks[i])) {
                files[i].status = 'A';
            }
        }
        // Detect renames
        const renameRegex = /^rename from/m;
        for (let i = 0; i < diffBlocks.length && i < files.length; i++) {
            if (renameRegex.test(diffBlocks[i])) {
                files[i].status = 'R';
            }
        }

        if (fileCount) {
            fileCount.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
        }

        fileTree.innerHTML = files.map(f => `
            <button class="vr-file-item" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
                <span class="vr-file-status vr-file-status-${f.status.toLowerCase()}">${f.status}</span>
                <span class="vr-file-name">${escapeHtml(shortPath(f.path))}</span>
                <span class="vr-file-comments" data-file-comments="${escapeHtml(f.path)}"></span>
            </button>`).join('');

        // Wire click handlers to scroll to the file's diff
        fileTree.querySelectorAll('.vr-file-item').forEach(item => {
            item.addEventListener('click', () => {
                const filePath = item.dataset.file;
                this.#scrollToFile(filePath);
                // Highlight active
                fileTree.querySelectorAll('.vr-file-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
        });

        // Wire filter input
        const filterInput = document.getElementById('fileFilter');
        if (filterInput) {
            filterInput.addEventListener('input', () => {
                const query = filterInput.value.toLowerCase();
                fileTree.querySelectorAll('.vr-file-item').forEach(item => {
                    const name = item.dataset.file.toLowerCase();
                    item.style.display = name.includes(query) ? '' : 'none';
                });
            });
        }

        this.#updateFileTreeCommentCounts();
    }

    #scrollToFile(filePath) {
        const headers = this.#container.querySelectorAll('.d2h-file-header');
        for (const header of headers) {
            const nameEl = header.querySelector('.d2h-file-name');
            if (nameEl && nameEl.textContent.includes(filePath)) {
                header.scrollIntoView({ behavior: 'smooth', block: 'start' });
                // Brief highlight
                const wrapper = header.closest('.d2h-file-wrapper');
                wrapper?.classList.add('vr-highlight');
                setTimeout(() => wrapper?.classList.remove('vr-highlight'), 1500);
                break;
            }
        }
    }

    #updateFileTreeCommentCounts() {
        // Count comments per file
        const counts = {};
        for (const thread of this.#threads.values()) {
            counts[thread.filePath] = (counts[thread.filePath] ?? 0) + thread.comments.length;
        }

        document.querySelectorAll('[data-file-comments]').forEach(el => {
            const file = el.dataset.fileComments;
            const count = counts[file] ?? 0;
            el.textContent = count > 0 ? count : '';
            el.classList.toggle('has-comments', count > 0);
        });
    }
}

// ── Utilities ─────────────────────────────────────────────────

function escapeHtml(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
}

/** Shorten path to just the filename plus one parent dir. */
function shortPath(fullPath) {
    const parts = fullPath.split('/');
    return parts.length > 2
        ? `…/${parts.slice(-2).join('/')}`
        : fullPath;
}
