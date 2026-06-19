import { base64ToBytes, pcm16ToFloat } from "./realtime-talk-audio.ts";

export class RealtimeTalkPcmOutputQueue {
  private playhead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  // Phase 5 — optional fanout to a downstream node (e.g. an AnalyserNode
  // used by the mascot's lip-sync controller). When null, behaviour is
  // identical to the original implementation.
  private analyserTap: AudioNode | null = null;

  constructor(private readonly onPlaybackChange?: (playing: boolean) => void) {}

  /** Route every future audio source through `tap` in parallel with the
   *  default destination. Pass `null` to disconnect. The tap is created
   *  and owned by the caller; this method only stores the reference. */
  setAnalyserTap(tap: AudioNode | null): void {
    this.analyserTap = tap;
  }

  get queuedUntil(): number {
    return this.playhead;
  }

  get isPlaying(): boolean {
    return this.sources.size > 0;
  }

  play(base64: string, outputContext: AudioContext | null, outputSampleRateHz: number): void {
    if (!outputContext) {
      return;
    }
    const samples = pcm16ToFloat(base64ToBytes(base64));
    if (samples.length === 0) {
      return;
    }
    const buffer = outputContext.createBuffer(1, samples.length, outputSampleRateHz);
    buffer.getChannelData(0).set(samples);
    const source = outputContext.createBufferSource();
    const wasPlaying = this.sources.size > 0;
    this.sources.add(source);
    if (!wasPlaying) this.onPlaybackChange?.(true);
    source.addEventListener("ended", () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onPlaybackChange?.(false);
    });
    source.buffer = buffer;
    source.connect(outputContext.destination);
    if (this.analyserTap !== null) {
      try {
        source.connect(this.analyserTap);
      } catch {
        // Tap from a foreign context, etc. — never let it break playback.
      }
    }
    const startAt = Math.max(outputContext.currentTime, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
  }

  stop(outputContext: AudioContext | null): void {
    const wasPlaying = this.sources.size > 0;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    this.playhead = outputContext?.currentTime ?? 0;
    if (wasPlaying) this.onPlaybackChange?.(false);
  }
}
