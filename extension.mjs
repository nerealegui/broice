// Extension: broice
// Local neural TTS extension for GitHub Copilot CLI, powered by Kokoro

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createSpeechResponseBatcher } from "./speech-response-batcher.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BIN_DIR = path.join(__dirname, "bin");
const VENV_DIR = path.join(BIN_DIR, "venv");
const PYTHON_PATH = path.join(VENV_DIR, "bin", "python");
const MODEL_PATH = path.join(BIN_DIR, "kokoro-v1.0.onnx");
const VOICES_PATH = path.join(BIN_DIR, "voices-v1.0.bin");
const SCRIPT_PATH = path.join(__dirname, "speak.py");
const CONFIG_PATH = path.join(__dirname, "config.json");
const UI_PATH = path.join(__dirname, "ui", "index.html");
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

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return {
                ...DEFAULT_CONFIG,
                ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
            };
        }
    } catch (e) {}
    return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    } catch (e) {}
}

let isReady = false;
let isBootstrapping = false;

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

    try {
        if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

        const needsVenv = !fs.existsSync(PYTHON_PATH) || !(await isSupportedPython(PYTHON_PATH));
        const needsDependencies = needsVenv || !(await hasPythonDependencies());
        const needsModel = !fs.existsSync(MODEL_PATH) || !fs.existsSync(VOICES_PATH);

        if (needsDependencies || needsModel) {
            await session.log("Setting up Broice dependencies and neural weights locally...", { level: "info" });

            if (needsVenv) {
                const python = await findCompatiblePython();
                await session.log(`Creating local Python virtual environment with ${python}...`, { ephemeral: true });
                fs.rmSync(VENV_DIR, { recursive: true, force: true });
                await execFileAsync(python, ["-m", "venv", VENV_DIR]);
            }

            if (needsDependencies) {
                await session.log("Installing Broice Python dependencies...", { ephemeral: true });
                const pipPath = path.join(VENV_DIR, "bin", "pip");
                await execFileAsync(pipPath, ["install", "--upgrade", "pip"]);
                await execFileAsync(pipPath, [
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
    } finally {
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

function stopSpeech() {
    stopActiveSessionMonitor();
    if (activeSpeechChild) {
        try {
            expectedSpeechStops.add(activeSpeechChild);
            activeSpeechChild.kill("SIGTERM");
        } catch (e) {}
        activeSpeechChild = null;
        return true;
    }
    return false;
}

async function isCurrentSessionForeground() {
    try {
        // joinSession hides its client, but the session retains the shared RPC connection.
        const response = await session.connection.sendRequest("session.getForeground", {});
        return response?.sessionId === session.sessionId;
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
    if (activeSessionOnly && !await isCurrentSessionForeground()) return false;
    stopSpeech();

    const config = loadConfig();
    const voice = voiceOverride || config.voice || "af_sarah";
    const speed = speedOverride !== null && speedOverride !== undefined ? speedOverride : (config.speed || 1.0);
    const lang = langOverride || config.lang || "en-us";

    const cleaned = cleanMarkdownForSpeech(text);
    if (!cleaned) return false;

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
                reject(err);
                return;
            }
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

let serverPort = 49215;

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        if (fs.existsSync(UI_PATH)) {
            res.end(fs.readFileSync(UI_PATH, "utf8"));
        } else {
            res.end("<h1>Broice settings UI not found</h1>");
        }
    } else if (req.method === "GET" && req.url === "/api/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(loadConfig()));
    } else if (req.method === "POST" && req.url === "/api/config") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const updated = JSON.parse(body);
                const current = loadConfig();
                Object.assign(current, updated);
                saveConfig(current);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else if (req.method === "POST" && req.url === "/api/stop-speech") {
        const stopped = stopAutoReadAndPlayback();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, stopped }));
    } else if (req.method === "POST" && req.url === "/api/test-speech") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const { text, voice, speed } = JSON.parse(body);
                await speakText(text || "Hello!", voice, speed);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(0, "127.0.0.1", () => {
    serverPort = server.address().port;
});

const voiceSettingsCanvas = createCanvas({
    id: "broice-voice-settings",
    displayName: "Voice Settings",
    description: "Visual panel to configure Broice voices, speed, and auto-reading preferences.",
    open: (ctx) => {
        return {
            url: `http://127.0.0.1:${serverPort}`,
            title: "Broice Voice Settings",
            status: "ready"
        };
    }
});

const session = await joinSession({
    canvases: [voiceSettingsCanvas],
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
                const cfg = loadConfig();
                if (args.voice !== undefined) cfg.voice = args.voice;
                if (args.speed !== undefined) cfg.speed = args.speed;
                if (args.lang !== undefined) cfg.lang = args.lang;
                if (args.auto_read !== undefined) cfg.auto_read = args.auto_read;
                if (args.active_session_only !== undefined) cfg.active_session_only = args.active_session_only;
                saveConfig(cfg);
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
            if (text === "/stop" || text === "/quiet" || text === "/silence" || text === "/shh" || text === "/cancel") {
                finalResponseBatcher.suppressInteraction();
                return {
                    additionalContext: "The user commanded to stop voice playback. Confirm briefly that audio has been stopped."
                };
            }
            if (text === "/voice" || text === "/tts" || text === "/voices" || text === "voice settings" || text === "voice canvas") {
                return {
                    additionalContext: "The user triggered the voice settings shortcut. Immediately invoke open_canvas with canvasId: 'broice-voice-settings', instanceId: 'broice-settings-panel' and confirm to the user."
                };
            }
        },
    },
});

void bootstrap(session).catch((error) => {
    console.error(`Broice bootstrap failed: ${getErrorMessage(error)}`);
});

session.on("assistant.message", async (event) => {
    finalResponseBatcher.queueAssistantMessage(event);
});

session.on("session.idle", async (event) => {
    try {
        await finalResponseBatcher.finishInteraction(event);
    } catch (error) {
        console.error(`Broice speech playback failed: ${getErrorMessage(error)}`);
    }
});

session.on("session.error", () => {
    finalResponseBatcher.suppressInteraction();
});
