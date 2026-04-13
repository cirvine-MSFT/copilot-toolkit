/**
 * WebSocket client with automatic reconnection and event dispatching.
 * Connects to ws(s)://<page-host>/ws and re-attempts on disconnect.
 */
export class WsClient {
    /** @type {Record<string, Function[]>} */
    #handlers = {};
    /** @type {WebSocket|null} */
    #ws = null;
    #reconnectTimer = null;
    #reconnectDelay = 2000;

    constructor() {
        this.connect();
    }

    connect() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws`;

        try {
            this.#ws = new WebSocket(url);
        } catch {
            this.#scheduleReconnect();
            return;
        }

        this.#ws.onopen = () => {
            this.emit('open');
            this.send({ type: 'status:connected' });
        };

        this.#ws.onclose = () => {
            this.emit('close');
            this.#scheduleReconnect();
        };

        this.#ws.onerror = () => {
            // onclose will fire after onerror — reconnect handled there
        };

        this.#ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                console.warn('[ws] non-JSON message received', event.data);
                return;
            }
            if (msg.type) {
                this.emit(msg.type, msg);
            }
        };
    }

    #scheduleReconnect() {
        if (!this.#reconnectTimer) {
            this.#reconnectTimer = setTimeout(() => this.connect(), this.#reconnectDelay);
        }
    }

    /**
     * Register an event handler.
     * @param {string} type
     * @param {Function} handler
     */
    on(type, handler) {
        (this.#handlers[type] ??= []).push(handler);
    }

    /**
     * Remove an event handler.
     * @param {string} type
     * @param {Function} handler
     */
    off(type, handler) {
        const list = this.#handlers[type];
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
    }

    /**
     * Emit an event to registered handlers.
     * @param {string} type
     * @param {*} data
     */
    emit(type, data) {
        const list = this.#handlers[type];
        if (!list) return;
        for (const fn of list) {
            try { fn(data); } catch (err) { console.error(`[ws] handler error for "${type}"`, err); }
        }
    }

    /**
     * Send a message to the server.
     * @param {object} data — will be JSON-stringified
     */
    send(data) {
        if (this.#ws?.readyState === WebSocket.OPEN) {
            this.#ws.send(JSON.stringify(data));
        }
    }

    /** Current connection state. */
    get connected() {
        return this.#ws?.readyState === WebSocket.OPEN;
    }
}
