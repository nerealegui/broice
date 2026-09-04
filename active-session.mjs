import path from "node:path";

function normalizeWorkspacePath(workspacePath) {
    if (typeof workspacePath !== "string" || !workspacePath.trim()) return null;
    return path.resolve(workspacePath);
}

export function isForegroundSession(foreground, currentSession) {
    if (!foreground?.sessionId) return true;
    if (!currentSession) return false;
    if (foreground.sessionId === currentSession.sessionId) return true;

    const foregroundWorkspace = normalizeWorkspacePath(foreground.workspacePath);
    const currentWorkspace = normalizeWorkspacePath(currentSession.workspacePath);
    return foregroundWorkspace !== null && foregroundWorkspace === currentWorkspace;
}
