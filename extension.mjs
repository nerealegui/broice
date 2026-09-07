// Extension: broice
// Local neural TTS extension for GitHub Copilot CLI, powered by Kokoro

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { isForegroundSession } from "./active-session.mjs";
import {
    createSpeechResponseBatcher,
    createVoiceCommands,
    createVoiceRuntimeState,
} from "./speech-response-batcher.mjs";
import { startAutoUpdater } from "./auto-updater.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BIN_DIR = path.join(__dirname, "bin");
const BOOTSTRAP_LOCK_DIR = path.join(BIN_DIR, ".bootstrap-lock");
const BOOTSTRAP_LOCK_OWNER = path.join(BOOTSTRAP_LOCK_DIR, "pid");
const VENV_DIR = path.join(BIN_DIR, "venv");
const PYTHON_PATH = path.join(VENV_DIR, "bin", "python");
const MODEL_PATH = path.join(BIN_DIR, "kokoro-v1.0.onnx");
const VOICES_PATH = path.join(BIN_DIR, "voices-v1.0.bin");
const SCRIPT_PATH = path.join(__dirname, "speak.py");
const CONFIG_PATH = path.join(__dirname, "config.json");
const UI_PATH = path.join(__dirname, "ui", "index.html");
const SKILLS_DIR = path.join(__dirname, "skills");
const PYTHON_CANDIDATES = ["python3.13", "python3.12", "python3.11", "python3.10", "python3"];

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

const DEFAULT_CONFIG = {
    voice: "af_sarah",
    speed: 1.0,
    lang: "en-us",
    auto_read: true,
    active_session_only: true,
    sample_phrase: "Bro, this is a test of your local neural voice."
};

const VOICES = new Set([
    "af_sarah",
    "af_bella",
    "af_nicole",
    "af_sky",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
]);

const DESKTOP_SKILLS = {
    voice: `---
name: voice
description: Open the Broice local voice settings dashboard.
user-invocable: true
---

# Broice voice dashboard

Immediately call \`open_canvas\` with canvasId \`broice-voice-settings\` and
instanceId \`broice-settings-panel\`. Do not invoke speech. Keep any confirmation
brief.
`,
    speak: `---
name: speak
description: Speak supplied text once with the local Broice Kokoro voice.
argument-hint: "<text>"
user-invocable: true
---

# Speak with Broice

Call the \`speak\` tool exactly once using the full text supplied after
\`/speak\`. Do not paraphrase or call any other speech tool. If no text was
provided, respond with \`Usage: /speak <text>\`.
`,
    stop: `---
name: stop
description: Stop Broice speech immediately.
user-invocable: true
---

# Stop Broice

Call the \`stop_speaking\` tool exactly once. Keep any confirmation brief.
`,
};

function ensureDesktopSkills() {
    for (const [name, contents] of Object.entries(DESKTOP_SKILLS)) {
        const skillDir = path.join(SKILLS_DIR, name);
        const skillPath = path.join(skillDir, "SKILL.md");
        if (fs.existsSync(skillPath)) continue;
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillPath, contents, "utf8");
    }
}

