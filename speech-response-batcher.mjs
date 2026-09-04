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
