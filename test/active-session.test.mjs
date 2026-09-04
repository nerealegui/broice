import assert from "node:assert/strict";
import test from "node:test";
import { isForegroundSession } from "../active-session.mjs";

test("matches the foreground session by SDK session ID", () => {
    assert.equal(
        isForegroundSession(
            { sessionId: "session-1" },
            { sessionId: "session-1", workspacePath: "/tmp/session-1" }
        ),
        true
    );
});

test("matches desktop session aliases by workspace path", () => {
    assert.equal(
        isForegroundSession(
            { sessionId: "workspace-1", workspacePath: "/tmp/session-1/" },
            { sessionId: "session-1", workspacePath: "/tmp/session-1" }
        ),
        true
    );
});

test("rejects a different foreground session", () => {
    assert.equal(
        isForegroundSession(
            { sessionId: "session-2", workspacePath: "/tmp/session-2" },
            { sessionId: "session-1", workspacePath: "/tmp/session-1" }
        ),
        false
    );
});

test("allows speech when the host cannot report a foreground session", () => {
    assert.equal(
        isForegroundSession(
            {},
            { sessionId: "session-1" }
        ),
        true
    );
});
