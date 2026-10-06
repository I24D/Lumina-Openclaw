/**
 * artifact-registry.ts — Where Lumina's own models and data come from, and proof they did not change.
 *
 * Lumina spec §135 (dataset system: source, license, version, hash, purpose),
 * §136 (model registry) and §46 (a model file is part of the attack surface).
 * Every model file the perception sidecars load and every dataset kept for
 * Lumina's own learning gets a record: where it came from, under what licence,
 * which version, what it is for, and the SHA-256 of its content. The first
 * hash is pinned when the file is first registered; every later check compares
 * against it, so a file swapped on disk shows up as changed, not as the same
 * model. Nothing is deleted or re-downloaded here: a changed or missing file is
 * reported and a person decides.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Probe } from "../brainstem/brainstem.js";
import type { StateStorePort } from "../shared/state-store.js";

export type ArtifactKind = "model" | "dataset";

export type ArtifactRecord = {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly source: string;
  readonly license: string;
  readonly version: string;
  readonly purpose: string;
  /** File or directory on this machine. */
  readonly path: string;
  /** Pinned when first registered. */
  readonly sha256: string;
  readonly bytes: number;
  readonly registeredISO: string;
  /** What the data a model learned from was, when known. */
  readonly trainedOn?: string;
};

export type ArtifactCheck = ArtifactRecord & {
  readonly status: "ok" | "changed" | "missing" | "unregistered";
  readonly checkedISO: string;
  readonly currentSha256?: string;
};

export type ArtifactInput = Omit<ArtifactRecord, "id" | "sha256" | "bytes" | "registeredISO">;

/** The perception sidecars' model files, as their upstream projects publish them. */
export function perceptionModels(modelsDir: string): ArtifactInput[] {
  const opencv = path.join(modelsDir, "opencv");
  const voice = path.join(modelsDir, "voice");
  return [
    {
      kind: "model",
      name: "YuNet face detector",
      source:
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
      license: "MIT (OpenCV Zoo)",
      version: "2023mar",
      purpose: "Finding faces in webcam frames (camera_perception sidecar).",
      path: path.join(opencv, "face_detection_yunet_2023mar.onnx"),
    },
    {
      kind: "model",
      name: "SFace face recognizer",
      source:
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
      license: "Apache-2.0 (OpenCV Zoo)",
      version: "2021dec",
      purpose: "Face embeddings, matched only against consented templates.",
      path: path.join(opencv, "face_recognition_sface_2021dec.onnx"),
    },
    {
      kind: "model",
      name: "YOLOX-S object detector",
      source:
        "https://github.com/opencv/opencv_zoo/raw/main/models/object_detection_yolox/object_detection_yolox_2022nov.onnx",
      license: "Apache-2.0 (YOLOX, OpenCV Zoo)",
      version: "2022nov",
      purpose:
        "Naming objects in webcam frames (COCO classes) for the world model and affordances.",
      path: path.join(opencv, "object_detection_yolox_2022nov.onnx"),
      trainedOn: "COCO",
    },
    {
      kind: "model",
      name: "Facial expression model (MobileFaceNet)",
      source:
        "https://github.com/opencv/opencv_zoo/raw/main/models/facial_expression_recognition/facial_expression_recognition_mobilefacenet_2022july.onnx",
      license: "as published by OpenCV Zoo; check before redistribution",
      version: "2022july",
      purpose: "Expression estimates for faces recognized with consent; estimates, never facts.",
      path: path.join(opencv, "facial_expression_recognition_mobilefacenet_2022july.onnx"),
    },
    {
      kind: "model",
      name: "CED mini audio tagger",
      source:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2",
      license: "as published by sherpa-onnx (CED); check before redistribution",
      version: "2024-04-19",
      purpose: "Sounds that matter (alarms, glass, screams, doorbell) from microphone audio.",
      path: path.join(voice, "sherpa-onnx-ced-mini-audio-tagging-2024-04-19"),
      trainedOn: "AudioSet",
    },
    {
      kind: "model",
      name: "Whisper tiny speech recognizer",
      source:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2",
      license: "MIT (OpenAI Whisper)",
      version: "tiny",
      purpose: "The words of one utterance, on request, for pronunciation practice.",
      path: path.join(voice, "sherpa-onnx-whisper-tiny"),
    },
    {
      kind: "model",
      name: "Silero VAD",
      source: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
      license: "MIT (Silero)",
      version: "sherpa-onnx asr-models release",
      purpose: "Detecting speech in microphone audio (voice_perception sidecar).",
      path: path.join(voice, "silero_vad.onnx"),
    },
    {
      kind: "model",
      name: "WeSpeaker ResNet34-LM speaker embedding",
      source:
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
      license: "as published by WeSpeaker; check before redistribution",
      version: "en_voxceleb_resnet34_LM",
      purpose: "Voice embeddings, matched only against consented templates.",
      path: path.join(voice, "wespeaker_en_voxceleb_resnet34_LM.onnx"),
      trainedOn: "VoxCeleb",
    },
  ];
}

