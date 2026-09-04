import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkForUpdate, installExtractedUpdate, RUNTIME_FILES } from "../auto-updater.mjs";

function writeFile(root, relativePath, contents) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
}

test("installs runtime files without replacing settings or model data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "broice-updater-test-"));
    const sourceDir = path.join(root, "source");
    const extensionDir = path.join(root, "extension");
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(extensionDir);

    try {
        for (const relativePath of RUNTIME_FILES) {
            writeFile(sourceDir, relativePath, `new:${relativePath}`);
            writeFile(extensionDir, relativePath, `old:${relativePath}`);
        }
        writeFile(extensionDir, "config.json", "user settings");
        writeFile(extensionDir, "bin/model.bin", "model data");

        installExtractedUpdate(sourceDir, extensionDir);

        for (const relativePath of RUNTIME_FILES) {
            assert.equal(
                fs.readFileSync(path.join(extensionDir, relativePath), "utf8"),
                `new:${relativePath}`
            );
        }
        assert.equal(fs.readFileSync(path.join(extensionDir, "config.json"), "utf8"), "user settings");
        assert.equal(fs.readFileSync(path.join(extensionDir, "bin/model.bin"), "utf8"), "model data");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("rejects an incomplete update before changing installed files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "broice-updater-test-"));
    const sourceDir = path.join(root, "source");
    const extensionDir = path.join(root, "extension");
    fs.mkdirSync(sourceDir);
    fs.mkdirSync(extensionDir);

    try {
        for (const relativePath of RUNTIME_FILES) {
            writeFile(extensionDir, relativePath, `old:${relativePath}`);
        }
        writeFile(sourceDir, RUNTIME_FILES[0], "partial update");

        assert.throws(
            () => installExtractedUpdate(sourceDir, extensionDir),
            /Update package is missing/
        );
        assert.equal(
            fs.readFileSync(path.join(extensionDir, RUNTIME_FILES[0]), "utf8"),
            `old:${RUNTIME_FILES[0]}`
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("downloads, verifies, and installs a release package", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "broice-updater-test-"));
    const packageDir = path.join(root, "package");
    const extensionDir = path.join(root, "extension");
    const archivePath = path.join(root, "broice.tar.gz");
    fs.mkdirSync(packageDir);
    fs.mkdirSync(extensionDir);

    for (const relativePath of RUNTIME_FILES) {
        writeFile(packageDir, relativePath, `released:${relativePath}`);
        writeFile(extensionDir, relativePath, `installed:${relativePath}`);
    }
    writeFile(extensionDir, "config.json", "user settings");
    execFileSync("tar", ["-czf", archivePath, "-C", packageDir, "."]);
    const sha256 = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    const version = "a".repeat(40);

    const server = http.createServer((req, res) => {
        if (req.url === "/manifest") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ version, sha256 }));
            return;
        }
        if (req.url === "/archive") {
            res.end(fs.readFileSync(archivePath));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const { port } = server.address();
        const result = await checkForUpdate({
            extensionDir,
            manifestUrl: `http://127.0.0.1:${port}/manifest`,
            archiveUrl: `http://127.0.0.1:${port}/archive`
        });

        assert.deepEqual(result, { status: "updated", version });
        assert.equal(fs.readFileSync(path.join(extensionDir, ".broice-version"), "utf8"), version);
        assert.equal(fs.readFileSync(path.join(extensionDir, "config.json"), "utf8"), "user settings");
        assert.equal(
            fs.readFileSync(path.join(extensionDir, RUNTIME_FILES[0]), "utf8"),
            `released:${RUNTIME_FILES[0]}`
        );
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        fs.rmSync(root, { recursive: true, force: true });
    }
});
