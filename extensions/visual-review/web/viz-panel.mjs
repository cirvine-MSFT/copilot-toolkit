/**
 * Visualization panel — renders Mermaid diagrams into cards.
 */
export class VizPanel {
    /** @type {HTMLElement} */
    #container;
    #vizCount = 0;

    /**
     * @param {HTMLElement} container — the #vizContainer element
     */
    constructor(container) {
        this.#container = container;
    }

    /**
     * Add a new visualization card with a rendered Mermaid diagram.
     * @param {{ title: string, mermaid: string, description?: string }} data
     */
    async addVisualization({ title, mermaid: code, description }) {
        // Hide empty state
        const emptyState = document.getElementById('vizEmpty');
        if (emptyState) emptyState.classList.add('hidden');

        const id = `mermaid-${this.#vizCount++}`;
        const card = document.createElement('div');
        card.className = 'vr-viz-card';
        card.innerHTML = `
            <div class="vr-viz-card-header">
                <h3 class="vr-viz-title">${escapeHtml(title)}</h3>
                <div class="vr-viz-actions">
                    <button class="vr-btn vr-btn-icon" data-action="copy-code" title="Copy Mermaid source">
                        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25
                                     0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0
                                     .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25
                                     16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
                            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16
                                     1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1
                                     5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0
                                     .138.112.25.25.25h7.5a.25.25 0 0 0
                                     .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
                        </svg>
                    </button>
                    <button class="vr-btn vr-btn-icon" data-action="collapse" title="Collapse">
                        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
                            <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0
                                     1-1.06 0L3.22 6.28a.751.751 0 0 1 .018-1.042.751.751 0 0
                                     1 1.042-.018L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z"/>
                        </svg>
                    </button>
                </div>
            </div>
            ${description ? `<p class="vr-viz-description">${escapeHtml(description)}</p>` : ''}
            <div class="vr-viz-body">
                <div class="vr-mermaid-container" id="${id}"></div>
            </div>
            <details class="vr-viz-source">
                <summary>View source</summary>
                <pre><code>${escapeHtml(code)}</code></pre>
            </details>`;

        this.#container.appendChild(card);

        // Wire up buttons
        card.querySelector('[data-action="copy-code"]')?.addEventListener('click', () => {
            navigator.clipboard.writeText(code).catch(() => {});
        });

        card.querySelector('[data-action="collapse"]')?.addEventListener('click', (e) => {
            const body = card.querySelector('.vr-viz-body');
            body.classList.toggle('collapsed');
            const svg = e.currentTarget.querySelector('svg');
            svg.style.transform = body.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
        });

        // Render Mermaid diagram
        if (window.mermaid) {
            try {
                const { svg } = await window.mermaid.render(id + '-svg', code);
                card.querySelector('.vr-mermaid-container').innerHTML = svg;
            } catch (err) {
                card.querySelector('.vr-mermaid-container').innerHTML =
                    `<div class="vr-viz-error">
                        <strong>Diagram render error</strong>
                        <pre>${escapeHtml(String(err))}</pre>
                    </div>`;
            }
        } else {
            card.querySelector('.vr-mermaid-container').innerHTML =
                '<p class="vr-viz-error">Mermaid library not loaded</p>';
        }

        // Scroll the new card into view
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    /** Remove all visualization cards. */
    clear() {
        this.#container.innerHTML = '';
        this.#vizCount = 0;
        const emptyState = document.getElementById('vizEmpty');
        if (emptyState) emptyState.classList.remove('hidden');
    }
}

/** Escape HTML special characters. */
function escapeHtml(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el.innerHTML;
}
