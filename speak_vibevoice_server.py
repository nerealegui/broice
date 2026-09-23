#!/usr/bin/env python3
"""Persistent VibeVoice-Realtime worker for Broice.

Loading the VibeVoice model (imports + weights) costs roughly 13 seconds on a
Mac, which is unacceptable to pay on every spoken response. This worker loads
the model once and then answers an arbitrary number of speech requests over
newline-delimited JSON on stdin/stdout, keeping the model resident in memory
between calls.

Protocol:
  stdout emits {"type": "ready"} once the model has finished loading.
  stdin accepts one JSON object per line: {"id", "text", "voice", "speed"}.
  stdout replies with either {"id", "type": "result", "path": "<wav path>"}
  or {"id", "type": "error", "message": "..."}.

There is no in-band cancellation: a request is generated to completion once
started. The caller (extension.mjs) handles cancellation by terminating this
process outright, which discards whatever was mid-flight; the next request
spawns and warms up a fresh worker.
"""

import argparse
import copy
import json
import os
import sys
import tempfile
import urllib.request

import librosa
import numpy as np
import soundfile as sf
import torch
from transformers.cache_utils import DynamicCache
from transformers.modeling_outputs import BaseModelOutputWithPast

from vibevoice.modular.modeling_vibevoice_streaming_inference import (
    VibeVoiceStreamingForConditionalGenerationInference,
)
from vibevoice.processor.vibevoice_streaming_processor import VibeVoiceStreamingProcessor


MODEL_ID = "microsoft/VibeVoice-Realtime-0.5B"
VOICE_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/microsoft/VibeVoice/main/"
    "demo/voices/streaming_model/{voice}.pt"
)
def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def get_voice_path(model_dir, voice):
    voice_dir = os.path.join(model_dir, "vibevoice-voices")
    os.makedirs(voice_dir, exist_ok=True)
    voice_path = os.path.join(voice_dir, f"{voice}.pt")
    if not os.path.exists(voice_path):
        urllib.request.urlretrieve(VOICE_URL_TEMPLATE.format(voice=voice), voice_path)
    return voice_path


def load_voice_prompt(model_dir, voice, device, cache):
    if voice not in cache:
        with torch.serialization.safe_globals([BaseModelOutputWithPast, DynamicCache]):
            cache[voice] = torch.load(
                get_voice_path(model_dir, voice),
                map_location=device,
                # The official speaker prompt is a trusted serialized inference
                # cache containing BaseModelOutputWithPast objects.
                weights_only=False,
            )
    return cache[voice]


def audio_level_envelope(audio, sample_rate):
    window_size = max(1, int(sample_rate * 0.025))
    padded_length = ((len(audio) + window_size - 1) // window_size) * window_size
    padded = np.pad(audio, (0, padded_length - len(audio)))
    windows = padded.reshape(-1, window_size)
    rms = np.sqrt(np.mean(np.square(windows), axis=1))
    peak = max(float(np.percentile(rms, 98)), 1e-5)
    floor = max(peak * 0.025, 1e-5)
    decibels = 20 * np.log10(np.maximum(rms, floor) / peak)
    normalized = np.clip((decibels + 32) / 32, 0.0, 1.0)
    smoothed = np.convolve(normalized, np.ones(5) / 5, mode="same")
    return np.clip(smoothed, 0.0, 1.0).round(4).tolist()


def generate_wav(model, processor, cached_prompt, text, speed, device):
    inputs = processor.process_input_with_cached_prompt(
        text=text,
        cached_prompt=cached_prompt,
        padding=True,
        return_tensors="pt",
        return_attention_mask=True,
    )
    for key, value in inputs.items():
        if torch.is_tensor(value):
            inputs[key] = value.to(device)

    with torch.inference_mode():
        outputs = model.generate(
            **inputs,
            max_new_tokens=None,
            cfg_scale=1.5,
            tokenizer=processor.tokenizer,
            generation_config={"do_sample": False},
            verbose=False,
            all_prefilled_outputs=copy.deepcopy(cached_prompt),
        )

    audio = outputs.speech_outputs[0].detach().cpu().float().numpy()
    audio = np.asarray(audio).squeeze()
    if audio.ndim != 1:
        raise RuntimeError(f"VibeVoice returned an unsupported audio shape: {audio.shape}")

    if speed != 1.0:
        audio = librosa.effects.time_stretch(audio.astype("float32"), rate=speed)

    fd, wav_path = tempfile.mkstemp(prefix="broice_vibevoice_", suffix=".wav")
    os.close(fd)
    os.unlink(wav_path)
    sample_rate = 24000
    sf.write(wav_path, audio, sample_rate, format="WAV", subtype="PCM_16")
    return {
        "path": wav_path,
        "levels": audio_level_envelope(audio, sample_rate),
        "duration": len(audio) / sample_rate,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float32,
        device_map=None,
        attn_implementation="sdpa",
    )
    model.to(device)
    model.eval()
    model.set_ddpm_inference_steps(num_steps=5)
    processor = VibeVoiceStreamingProcessor.from_pretrained(MODEL_ID)

    voice_cache = {}

    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        request_id = request.get("id")
        try:
            text = request["text"]
            voice = request.get("voice", "en-Carter_man")
            speed = float(request.get("speed", 1.0))
            cached_prompt = load_voice_prompt(args.model_dir, voice, device, voice_cache)
            result = generate_wav(model, processor, cached_prompt, text, speed, device)
            emit({"id": request_id, "type": "result", **result})
        except Exception as error:  # noqa: BLE001 - report any failure to the caller
            emit({"id": request_id, "type": "error", "message": str(error)})


if __name__ == "__main__":
    main()
