// JSON-backed comment thread storage for the visual-review extension.
// Each server instance gets its own comments file at
// ~/.copilot/visual-review/comments-{serverId}.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function generateId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
    return new Date().toISOString();
}

export class CommentStore {
    /** @param {string} serverId */
    constructor(serverId) {
        const stateDir = join(homedir(), ".copilot", "visual-review");
        mkdirSync(stateDir, { recursive: true });
        this.storePath = join(stateDir, `comments-${serverId}.json`);
        /** @type {Map<string, object>} threadId → thread */
        this.threads = new Map();
    }

    /** Read persisted threads from disk. Safe to call when the file does not exist yet. */
    load() {
        if (!existsSync(this.storePath)) {
            this.threads = new Map();
            return;
        }

        try {
            const raw = JSON.parse(readFileSync(this.storePath, "utf8"));
            this.threads = new Map();
            for (const thread of raw.threads ?? []) {
                this.threads.set(thread.id, thread);
            }
        } catch {
            this.threads = new Map();
        }
    }

    /** Persist current threads to disk. */
    save() {
        mkdirSync(dirname(this.storePath), { recursive: true });
        const payload = {
            version: 1,
            updatedAt: nowIso(),
            threads: Array.from(this.threads.values()),
        };
        writeFileSync(this.storePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }

    /**
     * Create a new thread and return its threadId.
     * @param {string} filePath
     * @param {number} lineNumber
     * @param {string} side  "left" | "right"
     * @param {string} text  Initial comment body
     * @returns {string} threadId
     */
    addThread(filePath, lineNumber, side, text) {
        const threadId = generateId("t");
        const commentId = generateId("c");

        this.threads.set(threadId, {
            id: threadId,
            filePath,
            line: lineNumber,
            side,
            status: "active",
            comments: [
                {
                    id: commentId,
                    author: "user",
                    body: text,
                    timestamp: nowIso(),
                },
            ],
        });

        this.save();
        return threadId;
    }

    /**
     * Append a reply to an existing thread.
     * @param {string} threadId
     * @param {string} author  "user" | "copilot"
     * @param {string} text
     * @returns {string|null} commentId, or null if thread not found
     */
    addReply(threadId, author, text) {
        const thread = this.threads.get(threadId);
        if (!thread) {
            return null;
        }

        const commentId = generateId("c");
        thread.comments.push({
            id: commentId,
            author,
            body: text,
            timestamp: nowIso(),
        });

        this.save();
        return commentId;
    }

    /**
     * Mark a thread as resolved.
     * @param {string} threadId
     * @returns {boolean} true if the thread existed
     */
    resolveThread(threadId) {
        const thread = this.threads.get(threadId);
        if (!thread) {
            return false;
        }

        thread.status = "resolved";
        this.save();
        return true;
    }

    /** @returns {object[]} All threads as an array. */
    getThreads() {
        return Array.from(this.threads.values());
    }

    /**
     * @param {string} threadId
     * @returns {object|null}
     */
    getThread(threadId) {
        return this.threads.get(threadId) ?? null;
    }
}
