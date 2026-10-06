"""camera_perception.py - Lumina's eyes: webcam faces, recognized only with consent, and objects.

M3GAN spec section 7 (vision), 4.4 (relational memory) and 121-122 (objects and
affordances). Reads the webcam at a low frame rate, finds faces with OpenCV's
YuNet detector and, for the people whose consent the gateway sent in the
gallery, recognizes them with SFace embeddings. Every few seconds it also names
the objects in view with YOLOX (the 80 COCO classes; people are left to the
face path). Frames never leave memory and are never written to disk; an
embedding leaves the process only when the gateway asks to enroll someone.

Protocol (one JSON object per line):
  stdout  {"kind":"start", ...}
          {"kind":"faces","atISO":...,"faces":[{"box":[x,y,w,h],"score":s,"match":{"personId":id,"similarity":c}|null}]}
          {"kind":"objects","atISO":...,"objects":[{"label":l,"score":s,"box":[x,y,w,h]}]}
          {"kind":"enrolled","requestId":r,"personId":id,"embedding":[128 floats]}
          {"kind":"enroll_failed","requestId":r,"personId":id,"reason":...}
          {"kind":"heartbeat","atISO":...}
          {"kind":"error","atISO":...,"message":...}
  stdin   {"cmd":"gallery","entries":[{"personId":id,"embeddings":[[...128]]}]}
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

import cv2
import numpy as np

MODELS = {
    "detector": (
        "face_detection_yunet_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    ),
    "recognizer": (
        "face_recognition_sface_2021dec.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    ),
    "objects": (
        "object_detection_yolox_2022nov.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/object_detection_yolox/object_detection_yolox_2022nov.onnx",
    ),
}

COCO_CLASSES = (
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
    "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich",
    "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
    "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
)


class ObjectDetector:
    """YOLOX from OpenCV Zoo: letterboxed RGB input, grid decoding, per-class NMS."""

    def __init__(self, path: str, size: int = 640) -> None:
        self.net = cv2.dnn.readNet(path)
        self.size = size
        grids, strides = [], []
        for stride in (8, 16, 32):
            cells = size // stride
            xv, yv = np.meshgrid(np.arange(cells), np.arange(cells))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((cells * cells, 1), stride))
        self.grids = np.concatenate(grids, 0).astype(np.float32)
        self.strides = np.concatenate(strides, 0).astype(np.float32)

    def detect(self, frame, min_score: float, nms: float = 0.5) -> list[dict]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        height, width = rgb.shape[:2]
        ratio = min(self.size / height, self.size / width)
        resized = cv2.resize(rgb, (int(width * ratio), int(height * ratio))).astype(np.float32)
        padded = np.full((self.size, self.size, 3), 114.0, dtype=np.float32)
        padded[: resized.shape[0], : resized.shape[1]] = resized
        self.net.setInput(np.transpose(padded, (2, 0, 1))[np.newaxis])
        out = self.net.forward(self.net.getUnconnectedOutLayersNames())[0][0]
        centers = (out[:, :2] + self.grids) * self.strides
        sizes = np.exp(out[:, 2:4]) * self.strides
        scores = out[:, 4:5] * out[:, 5:]
        classes = scores.argmax(1)
        confidence = scores.max(1)
        boxes = np.concatenate([centers - sizes / 2, sizes], 1) / ratio
        keep = cv2.dnn.NMSBoxesBatched(boxes.tolist(), confidence.tolist(), classes.tolist(), min_score, nms)
        return [
            {
                "label": COCO_CLASSES[int(classes[i])],
                "score": round(float(confidence[i]), 3),
                "box": [int(v) for v in boxes[i]],
            }
            for i in np.array(keep).ravel()
        ]


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
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--fps", type=float, default=1.0)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--min-score", type=float, default=0.8)
    # SFace's published cosine threshold for "same person".
    parser.add_argument("--match-threshold", type=float, default=0.363)
    parser.add_argument("--refresh-sec", type=float, default=10.0)
    parser.add_argument("--enroll-timeout-sec", type=float, default=15.0)
    # Objects are named every few seconds; 0 turns the object detector off.
    parser.add_argument("--objects-every-sec", type=float, default=5.0)
    parser.add_argument("--object-min-score", type=float, default=0.5)
    args = parser.parse_args()

    try:
        detector = cv2.FaceDetectorYN.create(ensure_model(args.models_dir, "detector"), "", (320, 320), args.min_score)
        recognizer = cv2.FaceRecognizerSF.create(ensure_model(args.models_dir, "recognizer"), "")
    except Exception as error:  # noqa: BLE001 - reported to the gateway, then exit
        emit({"kind": "error", "atISO": now_iso(), "message": f"models unavailable: {error}"})
        return 2

    objects: ObjectDetector | None = None
    if args.objects_every_sec > 0:
        try:
            objects = ObjectDetector(ensure_model(args.models_dir, "objects"))
        except Exception as error:  # noqa: BLE001 - faces keep working without objects
            emit({"kind": "error", "atISO": now_iso(), "message": f"object detector unavailable: {error}"})

    backend = cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY
    capture = cv2.VideoCapture(args.camera, backend)
    if not capture.isOpened():
        capture = cv2.VideoCapture(args.camera)
    if not capture.isOpened():
        emit({"kind": "error", "atISO": now_iso(), "message": f"camera {args.camera} could not be opened"})
        return 2

    commands: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=read_commands, args=(commands,), daemon=True).start()
    emit({"kind": "start", "atISO": now_iso(), "camera": args.camera, "fps": args.fps})

    gallery: list[tuple[str, np.ndarray]] = []
    enrolls: list[dict] = []
    last_signature: tuple | None = None
    last_emit = 0.0
    last_objects_at = 0.0
    last_objects_signature: tuple | None = None
    last_objects_emit = 0.0
    last_heartbeat = time.monotonic()
    period = 1.0 / max(0.05, args.fps)

    try:
        while True:
            started = time.monotonic()
            while True:
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    break
                if command is None or command.get("cmd") == "stop":
                    return 0
                if command.get("cmd") == "gallery":
                    gallery = [
                        (str(entry["personId"]), unit(np.asarray(sample, dtype=np.float32).reshape(1, -1)))
                        for entry in command.get("entries", [])
                        for sample in entry.get("embeddings", [])
                    ]
                elif command.get("cmd") == "enroll":
                    enrolls.append({**command, "deadline": started + args.enroll_timeout_sec})

            ok, frame = capture.read()
            if not ok or frame is None:
                emit({"kind": "error", "atISO": now_iso(), "message": "camera frame unavailable"})
                time.sleep(max(1.0, period))
                continue

            height, width = frame.shape[:2]
            detector.setInputSize((width, height))
            _, detections = detector.detect(frame)
            detections = [] if detections is None else list(detections)

            faces = []
            features = []
            for face in detections:
                aligned = recognizer.alignCrop(frame, face)
                feature = unit(recognizer.feature(aligned).astype(np.float32))
                features.append(feature)
                best: tuple[str, float] | None = None
                for person_id, sample in gallery:
                    similarity = float(np.dot(feature.ravel(), sample.ravel()))
                    if similarity >= args.match_threshold and (best is None or similarity > best[1]):
                        best = (person_id, similarity)
                faces.append({
                    "box": [int(v) for v in face[:4]],
                    "score": round(float(face[14]), 3),
                    "match": None if best is None else {"personId": best[0], "similarity": round(best[1], 3)},
                })

            for request in list(enrolls):
                if len(features) == 1 and faces[0]["score"] >= 0.9:
                    emit({
                        "kind": "enrolled",
                        "requestId": request.get("requestId"),
                        "personId": request.get("personId"),
                        "embedding": [round(float(v), 6) for v in features[0].ravel()],
                    })
                    enrolls.remove(request)
                elif started > request["deadline"]:
                    reason = "no face in view" if not features else "more than one face in view"
                    emit({
                        "kind": "enroll_failed",
                        "requestId": request.get("requestId"),
                        "personId": request.get("personId"),
                        "reason": reason,
                    })
                    enrolls.remove(request)

            signature = (len(faces), tuple(sorted(f["match"]["personId"] for f in faces if f["match"])))
            if signature != last_signature or (faces and started - last_emit >= args.refresh_sec):
                emit({"kind": "faces", "atISO": now_iso(), "faces": faces})
                last_signature = signature
                last_emit = started
            if objects is not None and started - last_objects_at >= args.objects_every_sec:
                last_objects_at = started
                seen = [o for o in objects.detect(frame, args.object_min_score) if o["label"] != "person"]
                objects_signature = tuple(sorted(o["label"] for o in seen))
                if objects_signature != last_objects_signature or (seen and started - last_objects_emit >= 60):
                    emit({"kind": "objects", "atISO": now_iso(), "objects": seen})
                    last_objects_signature = objects_signature
                    last_objects_emit = started
            if started - last_heartbeat >= 30:
                emit({"kind": "heartbeat", "atISO": now_iso()})
                last_heartbeat = started

            time.sleep(max(0.0, period - (time.monotonic() - started)))
    finally:
        capture.release()


if __name__ == "__main__":
    sys.exit(main())