/** SHA-256 of a file, or of a directory as its sorted relative paths and file hashes. */
export async function hashPath(target: string): Promise<{ sha256: string; bytes: number }> {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    const hash = createHash("sha256");
    const handle = await fs.open(target, "r");
    try {
      for await (const chunk of handle.createReadStream()) {
        hash.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    return { sha256: hash.digest("hex"), bytes: stat.size };
  }
  const entries = await fs.readdir(target, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .toSorted();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const part = await hashPath(file);
    bytes += part.bytes;
    hash.update(`${path.relative(target, file).replaceAll("\\", "/")}\0${part.sha256}\n`);
  }
  return { sha256: hash.digest("hex"), bytes };
}

const idOf = (input: Pick<ArtifactInput, "kind" | "name">) =>
  `${input.kind}:${input.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")}`;

export class ArtifactRegistry {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly latest = new Map<string, ArtifactCheck>();
  private readonly now: () => number;
  private writes: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(
    private readonly options: {
      readonly store?: StateStorePort<ArtifactRecord>;
      readonly now?: () => number;
      readonly onError?: (error: unknown) => void;
      readonly hash?: typeof hashPath;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ready = (async () => {
      try {
        for (const { value } of (await options.store?.entries()) ?? []) {
          this.records.set(value.id, value);
        }
      } catch (error) {
        options.onError?.(error);
      }
    })();
  }

  list(): ArtifactRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  /** The last check of each artifact, for the dashboard and the brainstem. */
  checks(): ArtifactCheck[] {
    return [...this.latest.values()].map((c) => structuredClone(c));
  }

  /**
   * Record an artifact and pin its hash. An artifact already registered keeps
   * its pinned hash: registering again only checks it.
   */
  async register(input: ArtifactInput): Promise<ArtifactCheck> {
    await this.ready;
    const id = idOf(input);
    if (this.records.has(id)) {
      return this.check(id);
    }
    const { sha256, bytes } = await (this.options.hash ?? hashPath)(input.path);
    const record: ArtifactRecord = {
      ...input,
      id,
      sha256,
      bytes,
      registeredISO: new Date(this.now()).toISOString(),
    };
    this.records.set(id, record);
    const store = this.options.store;
    if (store) {
      const snapshot = structuredClone(record);
      this.writes = this.writes.then(() =>
        store.register(id, snapshot).catch((error: unknown) => this.options.onError?.(error)),
      );
    }
    return this.remember({ ...record, status: "ok", currentSha256: sha256 });
  }

  /** Register what exists and is not yet known; files not downloaded yet wait for next time. */
  async registerPresent(inputs: ReadonlyArray<ArtifactInput>): Promise<ArtifactCheck[]> {
    const out: ArtifactCheck[] = [];
    for (const input of inputs) {
      try {
        out.push(await this.register(input));
      } catch {
        // Not on disk yet (the sidecar downloads it on first use).
      }
    }
    return out;
  }

  async check(id: string): Promise<ArtifactCheck> {
    await this.ready;
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`No artifact ${id} is registered.`);
    }
    try {
      const { sha256 } = await (this.options.hash ?? hashPath)(record.path);
      return this.remember({
        ...record,
        status: sha256 === record.sha256 ? "ok" : "changed",
        currentSha256: sha256,
      });
    } catch {
      return this.remember({ ...record, status: "missing" });
    }
  }

  async verifyAll(): Promise<ArtifactCheck[]> {
    await this.ready;
    const out: ArtifactCheck[] = [];
    for (const id of this.records.keys()) {
      out.push(await this.check(id));
    }
    return out;
  }

  private remember(check: Omit<ArtifactCheck, "checkedISO">): ArtifactCheck {
    const stamped = { ...check, checkedISO: new Date(this.now()).toISOString() };
    this.latest.set(check.id, stamped);
    return structuredClone(stamped);
  }

  probe(): Probe {
    return {
      name: "artifacts",
      critical: false,
      check: () => {
        const checks = this.checks();
        const bad = checks.filter((c) => c.status === "changed" || c.status === "missing");
        if (checks.length === 0) {
          return { status: "absent", detail: "No models or datasets registered yet." };
        }
        return bad.length === 0
          ? {
              status: "ok",
              detail: `${checks.length} models and datasets match their pinned hashes.`,
            }
          : {
              status: "degraded",
              detail: `${bad.map((c) => `${c.name} ${c.status}`).join("; ")}.`,
              recommendation:
                "A person checks where the file came from before anything uses it again.",
            };
      },
    };
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writes;
  }
}
