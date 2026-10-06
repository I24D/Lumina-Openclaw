"""voice_perception.py - Lumina's ears: who is speaking, recognized only with consent.

M3GAN spec section 8 (audition: speaker identification) and 4.4 (relational
memory). Listens to the default microphone, cuts speech segments with the
Silero voice activity detector and, for the people whose consent the gateway
sent in the gallery, identifies the speaker with a WeSpeaker embedding
(sherpa-onnx). Audio never leaves memory, is never written to disk and is never
transcribed here; an embedding leaves the process only when the gateway asks
to enroll someone.

Protocol (one JSON object per line):
  stdout  {"kind":"start", ...}
          {"kind":"speech","atISO":...,"durationMs":n,"match":{"personId":id,"similarity":c}|null}
          {"kind":"enrolled","requestId":r,"personId":id,"embedding":[256 floats]}
          {"kind":"enroll_failed","requestId":r,"personId":id,"reason":...}
          {"kind":"heartbeat","atISO":...}
          {"kind":"error","atISO":...,"message":...}
  stdin   {"cmd":"gallery","entries":[{"personId":id,"embeddings":[[...]]}]}
          {"cmd":"enroll","requestId":r,"personId":id}
          {"cmd":"stop"}
Exits when stdin closes, so it never outlives the gateway.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
import sherpa_onnx
import sounddevice as sd

SAMPLE_RATE = 16000
MODELS = {
    "vad": (
        "silero_vad.onnx",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    ),
    "speaker": (
        "wespeaker_en_voxceleb_resnet34_LM.onnx",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    ),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def ensure_model(models_dir: str, key: str) -> str:
    name, url = MODELS[key]
    path = os.path.join(models_dir, name)
    if not os.path.exists(path) or os.path.getsize(path) < 1024:
        os.makedirs(models_dir, exist_ok=True)
        tmp = path + ".part"
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, path)
    return path


def read_commands(commands: "queue.Queue[dict | None]") -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except json.JSONDecodeError:
            emit({"kind": "error", "atISO": now_iso(), "message": "unreadable command"})
    commands.put(None)  # stdin closed: the gateway is gone


def unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 0 else vector


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--device", default=None)
    # Cosine similarity at which two WeSpeaker embeddings count as the same voice.
    parser.add_argument("--match-threshold", type=float, default=0.55)
    parser.add_argument("--min-speech-sec", type=float, default=1.0)
    parser.add_argument("--enroll-min-sec", type=float, default=2.0)
    parser.add_argument("--enroll-timeout-sec", type=float, default=20.0)
    args = parser.parse_args()

    try:
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = ensure_model(args.models_dir, "vad")
        vad_config.silero_vad.min_silence_duration = 0.5
        vad_config.silero_vad.min_speech_duration = 0.4
        vad_config.sample_rate = SAMPLE_RATE
        vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)
        extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=ensure_model(args.models_dir, "speaker"), num_threads=1)
        )
    except Exception as error:  # noqa: BLE001 - reported to the gateway, then exit
        emit({"kind": "error", "atISO": now_iso(), "message": f"models unavailable: {error}"})
        return 2

    audio: "queue.Queue[np.ndarray]" = queue.Queue()

    def on_audio(block, _frames, _time, _status) -> None:
        audio.put(block[:, 0].copy())

    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=512,
            device=args.device,
            callback=on_audio,
        )
        stream.start()
    except Exception as error:  # noqa: BLE001
        emit({"kind": "error", "atISO": now_iso(), "message": f"microphone unavailable: {error}"})
        return 2

    commands: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=read_commands, args=(commands,), daemon=True).start()
    emit({"kind": "start", "atISO": now_iso(), "sampleRate": SAMPLE_RATE})

    gallery: list[tuple[str, np.ndarray]] = []
    enrolls: list[dict] = []
    last_heartbeat = time.monotonic()

    def embed(samples: np.ndarray) -> np.ndarray:
        speaker = extractor.create_stream()
        speaker.accept_waveform(SAMPLE_RATE, samples)
        speaker.input_finished()
        return unit(np.asarray(extractor.compute(speaker), dtype=np.float32))

    try:
        while True:
            while True:
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    break
                if command is None or command.get("cmd") == "stop":
                    return 0
                if command.get("cmd") == "gallery":
                    gallery = [
                        (str(entry["personId"]), unit(np.asarray(sample, dtype=np.float32)))
                        for entry in command.get("entries", [])
                        for sample in entry.get("embeddings", [])
                    ]
                elif command.get("cmd") == "enroll":
                    enrolls.append({**command, "deadline": time.monotonic() + args.enroll_timeout_sec})

            try:
                vad.accept_waveform(audio.get(timeout=0.5))
            except queue.Empty:
                pass

            while not vad.empty():
                samples = np.asarray(vad.front.samples, dtype=np.float32)
                vad.pop()
                seconds = len(samples) / SAMPLE_RATE
                if seconds < args.min_speech_sec:
                    continue
                feature = embed(samples)
                for request in list(enrolls):
                    if seconds >= args.enroll_min_sec:
                        emit({
                            "kind": "enrolled",
                            "requestId": request.get("requestId"),
                            "personId": request.get("personId"),
                            "embedding": [round(float(v), 6) for v in feature],
                        })
                        enrolls.remove(request)
                best: tuple[str, float] | None = None
                for person_id, sample in gallery:
                    similarity = float(np.dot(feature, sample))
                    if similarity >= args.match_threshold and (best is None or similarity > best[1]):
                        best = (person_id, similarity)
                emit({
                    "kind": "speech",
                    "atISO": now_iso(),
                    "durationMs": int(seconds * 1000),
                    "match": None if best is None else {"personId": best[0], "similarity": round(best[1], 3)},
                })

            current = time.monotonic()
            for request in list(enrolls):
                if current > request["deadline"]:
                    emit({
                        "kind": "enroll_failed",
                        "requestId": request.get("requestId"),
                        "personId": request.get("personId"),
                        "reason": f"no stretch of speech of {args.enroll_min_sec:.0f} s or more in time",
                    })
                    enrolls.remove(request)
            if current - last_heartbeat >= 30:
                emit({"kind": "heartbeat", "atISO": now_iso()})
                last_heartbeat = current
    finally:
        stream.stop()
        stream.close()


if __name__ == "__main__":
    sys.exit(main())
