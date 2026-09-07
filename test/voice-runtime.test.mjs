import assert from "node:assert/strict";
import test from "node:test";

import {
    createVoiceCommands,
    createVoiceRuntimeState,
} from "../speech-response-batcher.mjs";

test("runtime state publishes immutable live snapshots", () => {
    const state = createVoiceRuntimeState({ voice: "af_sarah", speed: 1 });
    const updates = [];
    const unsubscribe = state.subscribe((snapshot) => updates.push(snapshot));

    state.publish({
        phase: "speaking",
        message: "Speaking.",
        speaking: true,
        config: { voice: "bf_emma", speed: 1.1 },
    });
    unsubscribe();
    state.publish({ phase: "idle", speaking: false });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].phase, "speaking");
    assert.deepEqual(updates[0].config, { voice: "bf_emma", speed: 1.1 });

    const snapshot = state.getSnapshot();
    snapshot.config.voice = "mutated";
    assert.equal(state.getSnapshot().config.voice, "bf_emma");
});

test("voice commands are discoverable and open the dashboard directly", async () => {
    const calls = [];
    const commands = createVoiceCommands({
        openVoiceSettings: async () => calls.push("open"),
        speak: async (text) => calls.push(["speak", text]),
        stop: () => {
            calls.push("stop");
            return true;
        },
        suppressAutoRead: () => calls.push("suppress"),
        log: async (message) => calls.push(["log", message]),
    });

    assert.deepEqual(commands.map(({ name }) => name), ["voice", "speak", "stop"]);
    assert.ok(commands.every(({ description }) => description.length > 0));

    await commands[0].handler({ args: "" });
    assert.deepEqual(calls, ["suppress", "open"]);
});

test("/speak suppresses pending auto-read and speaks exactly once", async () => {
    const spoken = [];
    let suppressions = 0;
    const commands = createVoiceCommands({
        openVoiceSettings: async () => {},
        speak: async (text) => spoken.push(text),
        stop: () => false,
        suppressAutoRead: () => suppressions++,
        log: async () => {},
    });

    await commands[1].handler({ args: "  Read this once.  " });

    assert.equal(suppressions, 1);
    assert.deepEqual(spoken, ["Read this once."]);
});

test("/speak without text shows usage and /stop cancels without model output", async () => {
    const logs = [];
    let stops = 0;
    let suppressions = 0;
    const commands = createVoiceCommands({
        openVoiceSettings: async () => {},
        speak: async () => assert.fail("empty /speak should not start speech"),
        stop: () => {
            stops++;
            return true;
        },
        suppressAutoRead: () => suppressions++,
        log: async (message, options) => logs.push({ message, options }),
    });

    await commands[1].handler({ args: " " });
    await commands[2].handler({ args: "" });

    assert.equal(suppressions, 2);
    assert.equal(stops, 1);
    assert.match(logs[0].message, /Usage: \/speak/);
    assert.equal(logs[0].options.level, "warning");
    assert.equal(logs[1].message, "Broice speech stopped.");
});

test("dashboard uses host theme tokens and server-sent state events", async () => {
    const html = await import("node:fs/promises").then(({ readFile }) =>
        readFile(new URL("../ui/index.html", import.meta.url), "utf8")
    );

    assert.match(html, /--background-color-default/);
    assert.match(html, /--border-color-default/);
    assert.match(html, /--text-color-default/);
    assert.match(html, /--color-focus-outline/);
    assert.match(html, /new EventSource\("\/api\/events"\)/);
    assert.match(html, /id="active-session-only"/);
    assert.match(html, /id="sample-phrase"/);
});

test("desktop skill adapters expose the voice command suite", async () => {
    const { readFile } = await import("node:fs/promises");
    const skills = await Promise.all(
        ["voice", "speak", "stop"].map((name) =>
            readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8")
        )
    );

    for (const [index, name] of ["voice", "speak", "stop"].entries()) {
        assert.match(skills[index], new RegExp(`name: ${name}`));
        assert.match(skills[index], /user-invocable: true/);
        assert.match(skills[index], /description: .+/);
    }
    assert.match(skills[0], /open_canvas/);
    assert.match(skills[1], /Call the `speak` tool exactly once/);
    assert.match(skills[2], /Call the `stop_speaking` tool exactly once/);
});
