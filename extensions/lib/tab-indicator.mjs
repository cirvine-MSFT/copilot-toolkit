// Shared tab indicator for watcher extensions.
// Sets the Windows Terminal tab title to 👀 while any watcher is active,
// and restores the previous title when all watchers finish.
//
// Uses xterm title-stack sequences (CSI 22;0 t / CSI 23;0 t) so the
// original title is saved and restored without us needing to read it.
// Requires Windows Terminal 1.12+ or any xterm-compatible emulator.

const stream = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
        ? process.stdout
        : null;

const activeWatchers = new Set();

function write(sequence) {
    stream?.write(sequence);
}

export function markWatching(watcherId) {
    if (activeWatchers.has(watcherId)) {
        return;
    }

    activeWatchers.add(watcherId);

    if (activeWatchers.size === 1) {
        write("\x1b[22;0t");     // push current title onto xterm stack
        write("\x1b]0;👀\x07");  // set tab title to eyes emoji
    }
}

export function unmarkWatching(watcherId) {
    if (!activeWatchers.has(watcherId)) {
        return;
    }

    activeWatchers.delete(watcherId);

    if (activeWatchers.size === 0) {
        write("\x1b[23;0t");     // pop saved title from xterm stack
    }
}

export function resetWatching() {
    if (activeWatchers.size > 0) {
        activeWatchers.clear();
        write("\x1b[23;0t");
    }
}