ensureDesktopSkills();

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return {
                ...DEFAULT_CONFIG,
                ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
            };
        }
    } catch (error) {
        process.stderr.write(`Broice could not read config.json: ${getErrorMessage(error)}\n`);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

let isReady = false;
let isBootstrapping = false;
const runtimeState = createVoiceRuntimeState(loadConfig());

function applyConfigPatch(patch) {
    const next = { ...loadConfig() };

    if (patch.voice !== undefined) {
        if (!VOICES.has(patch.voice)) throw new Error(`Unknown Broice voice: ${patch.voice}`);
        next.voice = patch.voice;
    }
    if (patch.speed !== undefined) {
        const speed = Number(patch.speed);
        if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.5) {
            throw new Error("Speed must be between 0.7 and 1.5.");
        }
        next.speed = speed;
    }
    if (patch.lang !== undefined) {
        if (patch.lang !== "en-us" && patch.lang !== "en-gb") {
            throw new Error("Language must be en-us or en-gb.");
        }
        next.lang = patch.lang;
    }
    for (const key of ["auto_read", "active_session_only"]) {
        if (patch[key] !== undefined) {
            if (typeof patch[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
            next[key] = patch[key];
        }
    }
    if (patch.sample_phrase !== undefined) {
        if (typeof patch.sample_phrase !== "string" || !patch.sample_phrase.trim()) {
            throw new Error("Sample phrase cannot be empty.");
        }
        next.sample_phrase = patch.sample_phrase.trim().slice(0, 1000);
    }

    saveConfig(next);
    runtimeState.publish({ config: next });
    return next;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

async function acquireBootstrapLock() {
    while (true) {
        try {
            fs.mkdirSync(BOOTSTRAP_LOCK_DIR);
            fs.writeFileSync(BOOTSTRAP_LOCK_OWNER, String(process.pid), "utf8");
            return;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;

            let ownerPid = null;
            try {
                ownerPid = Number.parseInt(fs.readFileSync(BOOTSTRAP_LOCK_OWNER, "utf8"), 10);
            } catch {}

            if (ownerPid !== null && !isProcessRunning(ownerPid)) {
                fs.rmSync(BOOTSTRAP_LOCK_DIR, { recursive: true, force: true });
                continue;
            }
            if (ownerPid === null) {
                const lockAge = Date.now() - fs.statSync(BOOTSTRAP_LOCK_DIR).mtimeMs;
                if (lockAge > 5000) {
                    fs.rmSync(BOOTSTRAP_LOCK_DIR, { recursive: true, force: true });
                    continue;
                }
            }
            await delay(250);
        }
    }
}

async function isSupportedPython(pythonPath) {
    try {
        const { stdout } = await execFileAsync(pythonPath, [
            "-c",
            "import sys; print(int((3, 10) <= sys.version_info[:2] < (3, 14)))"
        ]);
        return stdout.trim() === "1";
    } catch {
        return false;
    }
}

async function findCompatiblePython() {
    for (const candidate of PYTHON_CANDIDATES) {
        if (await isSupportedPython(candidate)) return candidate;
    }
    throw new Error("Broice requires Python 3.10 through 3.13. Install a compatible Python and reload the extension.");
}

async function hasPythonDependencies() {
    if (!fs.existsSync(PYTHON_PATH)) return false;

    try {
        await execFileAsync(PYTHON_PATH, [
            "-c",
            "import kokoro_onnx, soundfile, sounddevice"
        ]);
        return true;
    } catch {
        return false;
    }
}

async function bootstrap(session) {
    if (isReady || isBootstrapping) return;
    isBootstrapping = true;
    runtimeState.publish({
        phase: "setup",
        message: "Checking the local Kokoro voice runtime...",
        ready: false,
        speaking: false,
        error: null,
    });
    let ownsBootstrapLock = false;

    try {
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
        await acquireBootstrapLock();
        ownsBootstrapLock = true;

        const needsVenv = !fs.existsSync(PYTHON_PATH) || !(await isSupportedPython(PYTHON_PATH));
        const needsDependencies = needsVenv || !(await hasPythonDependencies());
        const needsModel = !fs.existsSync(MODEL_PATH) || !fs.existsSync(VOICES_PATH);

        if (needsDependencies || needsModel) {
            runtimeState.publish({
                phase: "setup",
                message: "Installing Kokoro dependencies and neural weights...",
            });
            await session.log("Setting up Broice dependencies and neural weights locally...", { level: "info" });

            if (needsVenv) {
                const python = await findCompatiblePython();
                await session.log(`Creating local Python virtual environment with ${python}...`, { ephemeral: true });
                fs.rmSync(VENV_DIR, { recursive: true, force: true });
                await execFileAsync(python, ["-m", "venv", VENV_DIR]);
            }

            if (needsDependencies) {
                await session.log("Installing Broice Python dependencies...", { ephemeral: true });
                await execFileAsync(PYTHON_PATH, ["-m", "pip", "install", "--upgrade", "pip"]);
                await execFileAsync(PYTHON_PATH, [
                    "-m", "pip",
                    "install", "--upgrade", "kokoro-onnx", "soundfile", "sounddevice"
                ]);
            }

            if (!fs.existsSync(MODEL_PATH)) {
                await session.log("Downloading the Broice speech model (~310MB)...", { ephemeral: true });
                await execFileAsync("curl", [
                    "-L", "-o", MODEL_PATH,
                    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
                ]);
            }

            if (!fs.existsSync(VOICES_PATH)) {
                await session.log("Downloading Broice voice data (~27MB)...", { ephemeral: true });
                await execFileAsync("curl", [
                    "-L", "-o", VOICES_PATH,
                    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
                ]);
            }

            await session.log("Broice setup complete and ready!");
        }

        isReady = true;
        runtimeState.publish({
            phase: "idle",
            message: "Local voice runtime is ready.",
            ready: true,
            speaking: false,
            error: null,
        });
    } catch (error) {
        runtimeState.publish({
            phase: "error",
            message: "Voice setup failed.",
            ready: false,
            speaking: false,
            error: getErrorMessage(error),
        });
        throw error;
    } finally {
        if (ownsBootstrapLock) {
            fs.rmSync(BOOTSTRAP_LOCK_DIR, { recursive: true, force: true });
        }
        isBootstrapping = false;
    }
}

function cleanMarkdownForSpeech(md) {
    if (!md) return "";
    return md
        // 1. Remove code blocks
        .replace(/```[\s\S]*?```/g, " [code snippet] ")
        // 2. Transform inline code `code` (expand dots, slashes, underscores, colons for clear speech)
        .replace(/`([^`]+)`/g, (match, code) => {
            let processed = code
                .replace(/\./g, " dot ")
                .replace(/\//g, " slash ")
                .replace(/\\/g, " slash ")
                .replace(/_/g, " ")
                .replace(/@/g, " at ")
                .replace(/:/g, " colon ")
                .replace(/~/g, "tilde")
                .replace(/\s+/g, " ")
                .trim();
            return ` ${processed} `;
        })
        // 3. Remove images and keep link text
        .replace(/!\[.*?\]\(.*?\)/g, "")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        // 4. Remove headings, blockquotes, table borders, bold/italic markers
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*>\s+/gm, "")
        .replace(/\|/g, " ")
        .replace(/^[-\s|:]+$/gm, "")
        .replace(/(\*\*|\*|__|_)(.*?)\1/g, "$2")
        .replace(/^[\s]*[-*+]\s+/gm, "")
        .replace(/^[\s]*\d+\.\s+/gm, "")
        // 5. Remove all emojis and variation selectors
        .replace(/[\uFE0E\uFE0F]/g, "")
        .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, "")
        // 6. Clean up spacing and punctuation glitches
        .replace(/[ \t]+/g, " ")
        .replace(/\s+([.,!?;:])/g, "$1")
        .replace(/\n\s*\n/g, "\n")
        .trim();
}

let activeSpeechChild = null;
const expectedSpeechStops = new WeakSet();
let activeSessionMonitor = null;
let activeSessionCheckInFlight = false;
let foregroundCheckWarningLogged = false;

function stopActiveSessionMonitor() {
    if (activeSessionMonitor) {
        clearInterval(activeSessionMonitor);
        activeSessionMonitor = null;
    }
    activeSessionCheckInFlight = false;
}

function stopSpeech(statusMessage = "Speech stopped.") {
    stopActiveSessionMonitor();
    if (activeSpeechChild) {
        try {
            expectedSpeechStops.add(activeSpeechChild);
            activeSpeechChild.kill("SIGTERM");
        } catch (error) {
            runtimeState.publish({
                phase: "error",
                message: "Could not stop speech.",
                speaking: false,
                error: getErrorMessage(error),
            });
            throw error;
        }
        activeSpeechChild = null;
        runtimeState.publish({
            phase: "idle",
            message: statusMessage,
            speaking: false,
            error: null,
        });
        return true;
    }
    return false;
}

async function isCurrentSessionForeground() {
    try {
        const response = await session.connection.sendRequest("session.getForeground", {});
        return isForegroundSession(response, session);
    } catch (error) {
        if (!foregroundCheckWarningLogged) {
            foregroundCheckWarningLogged = true;
            process.stderr.write(
                `Broice could not determine the active Copilot session; speech was suppressed: ${getErrorMessage(error)}\n`
            );
        }
        return false;
    }
}

function monitorActiveSession() {
    stopActiveSessionMonitor();
    activeSessionMonitor = setInterval(async () => {
        if (!activeSpeechChild || activeSessionCheckInFlight) return;
        activeSessionCheckInFlight = true;
        try {
            if (!await isCurrentSessionForeground()) {
                stopSpeech();
            }
        } finally {
            activeSessionCheckInFlight = false;
        }
    }, 750);
    activeSessionMonitor.unref?.();
}

async function speakText(
    text,
    voiceOverride = null,
    speedOverride = null,
    langOverride = null,
    activeSessionOnly = false
) {
    if (!isReady) {
        throw new Error("Broice speech is not ready. Check the extension log for bootstrap errors.");
    }
    if (activeSessionOnly && !await isCurrentSessionForeground()) {
        runtimeState.publish({
            phase: "idle",
            message: "Speech skipped because this session is not currently shown.",
            speaking: false,
            error: null,
        });
        return false;
    }
    stopSpeech();

    const config = loadConfig();
    const voice = voiceOverride || config.voice || "af_sarah";
    const speed = speedOverride !== null && speedOverride !== undefined ? speedOverride : (config.speed || 1.0);
    const lang = langOverride || config.lang || "en-us";

    const cleaned = cleanMarkdownForSpeech(text);
    if (!cleaned) return false;

    runtimeState.publish({
        phase: "speaking",
        message: `Speaking with ${voice} at ${Number(speed).toFixed(2)}x.`,
        speaking: true,
        error: null,
    });

    return new Promise((resolve, reject) => {
        const child = execFile(PYTHON_PATH, [
            SCRIPT_PATH,
            cleaned,
            "--voice", voice,
            "--speed", speed.toString(),
            "--lang", lang,
            "--model-dir", BIN_DIR
        ], (err) => {
            if (activeSpeechChild === child) {
                activeSpeechChild = null;
                stopActiveSessionMonitor();
            }
            if (expectedSpeechStops.delete(child)) {
                resolve(false);
                return;
            }
            if (err) {
                runtimeState.publish({
                    phase: "error",
                    message: "Speech playback failed.",
                    speaking: false,
                    error: getErrorMessage(err),
                });
                reject(err);
                return;
            }
            runtimeState.publish({
                phase: "idle",
                message: "Playback complete.",
                speaking: false,
                error: null,
            });
            resolve(true);
        });
        activeSpeechChild = child;
        if (activeSessionOnly) monitorActiveSession();
    });
}

const finalResponseBatcher = createSpeechResponseBatcher({
    speak: async (content) => {
        const config = loadConfig();
        return speakText(content, null, null, null, config.active_session_only);
    },
    shouldAutoRead: () => loadConfig().auto_read !== false,
});

function stopAutoReadAndPlayback() {
    const discardedPending = finalResponseBatcher.suppressInteraction();
    return stopSpeech() || discardedPending;
}

function writeJson(res, statusCode, body) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 32_768) {
                reject(new Error("Request body is too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error(`Invalid JSON: ${getErrorMessage(error)}`));
            }
        });
        req.on("error", reject);
    });
}

function sendStateEvent(res, state) {
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

let serverPort = null;

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
        });
        if (fs.existsSync(UI_PATH)) {
            res.end(fs.readFileSync(UI_PATH, "utf8"));
        } else {
            res.end("<h1>Broice settings UI not found</h1>");
        }
    } else if (req.method === "GET" && req.url === "/api/state") {
        writeJson(res, 200, runtimeState.getSnapshot());
    } else if (req.method === "GET" && req.url === "/api/events") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        sendStateEvent(res, runtimeState.getSnapshot());
        const unsubscribe = runtimeState.subscribe((state) => sendStateEvent(res, state));
        req.on("close", unsubscribe);
    } else if (req.method === "GET" && req.url === "/api/config") {
        writeJson(res, 200, loadConfig());
    } else if (req.method === "POST" && req.url === "/api/config") {
        void readJson(req).then((updated) => {
            try {
                const config = applyConfigPatch(updated);
                writeJson(res, 200, { success: true, config });
            } catch (error) {
                writeJson(res, 400, { error: getErrorMessage(error) });
            }
        }).catch((error) => {
            writeJson(res, 400, { error: getErrorMessage(error) });
        });
    } else if (req.method === "POST" && req.url === "/api/stop-speech") {
        const stopped = stopAutoReadAndPlayback();
        if (!stopped) {
            runtimeState.publish({
                phase: "idle",
                message: "Broice is already idle.",
                speaking: false,
                error: null,
            });
        }
        writeJson(res, 200, { success: true, stopped });
    } else if (req.method === "POST" && req.url === "/api/test-speech") {
        void readJson(req).then(async ({ text, voice, speed }) => {
            try {
                await speakText(text || "Hello!", voice, speed);
                writeJson(res, 200, { success: true });
            } catch (error) {
                writeJson(res, 500, { error: getErrorMessage(error) });
            }
        }).catch((error) => {
            writeJson(res, 400, { error: getErrorMessage(error) });
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

const serverReady = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        serverPort = server.address().port;
        resolve();
    });
});

const voiceSettingsCanvas = createCanvas({
    id: "broice-voice-settings",
    displayName: "Voice Settings",
    description: "Visual panel to configure Broice voices, speed, and auto-reading preferences.",
    actions: [
        {
            name: "get_state",
            description: "Get Broice setup, playback, voice configuration, and registered command state.",
            handler: async () => {
                const [{ commands }, { commands: desktopCommands }] = await Promise.all([
                    session.rpc.commands.list({
                        includeBuiltins: false,
                        includeSkills: false,
                        includeClientCommands: true,
                    }),
                    session.rpc.commands.list({
                        includeBuiltins: false,
                        includeSkills: true,
                        includeClientCommands: false,
                    }),
                ]);
                return {
                    ...runtimeState.getSnapshot(),
                    registered_commands: commands
                        .filter(({ name }) => ["voice", "speak", "stop"].includes(name))
                        .map(({ name, description, kind }) => ({ name, description, kind })),
                    desktop_commands: desktopCommands
                        .filter(({ name }) => ["voice", "speak", "stop"].includes(name))
                        .map(({ name, description, kind }) => ({ name, description, kind })),
                };
            },
        },
        {
            name: "update_settings",
            description: "Update Broice voice, speed, auto-read, active-session, language, or sample phrase settings.",
            inputSchema: {
                type: "object",
                properties: {
                    voice: { type: "string" },
                    speed: { type: "number", minimum: 0.7, maximum: 1.5 },
                    lang: { type: "string", enum: ["en-us", "en-gb"] },
                    auto_read: { type: "boolean" },
                    active_session_only: { type: "boolean" },
                    sample_phrase: { type: "string", minLength: 1, maxLength: 1000 },
                },
                additionalProperties: false,
            },
            handler: ({ input }) => ({ config: applyConfigPatch(input) }),
        },
        {
            name: "preview",
            description: "Preview text with the selected Broice voice and speed.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", minLength: 1 },
                    voice: { type: "string", enum: [...VOICES] },
                    speed: { type: "number", minimum: 0.7, maximum: 1.5 },
                },
                required: ["text"],
                additionalProperties: false,
            },
            handler: async ({ input }) => ({
                spoken: await speakText(input.text, input.voice, input.speed),
            }),
        },
        {
            name: "stop",
            description: "Stop current Broice speech and suppress pending auto-read.",
            handler: () => ({ stopped: stopAutoReadAndPlayback() }),
        },
    ],
    open: async () => {
        await serverReady;
        return {
            url: `http://127.0.0.1:${serverPort}`,
            title: "Broice Voice Settings",
            status: runtimeState.getSnapshot().phase,
        };
    }
});

