/**
 * Diff view — renders unified diffs via diff2html and adds a GitHub-style
 * inline comment system on top.
 */
export class DiffView {
    /** @type {HTMLElement} */
    #container;
    /** @type {object} */
    #transport;
    /** @type {'side-by-side'|'line-by-line'} */
    #outputFormat = 'side-by-side';
    /** Current raw diff string — kept for re-rendering when toggling format. */
    #rawDiff = '';
    /** Map of threadId → { filePath, line, side, comments[] } */
    #threads = new Map();
    /** Currently-open comment form element, if any. */
    #openForm = null;
    /** Multi-line selection state: { startCell, startLine, side, filePath } */
    #rangeStart = null;
    /** Whether a drag selection is in progress */
    #dragging = false;
    /** Queued (pending) comments for batch mode */
    #pendingComments = [];
    /** Whether to send comments immediately or queue them */
    #batchMode = false;
    /** Whether the sidebar shows tree view (true) or flat list (false) */
    #treeMode = false;

    /**
     * @param {HTMLElement} container — the #diffContainer element
     * @param {object} transport
     */
    constructor(container, transport) {
        this.#container = container;
        this.#transport = transport;
        this.#treeMode = localStorage.getItem('vr-tree-mode') === 'true';
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

    /** Whether tree view is active. */
    get treeMode() { return this.#treeMode; }

    /** Number of comment threads. */
    get commentCount() { return this.#threads.size; }

    /**
     * Navigate to the next or previous comment thread.
     * @param {'next'|'prev'} direction
     * @returns {{ current: number, total: number }} position after navigation
     */
    navigateComment(direction) {
        const rows = Array.from(this.#container.querySelectorAll('.vr-comment-thread-row'));
        if (rows.length === 0) return { current: 0, total: 0 };

        const panel = this.#container.closest('.vr-panel') ?? this.#container.parentElement;
        const scrollTop = panel.scrollTop;
        const panelTop = panel.getBoundingClientRect().top;

        // Find which comment is currently in view (closest to top of viewport)
        let currentIdx = -1;
        for (let i = 0; i < rows.length; i++) {
            const rect = rows[i].getBoundingClientRect();
            if (rect.top >= panelTop - 10) {
                currentIdx = i;
                break;
            }
        }
        if (currentIdx === -1) currentIdx = rows.length - 1;

        let targetIdx;
        if (direction === 'next') {
            // If current comment is already visible, go to next one
            const currentRect = rows[currentIdx].getBoundingClientRect();
            if (currentRect.top < panelTop + 50 && currentRect.top > panelTop - 50) {
                targetIdx = (currentIdx + 1) % rows.length;
            } else {
                targetIdx = currentIdx;
            }
        } else {
            targetIdx = currentIdx > 0 ? currentIdx - 1 : rows.length - 1;
        }

        rows[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Brief highlight
        rows[targetIdx].classList.add('vr-highlight');
        setTimeout(() => rows[targetIdx].classList.remove('vr-highlight'), 1500);

        return { current: targetIdx + 1, total: rows.length };
    }

    /**
     * Toggle between flat and tree view in the sidebar.
     * @returns {boolean} The new tree mode state.
     */
    toggleTreeMode() {
        this.#treeMode = !this.#treeMode;
        localStorage.setItem('vr-tree-mode', String(this.#treeMode));
        if (this.#rawDiff) {
            this.#buildFileTree(this.#rawDiff);
        }
        return this.#treeMode;
    }

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

    #getColspan() {
        const firstRow = this.#container.querySelector('.d2h-diff-tbody tr');
        if (firstRow) {
            return firstRow.querySelectorAll('td').length;
        }
        return this.#outputFormat === 'side-by-side' ? 4 : 3;
    }

    // ── Comment trigger (the "+" button on hover) ─────────────────

    #attachCommentTriggers() {
        const lineNumCells = this.#container.querySelectorAll('.d2h-code-linenumber, .d2h-code-side-linenumber');
        for (const cell of lineNumCells) {
            cell.classList.add('vr-line-gutter');
            cell.addEventListener('mouseenter', () => {
                if (this.#dragging) {
                    this.#handleDragOver(cell);
                } else {
                    this.#showTrigger(cell);
                }
            });
            cell.addEventListener('mouseleave', (e) => {
                if (this.#dragging) return;
                const related = e.relatedTarget;
                if (related && related.closest('.vr-add-comment-btn')) return;
                this.#hideTrigger(cell);
            });
            // Click on line number to start/extend range selection
            cell.addEventListener('click', (e) => {
                if (e.target.closest('.vr-add-comment-btn')) return;
                // Skip if drag already handled this interaction
                if (this.#dragging) return;
                this.#handleLineClick(cell, e.shiftKey);
            });
            // Drag to select: mousedown starts drag
            cell.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const { filePath, line, side } = this.#resolveLineInfo(cell, cell.closest('tr'));
                if (!line) return;
                e.preventDefault(); // prevent text selection
                this.#closeCommentForm();
                this.#clearRangeHighlight();
                this.#dragging = true;
                this.#rangeStart = { startCell: cell, startLine: line, side, filePath };
                cell.closest('tr')?.classList.add('vr-range-selected');
            });
        }

        // Global mouseup ends drag and opens form
        const onMouseUp = () => {
            if (!this.#dragging || !this.#rangeStart) return;
            this.#dragging = false;
            const { startCell, startLine, side, filePath } = this.#rangeStart;
            // Find the current end of the highlighted range
            const highlighted = this.#container.querySelectorAll('.vr-range-selected');
            if (highlighted.length === 0) return;
            const lastRow = highlighted[highlighted.length - 1];
            const lastCell = lastRow.querySelector('.d2h-code-linenumber, .d2h-code-side-linenumber');
            const endInfo = lastCell ? this.#resolveLineInfo(lastCell, lastRow) : { line: startLine };
            const endLine = endInfo.line || startLine;
            const rangeStartLine = Math.min(startLine, endLine);
            const rangeEndLine = Math.max(startLine, endLine);
            if (rangeStartLine === rangeEndLine) {
                // Single line — open comment form directly
                this.#openCommentForm(startCell);
            } else {
                this.#openCommentForm(lastCell || startCell, { startLine: rangeStartLine, endLine: rangeEndLine });
            }
        };
        document.addEventListener('mouseup', onMouseUp);
    }

    #handleDragOver(cell) {
        if (!this.#rangeStart) return;
        const { filePath, side, startLine } = this.#rangeStart;
        const info = this.#resolveLineInfo(cell, cell.closest('tr'));
        if (info.filePath !== filePath || info.side !== side || !info.line) return;
        const start = Math.min(startLine, info.line);
        const end = Math.max(startLine, info.line);
        this.#highlightRange(filePath, start, end, side);
    }

    #handleLineClick(cell, isShift) {
        const { filePath, line, side } = this.#resolveLineInfo(cell, cell.closest('tr'));
        if (!line) return;

        if (isShift && this.#rangeStart && this.#rangeStart.filePath === filePath && this.#rangeStart.side === side) {
            // Extend the range — open form for startLine-endLine
            const startLine = Math.min(this.#rangeStart.startLine, line);
            const endLine = Math.max(this.#rangeStart.startLine, line);
            this.#highlightRange(filePath, startLine, endLine, side);
            this.#openCommentForm(cell, { startLine, endLine });
        } else {
            // Start a new range
            this.#clearRangeHighlight();
            this.#rangeStart = { startCell: cell, startLine: line, side, filePath };
            cell.closest('tr')?.classList.add('vr-range-selected');
        }
    }

    #highlightRange(filePath, startLine, endLine, side) {
        this.#clearRangeHighlight();
        const cells = this.#container.querySelectorAll('.d2h-code-linenumber, .d2h-code-side-linenumber');
        for (const cell of cells) {
            const info = this.#resolveLineInfo(cell, cell.closest('tr'));
            if (info.filePath === filePath && info.side === side && info.line >= startLine && info.line <= endLine) {
                cell.closest('tr')?.classList.add('vr-range-selected');
            }
        }
    }

    #clearRangeHighlight() {
        this.#container.querySelectorAll('.vr-range-selected').forEach(el => el.classList.remove('vr-range-selected'));
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
        cell.appendChild(btn);
    }

    #hideTrigger(cell) {
        cell.querySelector('.vr-add-comment-btn')?.remove();
    }

    // ── Comment form ──────────────────────────────────────────────

    #openCommentForm(lineNumCell, range = null) {
        this.#closeCommentForm();

        const tr = lineNumCell.closest('tr');
        if (!tr) return;

        const { filePath, line, side } = this.#resolveLineInfo(lineNumCell, tr);
        const startLine = range?.startLine ?? line;
        const endLine = range?.endLine ?? line;
        const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;

        // Insert a thin marker row in the table for positioning
        const colspan = this.#getColspan();
        const markerRow = document.createElement('tr');
        markerRow.className = 'vr-comment-marker-row';
        markerRow.innerHTML = `<td colspan="${colspan}"></td>`;
        tr.after(markerRow);

        // Create the form as a div appended to the panel (not the table)
        const panel = this.#container.closest('.vr-panel') ?? this.#container.parentElement;
        const formEl = document.createElement('div');
        formEl.className = 'vr-comment-form-float';
        formEl.innerHTML = `
            <div class="vr-comment-form">
                <div class="vr-comment-input">
                    <div class="vr-comment-tab-nav">
                        <button class="vr-comment-tab active" data-write>Write</button>
                        <button class="vr-comment-tab" data-preview>Preview</button>
                        <span class="vr-comment-line-label">${lineLabel}</span>
                        <span class="vr-comment-tab-spacer"></span>
                        <label class="vr-batch-toggle">
                            <input type="checkbox" class="vr-batch-checkbox" ${this.#batchMode ? 'checked' : ''}>
                            <span>Batch</span>
                        </label>
                        <button class="vr-btn vr-btn-sm vr-btn-cancel">Cancel</button>
                        <button class="vr-btn vr-btn-sm vr-btn-primary">${this.#batchMode ? 'Add to pending' : 'Comment'}</button>
                    </div>
                    <textarea class="vr-comment-textarea" placeholder="Leave a comment (Ctrl+Enter to submit)" rows="3"></textarea>
                    <div class="vr-comment-preview hidden"></div>
                </div>
            </div>`;

        // Position the form at the marker row's location within the panel
        // In side-by-side mode, align to the side where the comment was started
        const positionForm = () => {
            const markerRect = markerRow.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            formEl.style.top = `${markerRect.top - panelRect.top + panel.scrollTop}px`;

            if (this.#outputFormat === 'side-by-side') {
                const panelWidth = panelRect.width;
                formEl.style.width = `${Math.floor(panelWidth / 2) - 16}px`;
                if (side === 'right') {
                    formEl.style.left = 'auto';
                    formEl.style.right = '16px';
                } else {
                    formEl.style.left = '16px';
                    formEl.style.right = 'auto';
                }
            }
        };

        panel.style.position = 'relative';
        panel.appendChild(formEl);
        positionForm();

        // Track both elements for cleanup
        this.#openForm = { remove: () => { markerRow.remove(); formEl.remove(); } };

        const textarea = formEl.querySelector('.vr-comment-textarea');
        textarea.focus();

        // Batch toggle
        const batchCheckbox = formEl.querySelector('.vr-batch-checkbox');
        const submitBtn = formEl.querySelector('.vr-btn-primary');
        batchCheckbox.addEventListener('change', () => {
            this.#batchMode = batchCheckbox.checked;
            submitBtn.textContent = this.#batchMode ? 'Add to pending' : 'Comment';
        });

        // Tab switching (Write / Preview)
        const tabNav = formEl.querySelector('.vr-comment-tab-nav');
        tabNav.addEventListener('click', (e) => {
            const tab = e.target.closest('.vr-comment-tab');
            if (!tab) return;
            tabNav.querySelectorAll('.vr-comment-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const isPreview = tab.hasAttribute('data-preview');
            const preview = formEl.querySelector('.vr-comment-preview');
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
        formEl.querySelector('.vr-btn-cancel').addEventListener('click', () => {
            this.#clearRangeHighlight();
            this.#rangeStart = null;
            this.#closeCommentForm();
        });

        // Submit
        submitBtn.addEventListener('click', () => {
            const body = textarea.value.trim();
            if (!body) return;
            this.#submitComment(filePath, startLine, endLine, side, body, tr);
            this.#clearRangeHighlight();
            this.#rangeStart = null;
            this.#closeCommentForm();
        });

        // Ctrl+Enter to submit
        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                const body = textarea.value.trim();
                if (!body) return;
                this.#submitComment(filePath, startLine, endLine, side, body, tr);
                this.#clearRangeHighlight();
                this.#rangeStart = null;
                this.#closeCommentForm();
            }
        });
    }

    #closeCommentForm() {
        this.#openForm?.remove();
        this.#openForm = null;
    }

    #submitComment(filePath, startLine, endLine, side, body, anchorRow) {
        const threadId = crypto.randomUUID();
        const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
        const thread = {
            id: threadId,
            filePath,
            line: startLine,
            endLine,
            side,
            comments: [{ author: 'You', body, timestamp: 'just now' }],
        };
        this.#threads.set(threadId, thread);

        // Insert the thread display row after the anchor row
        this.#insertThreadRow(thread, anchorRow);
        this.#updateFileTreeCommentCounts();

        if (this.#batchMode) {
            this.#pendingComments.push({ filePath, line: startLine, endLine: endLine !== startLine ? endLine : undefined, side, body });
            this.#updatePendingBadge();
        } else {
            this.#transport.addComment(filePath, startLine, endLine, side, body)
                .then(result => {
                    if (result?.threads) this.updateComments(result.threads);
                })
                .catch(err => console.error('[diff-view] addComment failed:', err));
        }
    }

    /** Send all queued comments as a single batch. */
    submitPendingComments() {
        if (this.#pendingComments.length === 0) return;
        const batch = this.#pendingComments;
        this.#pendingComments = [];
        this.#updatePendingBadge();
        this.#transport.submitBatch(batch)
            .then(result => {
                if (result?.threads) this.updateComments(result.threads);
            })
            .catch(err => console.error('[diff-view] submitBatch failed:', err));
    }

    /** Get pending comment count. */
    get pendingCount() { return this.#pendingComments.length; }

    #updatePendingBadge() {
        const badge = document.getElementById('pendingBadge');
        if (!badge) return;
        if (this.#pendingComments.length > 0) {
            badge.textContent = `${this.#pendingComments.length} pending`;
            badge.classList.add('has-pending');
        } else {
            badge.textContent = '';
            badge.classList.remove('has-pending');
        }
    }

    // ── Thread display ────────────────────────────────────────────

    #insertThreadRow(thread, afterRow) {
        // Check if a thread row already exists for this thread
        const existing = this.#container.querySelector(
            `.vr-comment-thread-row[data-thread-id="${thread.id}"]`
        );
        if (existing) existing.remove();

        const colspan = this.#getColspan();
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

            this.#transport.addReply(thread.id, body)
                .then(result => {
                    if (result?.threads) this.updateComments(result.threads);
                })
                .catch(err => console.error('[diff-view] addReply failed:', err));
        });

        textarea?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                replyBtn?.click();
            }
        });

        resolveBtn?.addEventListener('click', () => {
            row.classList.add('vr-resolved');
            row.querySelector('.vr-thread-reply')?.remove();
            this.#transport.resolveThread(thread.id)
                .catch(err => console.error('[diff-view] resolveThread failed:', err));
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
        const lineNumCells = fileWrapper.querySelectorAll('.d2h-code-linenumber, .d2h-code-side-linenumber');
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
        const cells = Array.from(tr.querySelectorAll('.d2h-code-linenumber, .d2h-code-side-linenumber'));
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

        if (this.#treeMode) {
            this.#buildTreeView(files, fileTree);
        } else {
            this.#buildFlatView(files, fileTree);
        }

        // Wire filter input (use property to avoid stacking listeners on repeated render calls)
        const filterInput = document.getElementById('fileFilter');
        if (filterInput) {
            filterInput.oninput = () => {
                const query = filterInput.value.toLowerCase();
                fileTree.querySelectorAll('.vr-file-item').forEach(item => {
                    const name = item.dataset.file.toLowerCase();
                    item.style.display = name.includes(query) ? '' : 'none';
                });
                // In tree mode, hide empty directories
                if (this.#treeMode) {
                    fileTree.querySelectorAll('.vr-tree-dir').forEach(dir => {
                        const visibleFiles = dir.querySelectorAll('.vr-file-item:not([style*="display: none"])');
                        dir.style.display = visibleFiles.length > 0 ? '' : 'none';
                    });
                }
            };
        }

        this.#updateFileTreeCommentCounts();
    }

    #buildFlatView(files, fileTree) {
        fileTree.innerHTML = files.map(f => `
            <button class="vr-file-item" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
                <span class="vr-file-status vr-file-status-${f.status.toLowerCase()}">${f.status}</span>
                <span class="vr-file-name">${escapeHtml(shortPath(f.path))}</span>
                <span class="vr-file-comments" data-file-comments="${escapeHtml(f.path)}"></span>
            </button>`).join('');

        this.#wireFileItemClicks(fileTree);
    }

    #buildTreeView(files, fileTree) {
        // Build a nested tree data structure
        const root = { children: {}, files: [] };

        for (const f of files) {
            const parts = f.path.split('/');
            let node = root;

            // Navigate/create directory nodes for each path segment except the filename
            for (let i = 0; i < parts.length - 1; i++) {
                const segment = parts[i];
                if (!node.children[segment]) {
                    node.children[segment] = { children: {}, files: [] };
                }
                node = node.children[segment];
            }

            // Add file to the leaf directory
            node.files.push({ ...f, name: parts[parts.length - 1] });
        }

        // Render the tree recursively
        fileTree.innerHTML = this.#renderTreeNode(root, 0);

        // Wire directory collapse/expand
        fileTree.querySelectorAll('.vr-tree-dir-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.vr-tree-dir').classList.toggle('collapsed');
            });
        });

        this.#wireFileItemClicks(fileTree);
    }

    #renderTreeNode(node, depth) {
        let html = '';

        // Render subdirectories first (sorted)
        const dirNames = Object.keys(node.children).sort();
        for (const dirName of dirNames) {
            const child = node.children[dirName];
            const fileCount = this.#countFiles(child);
            const indent = depth * 12;
            const childHtml = this.#renderTreeNode(child, depth + 1);

            html += `<div class="vr-tree-dir">
                <button class="vr-tree-dir-header" style="padding-left: ${8 + indent}px">
                    <svg class="vr-tree-chevron" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                        <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>
                    </svg>
                    <span class="vr-tree-dir-name">${escapeHtml(dirName)}</span>
                    <span class="vr-tree-dir-count">${fileCount}</span>
                </button>
                <div class="vr-tree-dir-children">${childHtml}</div>
            </div>`;
        }

        // Then render files in this directory (sorted)
        const indent = depth * 12;
        for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
            html += `<button class="vr-file-item vr-tree-file" data-file="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}" style="padding-left: ${20 + indent}px">
                <span class="vr-file-status vr-file-status-${f.status.toLowerCase()}">${f.status}</span>
                <span class="vr-file-name">${escapeHtml(f.name)}</span>
                <span class="vr-file-comments" data-file-comments="${escapeHtml(f.path)}"></span>
            </button>`;
        }

        return html;
    }

    #countFiles(node) {
        let count = node.files.length;
        for (const child of Object.values(node.children)) {
            count += this.#countFiles(child);
        }
        return count;
    }

    #wireFileItemClicks(fileTree) {
        fileTree.querySelectorAll('.vr-file-item').forEach(item => {
            item.addEventListener('click', () => {
                const filePath = item.dataset.file;
                this.#scrollToFile(filePath);
                fileTree.querySelectorAll('.vr-file-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
        });
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

/** Shorten path — show filename with enough context to be unique. */
function shortPath(fullPath) {
    const parts = fullPath.split('/');
    if (parts.length <= 2) return fullPath;
    // Show the last 2 segments (dir/file) for brevity
    return parts.slice(-2).join('/');
}
