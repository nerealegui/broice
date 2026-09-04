// Extension: kokoro-tts
// Local Kokoro neural TTS extension for GitHub Copilot CLI

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

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

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        }
    } catch (e) {}
    return { voice: "af_sarah", speed: 1.0, lang: "en-us", auto_read: true };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    } catch (e) {}
}

let isReady = false;
let isBootstrapping = false;

async function bootstrap(session) {
    if (isReady || isBootstrapping) return;
    isBootstrapping = true;

    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

    const needsVenv = !fs.existsSync(PYTHON_PATH);
    const needsModel = !fs.existsSync(MODEL_PATH) || !fs.existsSync(VOICES_PATH);

    if (needsVenv || needsModel) {
        await session.log("Setting up Kokoro TTS dependencies & neural weights locally...", { level: "info" });
        
        if (needsVenv) {
            await session.log("Creating local Python virtual environment...", { ephemeral: true });
            await execFileAsync("python3", ["-m", "venv", VENV_DIR]);
            await execFileAsync(path.join(VENV_DIR, "bin", "pip"), [
                "install", "--upgrade", "pip", "kokoro-onnx", "soundfile", "sounddevice"
            ]);
        }

        if (!fs.existsSync(MODEL_PATH)) {
            await session.log("Downloading Kokoro v1.0 ONNX neural model (~310MB)...", { ephemeral: true });
            await execFileAsync("curl", [
                "-L", "-o", MODEL_PATH,
                "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
            ]);
        }

        if (!fs.existsSync(VOICES_PATH)) {
            await session.log("Downloading Kokoro voice embeddings (~27MB)...", { ephemeral: true });
            await execFileAsync("curl", [
                "-L", "-o", VOICES_PATH,
                "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
            ]);
        }

        await session.log("Kokoro TTS setup complete and ready!");
    }

    isReady = true;
    isBootstrapping = false;
}

function cleanMarkdownForSpeech(md) {
    if (!md) return "";
    return md
        .replace(/```[\s\S]*?```/g, " [code snippet] ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/!\[.*?\]\(.*?\)/g, "")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*>\s+/gm, "")
        .replace(/\|/g, " ")
        .replace(/^[-\s|:]+$/gm, "")
        .replace(/(\*\*|\*|__|_)(.*?)\1/g, "$2")
        .replace(/^[\s]*[-*+]\s+/gm, "")
        .replace(/^[\s]*\d+\.\s+/gm, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
}

async function speakText(text, voiceOverride = null, speedOverride = null, langOverride = null) {
    if (!isReady) return;
    const config = loadConfig();
    const voice = voiceOverride || config.voice || "af_sarah";
    const speed = speedOverride !== null && speedOverride !== undefined ? speedOverride : (config.speed || 1.0);
    const lang = langOverride || config.lang || "en-us";

    const cleaned = cleanMarkdownForSpeech(text);
    if (!cleaned) return;

    try {
        await execFileAsync(PYTHON_PATH, [
            SCRIPT_PATH,
            cleaned,
            "--voice", voice,
            "--speed", speed.toString(),
            "--lang", lang,
            "--model-dir", BIN_DIR
        ]);
    } catch (err) {}
}

let serverPort = 49215;

const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        if (fs.existsSync(UI_PATH)) {
            res.end(fs.readFileSync(UI_PATH, "utf8"));
        } else {
            res.end("<h1>Kokoro Settings UI not found</h1>");
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
    id: "kokoro-voice-settings",
    displayName: "Voice Settings",
    description: "Visual panel to configure Kokoro TTS voices, speed, and auto-reading preferences.",
    open: (ctx) => {
        return {
            url: `http://127.0.0.1:${serverPort}`,
            title: "🎙️ Kokoro Voice Settings",
            status: "ready"
        };
    }
});

const session = await joinSession({
    canvases: [voiceSettingsCanvas],
    tools: [
        {
            name: "speak",
            description: "Speak text out loud using the local Kokoro neural TTS model on your Mac.",
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
                await speakText(args.text, args.voice, args.speed, args.lang);
                return "Spoken successfully.";
            },
        },
        {
            name: "configure_voice",
            description: "Set voice settings for Kokoro TTS (voice selection, speed, language, or toggle auto-reading).",
            parameters: {
                type: "object",
                properties: {
                    voice: { type: "string", description: "Default voice: af_sarah, af_bella, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis" },
                    speed: { type: "number", description: "Playback speed (0.8 - 1.5, default: 1.0)" },
                    lang: { type: "string", description: "Language code ('en-us', 'en-gb')" },
                    auto_read: { type: "boolean", description: "Enable or disable automatic reading of assistant messages." },
                },
            },
            skipPermission: true,
            handler: async (args) => {
                const cfg = loadConfig();
                if (args.voice !== undefined) cfg.voice = args.voice;
                if (args.speed !== undefined) cfg.speed = args.speed;
                if (args.lang !== undefined) cfg.lang = args.lang;
                if (args.auto_read !== undefined) cfg.auto_read = args.auto_read;
                saveConfig(cfg);
                await session.log(`Voice updated: Voice=${cfg.voice}, Speed=${cfg.speed}, Auto-Read=${cfg.auto_read}`);
                return `Voice configuration updated:\n${JSON.stringify(cfg, null, 2)}`;
            },
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await bootstrap(session);
        },
        onUserPromptSubmitted: async (input) => {
            const text = input.prompt.trim().toLowerCase();
            if (text === "/voice" || text === "/tts" || text === "/voices" || text === "voice settings" || text === "voice canvas") {
                return {
                    additionalContext: "The user triggered the voice settings shortcut. Immediately invoke open_canvas with canvasId: 'kokoro-voice-settings', instanceId: 'kokoro-settings-panel' and confirm to the user."
                };
            }
        },
    },
});

bootstrap(session).catch(() => {});

session.on("assistant.message", async (event) => {
    const config = loadConfig();
    if (config.auto_read === false) return;
    const content = event?.data?.content;
    if (content) {
        await speakText(content);
    }
});
