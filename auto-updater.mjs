import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MANIFEST_URL = "https://github.com/nerealegui/broice/releases/download/continuous/update-manifest.json";
const ARCHIVE_URL = "https://github.com/nerealegui/broice/releases/download/continuous/broice.tar.gz";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const VERSION_FILE = ".broice-version";
const CHECK_FILE = ".broice-update-check";
const LOCK_DIR = ".broice-update-lock";

export const RUNTIME_FILES = [
    "extension.mjs",
    "auto-updater.mjs",
    "active-session.mjs",
    "speech-response-batcher.mjs",
    "speak.py",
    "copilot-extension.json",
    "ui/index.html"
];

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function readText(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8").trim();
    } catch (error) {
        if (error?.code === "ENOENT") return "";
        throw error;
    }
}

function validateManifest(value) {
    if (
        typeof value !== "object" ||
        value === null ||
        typeof value.version !== "string" ||
        !/^[0-9a-f]{40}$/.test(value.version) ||
        typeof value.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
        throw new Error("The Broice update manifest is invalid.");
    }
    return value;
}

async function download(url, destination) {
    const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
        throw new Error(`Update download failed with HTTP ${response.status}.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destination, bytes);
}

function sha256(filePath) {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function shouldCheck(extensionDir, now = Date.now()) {
    const lastCheck = Number.parseInt(readText(path.join(extensionDir, CHECK_FILE)), 10);
    return !Number.isFinite(lastCheck) || now - lastCheck >= CHECK_INTERVAL_MS;
}

function acquireLock(extensionDir) {
    const lockPath = path.join(extensionDir, LOCK_DIR);
    try {
        fs.mkdirSync(lockPath);
        return lockPath;
    } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age <= LOCK_STALE_MS) return null;
        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath);
        return lockPath;
    }
}

export function installExtractedUpdate(sourceDir, extensionDir) {
    for (const relativePath of RUNTIME_FILES) {
        const sourcePath = path.join(sourceDir, relativePath);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            throw new Error(`Update package is missing ${relativePath}.`);
        }
    }

    const backupDir = fs.mkdtempSync(path.join(extensionDir, ".broice-backup-"));
    const replaced = [];
    try {
        for (const relativePath of RUNTIME_FILES) {
            const sourcePath = path.join(sourceDir, relativePath);
            const destinationPath = path.join(extensionDir, relativePath);
            const backupPath = path.join(backupDir, relativePath);
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

            if (fs.existsSync(destinationPath)) {
                fs.mkdirSync(path.dirname(backupPath), { recursive: true });
                fs.renameSync(destinationPath, backupPath);
            }
            replaced.push(relativePath);
            fs.copyFileSync(sourcePath, destinationPath);
        }
    } catch (error) {
        for (const relativePath of replaced.reverse()) {
            const destinationPath = path.join(extensionDir, relativePath);
            const backupPath = path.join(backupDir, relativePath);
            fs.rmSync(destinationPath, { force: true });
            if (fs.existsSync(backupPath)) {
                fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                fs.renameSync(backupPath, destinationPath);
            }
        }
        throw error;
    } finally {
        fs.rmSync(backupDir, { recursive: true, force: true });
    }
}

export async function checkForUpdate({
    extensionDir = __dirname,
    manifestUrl = MANIFEST_URL,
    archiveUrl = ARCHIVE_URL,
    now = Date.now()
} = {}) {
    if (!shouldCheck(extensionDir, now)) return { status: "skipped" };

    const lockPath = acquireLock(extensionDir);
    if (!lockPath) return { status: "locked" };

    let tempDir;
    try {
        if (!shouldCheck(extensionDir, now)) return { status: "skipped" };
        fs.writeFileSync(path.join(extensionDir, CHECK_FILE), String(now), "utf8");

        const manifestResponse = await fetch(manifestUrl, {
            redirect: "follow",
            signal: AbortSignal.timeout(15_000)
        });
        if (!manifestResponse.ok) {
            throw new Error(`Update check failed with HTTP ${manifestResponse.status}.`);
        }
        const manifest = validateManifest(await manifestResponse.json());
        if (readText(path.join(extensionDir, VERSION_FILE)) === manifest.version) {
            return { status: "current", version: manifest.version };
        }

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "broice-update-"));
        const archivePath = path.join(tempDir, "broice.tar.gz");
        const extractedPath = path.join(tempDir, "extracted");
        fs.mkdirSync(extractedPath);
        await download(archiveUrl, archivePath);
        if (sha256(archivePath) !== manifest.sha256) {
            throw new Error("Broice update checksum verification failed.");
        }

        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractedPath]);
        installExtractedUpdate(extractedPath, extensionDir);
        fs.writeFileSync(path.join(extensionDir, VERSION_FILE), manifest.version, "utf8");
        return { status: "updated", version: manifest.version };
    } finally {
        if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
        fs.rmSync(lockPath, { recursive: true, force: true });
    }
}

export function startAutoUpdater(options = {}) {
    const run = () => {
        void checkForUpdate(options).catch((error) => {
            console.warn(`Broice auto-update failed: ${getErrorMessage(error)}`);
        });
    };
    run();
    const timer = setInterval(run, CHECK_INTERVAL_MS);
    timer.unref();
    return timer;
}
