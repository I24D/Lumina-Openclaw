// Shared types for camera-pip (kept separate so they can be imported
// from server-rendered code paths without pulling in DOM-coupled logic).
export const LITERAL_SVG_NS = "http://www.w3.org/2000/svg";

export type CameraPipController = {
  /** Returns a JPEG data URL of the current video frame, or null if not ready. */
  captureFrame(): string | null;
  /** Stop the stream and remove the PIP element. */
  dispose(): void;
};
