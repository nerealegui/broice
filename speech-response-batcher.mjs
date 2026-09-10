export function createSpeechResponseBatcher({ speak, shouldAutoRead }) {
    let pendingContent = null;
    let suppressed = false;

    return {
        beginInteraction() {
            const discardedPending = pendingContent !== null;
            pendingContent = null;
            suppressed = false;
            return discardedPending;
        },

        queueAssistantMessage(event) {
            const data = event?.data;
            if (!data || typeof data.content !== "string" || !data.content.trim()) {
                return false;
            }

            if (Array.isArray(data.toolRequests) && data.toolRequests.length > 0) {
                pendingContent = null;
                return false;
            }

            pendingContent = data.content;
            return true;
        },

        suppressInteraction() {
            const discardedPending = pendingContent !== null;
            pendingContent = null;
            suppressed = true;
            return discardedPending;
        },

        async finishInteraction(event) {
            const content = pendingContent;
            pendingContent = null;

            if (
                !content ||
                suppressed ||
                event?.data?.aborted === true ||
                shouldAutoRead() === false
            ) {
                return false;
            }

            await speak(content);
            return true;
        },
    };
}

export function createVoiceRuntimeState(initialConfig) {
    let snapshot = {
        phase: "setup",
        message: "Preparing local voice runtime...",
        ready: false,
        speaking: false,
        error: null,
        config: { ...initialConfig },
        updated_at: new Date().toISOString(),
    };
    const listeners = new Set();

    function publish(patch) {
        snapshot = {
            ...snapshot,
            ...patch,
            config: patch.config ? { ...patch.config } : snapshot.config,
            updated_at: new Date().toISOString(),
        };
        for (const listener of listeners) {
            listener({
                ...snapshot,
                config: { ...snapshot.config },
            });
        }
        return snapshot;
    }

    return {
        getSnapshot() {
            return {
                ...snapshot,
                config: { ...snapshot.config },
            };
        },
        publish,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export function createVoiceCommands({
    openVoiceSettings,
    speak,
    stop,
    suppressAutoRead,
    log,
}) {
    return [
        {
            name: "voice",
            description: "Open the Broice voice settings dashboard.",
            handler: async () => {
                suppressAutoRead();
                await openVoiceSettings();
            },
        },
        {
            name: "speak",
            description: "Speak the text after the command with Broice.",
            handler: async ({ args }) => {
                suppressAutoRead();
                const text = args.trim();
                if (!text) {
                    await log("Usage: /speak <text>", { level: "warning" });
                    return;
                }
                await speak(text);
            },
        },
        {
            name: "stop",
            description: "Stop Broice speech immediately.",
            handler: async () => {
                suppressAutoRead();
                const stopped = stop();
                await log(stopped ? "Broice speech stopped." : "Broice is already idle.", {
                    ephemeral: true,
                });
            },
        },
    ];
}