let session;
session = await joinSession({
    canvases: [voiceSettingsCanvas],
    skillDirectories: [SKILLS_DIR],
    enableSkills: true,
    commands: createVoiceCommands({
        openVoiceSettings: () => session.rpc.canvas.open({
            canvasId: "broice-voice-settings",
            instanceId: "broice-settings-panel",
        }),
        speak: async (text) => {
            const cfg = loadConfig();
            await speakText(text, null, null, null, cfg.active_session_only);
        },
        stop: stopSpeech,
        suppressAutoRead: () => finalResponseBatcher.suppressInteraction(),
        log: (message, options) => session.log(message, options),
    }),
    tools: [
        {
            name: "speak",
            description: "Speak text out loud using Broice's local neural voice model on your Mac.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "The text to speak out loud." },
                    voice: { type: "string", description: "Voice ID (e.g. af_sarah, af_bella, am_adam, bf_emma, bm_george)" },
                    speed: { type: "number", description: "Playback speed (0.8 - 1.5, default 1.0)" },
                    lang: { type: "string", description: "Language code (default: en-us)" },
                },
                required: ["text"],
            },
            skipPermission: true,
            handler: async (args) => {
                finalResponseBatcher.suppressInteraction();
                const cfg = loadConfig();
                const spoken = await speakText(
                    args.text,
                    args.voice,
                    args.speed,
                    args.lang,
                    cfg.active_session_only
                );
                return spoken
                    ? "Spoken successfully."
                    : "Speech skipped because this is not the active session.";
            },
        },
        {
            name: "stop_speaking",
            description: "Immediately stop any currently active speech synthesis or audio playback.",
            parameters: {
                type: "object",
                properties: {},
            },
            skipPermission: true,
            handler: async () => {
                const stopped = stopAutoReadAndPlayback();
                return stopped ? "Speech playback stopped." : "No active speech was playing.";
            },
        },
        {
            name: "configure_voice",
            description: "Set Broice voice settings (voice selection, speed, language, or toggle auto-reading).",
            parameters: {
                type: "object",
                properties: {
                    voice: { type: "string", description: "Default voice: af_sarah, af_bella, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis" },
                    speed: { type: "number", description: "Playback speed (0.8 - 1.5, default: 1.0)" },
                    lang: { type: "string", description: "Language code ('en-us', 'en-gb')" },
                    auto_read: { type: "boolean", description: "Enable or disable automatic reading of assistant messages." },
                    active_session_only: { type: "boolean", description: "Only speak when this session is currently shown in Copilot." },
                },
            },
            skipPermission: true,
            handler: async (args) => {
                const cfg = applyConfigPatch(args);
                await session.log(`Voice updated: Voice=${cfg.voice}, Speed=${cfg.speed}, Auto-Read=${cfg.auto_read}, Active-Session-Only=${cfg.active_session_only}`);
                return `Voice configuration updated:\n${JSON.stringify(cfg, null, 2)}`;
            },
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await bootstrap(session);
        },
        onUserPromptSubmitted: async (input) => {
            stopSpeech();
            finalResponseBatcher.beginInteraction();
            const text = input.prompt.trim().toLowerCase();
            if (text === "/quiet" || text === "/silence" || text === "/shh" || text === "/cancel") {
                finalResponseBatcher.suppressInteraction();
                return {
                    additionalContext: "The user commanded to stop voice playback. Confirm briefly that audio has been stopped."
                };
            }
            if (text === "/tts" || text === "/voices" || text === "voice settings" || text === "voice canvas") {
                return {
                    additionalContext: "The user triggered the voice settings shortcut. Immediately invoke open_canvas with canvasId: 'broice-voice-settings', instanceId: 'broice-settings-panel' and confirm to the user."
                };
            }
        },
    },
});

startAutoUpdater();

void bootstrap(session).catch((error) => {
    process.stderr.write(`Broice bootstrap failed: ${getErrorMessage(error)}\n`);
});

session.on("assistant.message", async (event) => {
    finalResponseBatcher.queueAssistantMessage(event);
});

session.on("session.idle", async (event) => {
    try {
        await finalResponseBatcher.finishInteraction(event);
    } catch (error) {
        process.stderr.write(`Broice speech playback failed: ${getErrorMessage(error)}\n`);
    }
});

session.on("session.error", () => {
    finalResponseBatcher.suppressInteraction();
});
