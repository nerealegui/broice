#!/usr/bin/env python3
import sys
import os
import argparse
import subprocess
import signal
import tempfile
import soundfile as sf
from kokoro_onnx import Kokoro

afplay_proc = None
output_wav = None

def cleanup_output_wav():
    global output_wav
    if output_wav and os.path.exists(output_wav):
        try:
            os.remove(output_wav)
        except Exception:
            pass
        output_wav = None

def signal_handler(signum, frame):
    global afplay_proc
    if afplay_proc and afplay_proc.poll() is None:
        try:
            afplay_proc.terminate()
            afplay_proc.wait(timeout=0.2)
        except Exception:
            try:
                afplay_proc.kill()
            except Exception:
                pass
    cleanup_output_wav()
    sys.exit(0)

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

def main():
    global output_wav, afplay_proc
    parser = argparse.ArgumentParser(description="Broice local text-to-speech")
    parser.add_argument("text", nargs="?", help="Text to speak.")
    parser.add_argument("--voice", default="af_sarah", help="Voice ID")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--lang", default="en-us", help="Language code")
    parser.add_argument("--model-dir", default=os.path.expanduser("~/.broice"), help="Directory containing the ONNX model and voice data")
    args = parser.parse_args()

    text = args.text if args.text else sys.stdin.read().strip()
    if not text:
        return

    model_path = os.path.join(args.model_dir, "kokoro-v1.0.onnx")
    if not os.path.exists(model_path):
        model_path = os.path.expanduser("~/.broice/kokoro-v1.0.onnx")

    voices_path = os.path.join(args.model_dir, "voices-v1.0.bin")
    if not os.path.exists(voices_path):
        voices_path = os.path.expanduser("~/.broice/voices-v1.0.bin")

    kokoro = Kokoro(model_path, voices_path)
    samples, sample_rate = kokoro.create(
        text,
        voice=args.voice,
        speed=args.speed,
        lang=args.lang
    )

    with tempfile.NamedTemporaryFile(prefix=f"broice_speech_{os.getpid()}_", suffix=".wav", delete=False) as f:
        output_wav = f.name

    try:
        sf.write(output_wav, samples, sample_rate)
        afplay_proc = subprocess.Popen(["afplay", output_wav])
        afplay_proc.wait()
    finally:
        cleanup_output_wav()

if __name__ == "__main__":
    main()
