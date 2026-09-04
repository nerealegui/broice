import assert from "node:assert/strict";
import test from "node:test";

import { createSpeechResponseBatcher } from "../speech-response-batcher.mjs";

function createHarness(autoRead = true) {
    const spoken = [];
    const batcher = createSpeechResponseBatcher({
        speak: async (content) => spoken.push(content),
        shouldAutoRead: () => autoRead,
    });
    return { batcher, spoken };
}

test("speaks only the final response after a tool-using interaction becomes idle", async () => {
    const { batcher, spoken } = createHarness();

    batcher.beginInteraction();
    batcher.queueAssistantMessage({
        data: {
            content: "I will inspect the repository.",
            toolRequests: [{ toolCallId: "tool-1" }],
        },
    });
    batcher.queueAssistantMessage({
        data: { content: "The final answer.", toolRequests: [] },
    });

    assert.deepEqual(spoken, []);
    assert.equal(await batcher.finishInteraction({ data: { aborted: false } }), true);
    assert.deepEqual(spoken, ["The final answer."]);
    assert.equal(await batcher.finishInteraction({ data: { aborted: false } }), false);
});

test("does not speak tool commentary when no final response follows", async () => {
    const { batcher, spoken } = createHarness();

    batcher.beginInteraction();
    batcher.queueAssistantMessage({
        data: {
            content: "I will run a tool.",
            toolRequests: [{ toolCallId: "tool-1" }],
        },
    });

    assert.equal(await batcher.finishInteraction({ data: { aborted: false } }), false);
    assert.deepEqual(spoken, []);
});

test("a new user prompt discards the previous interaction's pending response", async () => {
    const { batcher, spoken } = createHarness();

    batcher.beginInteraction();
    batcher.queueAssistantMessage({ data: { content: "Old response." } });
    assert.equal(batcher.beginInteraction(), true);
    batcher.queueAssistantMessage({ data: { content: "New response." } });

    await batcher.finishInteraction({ data: { aborted: false } });
    assert.deepEqual(spoken, ["New response."]);
});

test("manual stop suppresses pending auto-read until the next prompt", async () => {
    const { batcher, spoken } = createHarness();

    batcher.beginInteraction();
    batcher.queueAssistantMessage({ data: { content: "Do not speak this." } });
    assert.equal(batcher.suppressInteraction(), true);
    assert.equal(await batcher.finishInteraction({ data: { aborted: false } }), false);

    batcher.beginInteraction();
    batcher.queueAssistantMessage({ data: { content: "Speak this." } });
    assert.equal(await batcher.finishInteraction({ data: { aborted: false } }), true);
    assert.deepEqual(spoken, ["Speak this."]);
});

test("does not speak aborted or auto-read-disabled interactions", async () => {
    const disabled = createHarness(false);
    disabled.batcher.beginInteraction();
    disabled.batcher.queueAssistantMessage({ data: { content: "Disabled." } });
    assert.equal(
        await disabled.batcher.finishInteraction({ data: { aborted: false } }),
        false,
    );

    const aborted = createHarness();
    aborted.batcher.beginInteraction();
    aborted.batcher.queueAssistantMessage({ data: { content: "Aborted." } });
    assert.equal(
        await aborted.batcher.finishInteraction({ data: { aborted: true } }),
        false,
    );

    assert.deepEqual(disabled.spoken, []);
    assert.deepEqual(aborted.spoken, []);
});
