import path from "node:path";

function normalizeWorkspacePath(workspacePath) {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) return null;
    return path.resolve(workspacePath);
}

export function isForegroundSession(foreground, currentSession) {
    if (!foreground || typeof foreground !== "object") return true;
    if (!foreground.sessionId && !foreground.workspacePath) return true;
    if (!currentSession) return false;
    if (foreground.sessionId && currentSession.sessionId && foreground.sessionId === currentSession.sessionId) {
        return true;
    }

    const foregroundWorkspace = normalizeWorkspacePath(foreground.workspacePath);
    const currentWorkspace = normalizeWorkspacePath(currentSession.workspacePath);
    return foregroundWorkspace !== null && foregroundWorkspace === currentWorkspace;
}
