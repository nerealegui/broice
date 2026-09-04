# 🎙️ Kokoro TTS for GitHub Copilot CLI

A **100% local, high-quality neural Text-to-Speech (TTS) extension** with an **interactive side-panel Canvas UI** for GitHub Copilot on macOS.

---

## 🌟 Key Features

- **Zero Cloud / 100% Private**: Neural model (~82M params) runs entirely on your Mac's CPU/Neural Engine using ONNX.
- **Interactive Side-Panel Canvas**: Visual settings dashboard (voice selection, speed slider, test player) built with the Copilot SDK.
- **Automatic Background Reader**: Reads assistant replies out loud automatically with smart Markdown cleaning (stripping code snippets, hashes, and links).
- **Fast Commands & Triggers**: Type `/voice` or `/tts` anywhere in Copilot to pop open the settings canvas.
- **Self-Bootstrapping**: Automatic background download and setup of Python venv and neural weights on first launch.

---

## 🗺️ Architecture & Workflow

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                               USER'S MAC (LOCAL ONLY)                            │
│                                                                                  │
│  1. GITHUB COPILOT APP                                                           │
│     ┌────────────────────────────────────────────────────────┐                   │
│     │  GitHub Copilot App / CLI Runtime                      │                   │
│     │  • User submits prompt / receives reply                │                   │
│     │  • Emits session event: "assistant.message"            │                   │
│     │  • Type `/voice` to open side-panel Canvas             │                   │
│     └──────────────────────────┬─────────────────────────────┘                   │
│                                │ JSON-RPC (stdio)                                │
│                                ▼                                                 │
│  2. EXTENSION LAYER (`~/.copilot/extensions/kokoro-tts/`)                       │
│     ┌────────────────────────────────────────────────────────┐                   │
│     │  extension.mjs                                         │                   │
│     │  • Auto-bootstraps weights/venv on first launch        │                   │
│     │  • Listens to "assistant.message"                      │                   │
│     │  • Hosts local HTTP server for Side-Panel Canvas UI    │                   │
│     │  • Exposes `configure_voice` & `speak` tools           │                   │
│     └──────────────────────────┬─────────────────────────────┘                   │
│                                │ Spawns Python CLI worker                        │
│                                ▼                                                 │
│  3. LOCAL KOKORO ENGINE (`bin/` or `~/.kokoro-tts/`)                             │
│     ┌────────────────────────────────────────────────────────┐                   │
│     │  speak.py + ONNX Runtime (kokoro-onnx)                 │                   │
│     │  • kokoro-v1.0.onnx (Neural weights, ~310MB)           │                   │
│     │  • voices-v1.0.bin  (Voice embeddings, ~27MB)          │                   │
│     │  • Generates latest_speech.wav                         │                   │
│     └──────────────────────────┬─────────────────────────────┘                   │
│                                │ Audio Stream                                    │
│                                ▼                                                 │
│  4. AUDIO PLAYBACK                                                               │
│     ┌────────────────────────────────────────────────────────┐                   │
│     │  macOS native `afplay` ──► Mac Speakers / Headphones   │                   │
│     └────────────────────────────────────────────────────────┘                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 📦 Installation Options

### Option 1: Automatic Installer (Recommended)
Run the `install.sh` script from this repo:
```bash
git clone <repo-url>
cd kokoro-copilot-extension
./install.sh
```

### Option 2: Manual Install (Drop Folder)
1. Copy this folder into your Copilot extensions directory:
   ```bash
   cp -r . ~/.copilot/extensions/kokoro-tts
   ```
2. Restart Copilot or reload extensions.

> **Note on First Run:** The extension will automatically create its local virtualenv and download the ONNX weights in the background.

---

## 🎮 How to Use & Trigger

### 1. Side-Panel Canvas UI
- Type **`/voice`**, **`/tts`**, or ask *"Open voice settings"* in chat.
- The interactive settings panel will open in the side tab where you can:
  - Choose voices from a dropdown menu.
  - Adjust speed (0.7x – 1.5x).
  - Toggle automatic speech reading on/off.
  - Play test phrases instantly.

### 2. Conversational Controls (Hands-Free)
You can also adjust settings by asking Copilot directly in chat:
- *"Switch voice to bf_emma"*
- *"Set speed to 1.1"*
- *"Turn off voice"*

---

## 🎨 How to Modify the Canvas UI

The canvas frontend is completely isolated in:
```
ui/index.html
```

### To Customize:
1. Open `ui/index.html` in your editor.
2. Modify the HTML, CSS styles, or JavaScript controls.
3. Refresh the side-panel canvas in Copilot to see changes live!

### Endpoints exposed by `extension.mjs`:
- `GET /api/config`: Returns current `{ voice, speed, lang, auto_read }`.
- `POST /api/config`: Updates settings in `config.json`.
- `POST /api/test-speech`: Synthesizes and plays a test audio sample.

---

## 🗣️ Available Voices

| Voice ID | Accent / Gender | Tone |
|---|---|---|
| `af_sarah` | American Female | Warm, Natural (Default) |
| `af_bella` | American Female | Soft, Clear |
| `af_nicole` | American Female | Crisp, Professional |
| `af_sky` | American Female | Dynamic |
| `am_adam` | American Male | Deep, Articulate |
| `am_michael` | American Male | Friendly, Standard |
| `bf_emma` | British Female | Conversational |
| `bf_isabella` | British Female | Formal, Articulate |
| `bm_george` | British Male | Classic British |
| `bm_lewis` | British Male | Casual British |
