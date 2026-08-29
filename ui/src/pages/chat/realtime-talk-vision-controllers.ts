import { RealtimeTalkCameraController } from "./realtime-talk-camera-controller.ts";
import { openRealtimeTalkCamera, openRealtimeTalkScreen } from "./realtime-talk-input.ts";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

export function createRealtimeTalkVisionControllers(
  ctx: RealtimeTalkTransportContext,
  isClosed: () => boolean,
): {
  camera: RealtimeTalkCameraController;
  screen: RealtimeTalkCameraController;
} {
  return {
    camera: new RealtimeTalkCameraController({
      acquire: (deviceId, signal) => openRealtimeTalkCamera(deviceId, { signal }),
      getDeviceId: () => ctx.videoDeviceId,
      setDeviceId: (deviceId) => (ctx.videoDeviceId = deviceId),
      isClosed,
      onStream: (stream) => ctx.callbacks.onVideoStream?.(stream),
    }),
    screen: new RealtimeTalkCameraController({
      acquire: (_deviceId, signal) => openRealtimeTalkScreen({ signal }),
      getDeviceId: () => undefined,
      setDeviceId: () => undefined,
      isClosed,
      onStream: (stream) => ctx.callbacks.onScreenStream?.(stream),
    }),
  };
}
