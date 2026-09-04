#!/usr/bin/env python3
import sys
import os
import argparse
import subprocess
import soundfile as sf
from kokoro_onnx import Kokoro

def main():
    parser = argparse.ArgumentParser(description="Local Kokoro Text-to-Speech")
    parser.add_argument("text", nargs="?", help="Text to speak.")
    parser.add_argument("--voice", default="af_sarah", help="Voice ID")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed")
    parser.add_argument("--lang", default="en-us", help="Language code")
    parser.add_argument("--model-dir", default="/Users/nerealegui/.kokoro-tts", help="Directory containing onnx model and voices.bin")
    args = parser.parse_args()

    text = args.text if args.text else sys.stdin.read().strip()
    if not text:
        return

    model_path = os.path.join(args.model_dir, "kokoro-v1.0.onnx")
    if not os.path.exists(model_path):
        model_path = os.path.expanduser("~/.kokoro-tts/kokoro-v1.0.onnx")

    voices_path = os.path.join(args.model_dir, "voices-v1.0.bin")
    if not os.path.exists(voices_path):
        voices_path = os.path.expanduser("~/.kokoro-tts/voices-v1.0.bin")

    output_wav = os.path.join(args.model_dir, "latest_speech.wav")

    kokoro = Kokoro(model_path, voices_path)
    samples, sample_rate = kokoro.create(
        text,
        voice=args.voice,
        speed=args.speed,
        lang=args.lang
    )
    sf.write(output_wav, samples, sample_rate)
    subprocess.run(["afplay", output_wav])

if __name__ == "__main__":
    main()
