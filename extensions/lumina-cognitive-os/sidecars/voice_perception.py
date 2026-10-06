"""voice_perception.py - Lumina's ears: who is speaking, recognized only with consent.

Lumina spec section 8 (audition: speaker identification) and 4.4 (relational
memory). Listens to the default microphone, cuts speech segments with the
Silero voice activity detector and, for the people whose consent the gateway
sent in the gallery, identifies the speaker with a WeSpeaker embedding
(sherpa-onnx). It also hears:
  - the tone of each stretch of speech (loudness, pitch and how much it moves),
    for affect estimates, never facts;
  - who is who among unknown voices, as anonymous tags ("voice-2") kept only in
    memory for this run: diarization without identity;
  - sounds that matter (smoke alarm, glass breaking, screams, doorbell...) with
    an audio tagger (CED mini), the dangerous ones reported as hazards once two
    windows in a row agree;
  - and, only when the gateway asks for it, the words of the next utterance
    (Whisper tiny), for pronunciation practice.
Audio never leaves memory and is never written to disk; an embedding leaves the
process only when the gateway asks to enroll someone.

Protocol (one JSON object per line):
  stdout  {"kind":"start", ...}
          {"kind":"speech","atISO":...,"durationMs":n,"match":{"personId":id,"similarity":c}|null,
           "voiceTag":"voice-1"|null,"prosody":{"loudnessDb":l,"pitchHz":p,"pitchVar":v}}
          {"kind":"sound","atISO":...,"label":l,"score":s,"hazard":h|null,"severity":s|null}
          {"kind":"transcribed","requestId":r,"text":t,"durationMs":n}
          {"kind":"transcribe_failed","requestId":r,"reason":...}
          {"kind":"enrolled","requestId":r,"personId":id,"embedding":[256 floats]}
          {"kind":"enroll_failed","requestId":r,"personId":id,"reason":...}
          {"kind":"heartbeat","atISO":...}
          {"kind":"error","atISO":...,"message":...}
  stdin   {"cmd":"gallery","entries":[{"personId":id,"embeddings":[[...]]}]}
          {"cmd":"enroll","requestId":r,"personId":id}
          {"cmd":"transcribe","requestId":r,"language":"en"}
          {"cmd":"stop"}
Exits when stdin closes, so it never outlives the gateway.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import tarfile
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


ARCHIVES = {
    "tagger": (
        "sherpa-onnx-ced-mini-audio-tagging-2024-04-19",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2",
    ),
    "whisper": (
        "sherpa-onnx-whisper-tiny",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2",
    ),
}

# AudioSet classes that mean someone may be in danger: (hazard, severity).
HAZARDS = {
    "Smoke detector, smoke alarm": ("smoke alarm", "high"),
    "Fire alarm": ("fire alarm", "high"),
    "Screaming": ("screaming", "high"),
    "Shatter": ("glass breaking", "moderate"),
    "Glass": ("glass breaking", "moderate"),
    "Gunshot, gunfire": ("gunshot", "critical"),
    "Explosion": ("explosion", "critical"),
}
# Sounds worth knowing about that are not dangers.
NOTABLE = {
    "Doorbell", "Ding-dong", "Knock", "Telephone bell ringing", "Ringtone", "Alarm clock",
    "Siren", "Baby cry, infant cry", "Crying, sobbing", "Dog", "Bark", "Cat", "Meow",
    "Water tap, faucet", "Microwave oven", "Beep, bleep", "Buzzer", "Applause", "Laughter",
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


def ensure_archive(models_dir: str, key: str) -> str:
    name, url = ARCHIVES[key]
    folder = os.path.join(models_dir, name)
    if not os.path.isdir(folder):
        os.makedirs(models_dir, exist_ok=True)
        tmp = folder + ".tar.bz2.part"
        urllib.request.urlretrieve(url, tmp)
        with tarfile.open(tmp, "r:bz2") as archive:
            archive.extractall(models_dir, filter="data")
        os.remove(tmp)
    return folder


def prosody(samples: np.ndarray) -> dict:
    """Loudness in dBFS, median pitch and its relative spread over voiced 40 ms frames."""
    rms = float(np.sqrt(np.mean(np.square(samples)))) + 1e-9
    frame = int(0.04 * SAMPLE_RATE)
    lo, hi = SAMPLE_RATE // 400, SAMPLE_RATE // 75
    pitches = []
    for start in range(0, len(samples) - frame, frame):
        chunk = samples[start:start + frame] - np.mean(samples[start:start + frame])
        energy = float(np.dot(chunk, chunk))
        if energy < 1e-4:
            continue
        corr = np.correlate(chunk, chunk, mode="full")[frame - 1:]
        lag = lo + int(np.argmax(corr[lo:hi]))
        if corr[lag] / energy > 0.3:
            pitches.append(SAMPLE_RATE / lag)
    pitch = float(np.median(pitches)) if pitches else 0.0
    # Median absolute deviation: robust to the octave errors autocorrelation makes.
    spread = float(np.median(np.abs(np.asarray(pitches) - pitch)) / pitch) if pitches and pitch > 0 else 0.0
    return {
        "loudnessDb": round(float(20 * np.log10(rms)), 1),
        "pitchHz": round(pitch, 1),
        "pitchVar": round(spread, 3),
    }


class AnonymousVoices:
    """Tells unknown voices apart within this run, without knowing who they are."""

    def __init__(self, threshold: float, limit: int = 8) -> None:
        self.threshold = threshold
        self.limit = limit
        self.voices: list[list] = []  # [tag, centroid, count]
        self.next = 1

    def tag(self, feature: np.ndarray) -> str:
        best = None
        for voice in self.voices:
            similarity = float(np.dot(feature, voice[1]))
            if similarity >= self.threshold and (best is None or similarity > best[0]):
                best = (similarity, voice)
        if best is not None:
            voice = best[1]
            voice[2] += 1
            voice[1] = unit(voice[1] * (voice[2] - 1) / voice[2] + feature / voice[2])
            return voice[0]
        if len(self.voices) >= self.limit:
            self.voices.sort(key=lambda v: v[2])
            self.voices.pop(0)
        tag = f"voice-{self.next}"
        self.next += 1
        self.voices.append([tag, feature, 1])
        return tag


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
    # Sounds are tagged on the last two seconds of audio this often; 0 turns tagging off.
    parser.add_argument("--sounds-every-sec", type=float, default=2.0)
    parser.add_argument("--sound-min-score", type=float, default=0.45)
    parser.add_argument("--transcribe-timeout-sec", type=float, default=25.0)
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

    tagger = None
    if args.sounds_every_sec > 0:
        try:
            folder = ensure_archive(args.models_dir, "tagger")
            tagger = sherpa_onnx.AudioTagging(
                sherpa_onnx.AudioTaggingConfig(
                    model=sherpa_onnx.AudioTaggingModelConfig(
                        ced=os.path.join(folder, "model.int8.onnx"), num_threads=1
                    ),
                    labels=os.path.join(folder, "class_labels_indices.csv"),
                    top_k=3,
                )
            )
        except Exception as error:  # noqa: BLE001 - voices keep working without sound tagging
            emit({"kind": "error", "atISO": now_iso(), "message": f"sound tagger unavailable: {error}"})

    # Whisper loads on the first transcription request, in the background.
    whisper = {"recognizer": None, "loading": False, "error": None}

    def load_whisper() -> None:
        try:
            folder = ensure_archive(args.models_dir, "whisper")
            whisper["recognizer"] = folder
        except Exception as error:  # noqa: BLE001
            whisper["error"] = str(error)
        finally:
            whisper["loading"] = False

    recognizers: dict = {}

    def transcribe(samples: np.ndarray, language: str) -> str:
        folder = whisper["recognizer"]
        if language not in recognizers:
            recognizers[language] = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=os.path.join(folder, "tiny-encoder.int8.onnx"),
                decoder=os.path.join(folder, "tiny-decoder.int8.onnx"),
                tokens=os.path.join(folder, "tiny-tokens.txt"),
                language=language,
            )
        recognizer = recognizers[language]
        stream = recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()

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
    transcriptions: list[dict] = []
    anonymous = AnonymousVoices(args.match_threshold)
    window = np.zeros(SAMPLE_RATE * 2, dtype=np.float32)
    last_tagging = time.monotonic()
    hazard_streak: dict = {}
    last_sound: dict = {}
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
                elif command.get("cmd") == "transcribe":
                    transcriptions.append({**command, "deadline": time.monotonic() + args.transcribe_timeout_sec})
                    if whisper["recognizer"] is None and not whisper["loading"]:
                        whisper["loading"] = True
                        threading.Thread(target=load_whisper, daemon=True).start()

            try:
                block = audio.get(timeout=0.5)
                vad.accept_waveform(block)
                window = np.concatenate([window, block])[-SAMPLE_RATE * 2:]
            except queue.Empty:
                pass

            current = time.monotonic()
            if tagger is not None and current - last_tagging >= args.sounds_every_sec:
                last_tagging = current
                tagging = tagger.create_stream()
                tagging.accept_waveform(SAMPLE_RATE, window)
                heard = [e for e in tagger.compute(tagging) if e.prob >= args.sound_min_score]
                names = {e.name for e in heard}
                for name in list(hazard_streak):
                    if name not in names:
                        hazard_streak.pop(name)
                for event in heard:
                    hazard = HAZARDS.get(event.name)
                    if hazard is None and event.name not in NOTABLE:
                        continue
                    if hazard is not None:
                        hazard_streak[event.name] = hazard_streak.get(event.name, 0) + 1
                        if hazard_streak[event.name] < 2:
                            continue
                    if current - last_sound.get(event.name, -1e9) < 30:
                        continue
                    last_sound[event.name] = current
                    emit({
                        "kind": "sound",
                        "atISO": now_iso(),
                        "label": event.name,
                        "score": round(float(event.prob), 3),
                        "hazard": None if hazard is None else hazard[0],
                        "severity": None if hazard is None else hazard[1],
                    })

            while not vad.empty():
                samples = np.asarray(vad.front.samples, dtype=np.float32)
                vad.pop()
                seconds = len(samples) / SAMPLE_RATE
                if transcriptions and whisper["recognizer"] is not None and seconds >= 0.3:
                    request = transcriptions.pop(0)
                    try:
                        text = transcribe(samples, str(request.get("language") or "en"))
                        emit({
                            "kind": "transcribed",
                            "requestId": request.get("requestId"),
                            "text": text,
                            "durationMs": int(seconds * 1000),
                        })
                    except Exception as error:  # noqa: BLE001
                        emit({"kind": "transcribe_failed", "requestId": request.get("requestId"), "reason": str(error)})
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
                    "voiceTag": anonymous.tag(feature) if best is None else None,
                    "prosody": prosody(samples),
                })

            current = time.monotonic()
            for request in list(transcriptions):
                if current > request["deadline"]:
                    reason = whisper["error"] or "nothing was said in time"
                    emit({"kind": "transcribe_failed", "requestId": request.get("requestId"), "reason": reason})
                    transcriptions.remove(request)
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
