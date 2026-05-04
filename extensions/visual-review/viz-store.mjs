// JSON-backed visualization storage for the visual-review extension.
// Each session gets its own viz file at
// ~/.copilot/visual-review/viz-{sessionId}.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function nowIso() {
    return new Date().toISOString();
}

export class VizStore {
    /** @param {string} sessionId */
    constructor(sessionId) {
        const stateDir = join(homedir(), ".copilot", "visual-review");
        mkdirSync(stateDir, { recursive: true });
        this.storePath = join(stateDir, `viz-${sessionId}.json`);
        /** @type {Array<object>} */
        this.visualizations = [];
    }

    /** Read persisted visualizations from disk. */
    load() {
        if (!existsSync(this.storePath)) {
            this.visualizations = [];
            return;
        }

        try {
            const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
            this.visualizations = raw.visualizations ?? [];
        } catch {
            this.visualizations = [];
        }
    }

    /** Persist current visualizations to disk. */
    save() {
        mkdirSync(dirname(this.storePath), { recursive: true });
        const payload = {
            version: 1,
            updatedAt: nowIso(),
            visualizations: this.visualizations,
        };
        writeFileSync(this.storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }

    /**
     * Add a visualization and persist.
     * @param {{ title: string, mermaid: string, description?: string }} viz
     */
    add(viz) {
        this.visualizations.push({
            ...viz,
            createdAt: nowIso(),
        });
        this.save();
    }

    /** @returns {Array<object>} All visualizations. */
    getAll() {
        return this.visualizations;
    }
}
