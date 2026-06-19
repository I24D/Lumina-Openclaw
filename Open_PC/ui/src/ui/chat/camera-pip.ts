// Camera PIP — picture-in-picture webcam preview that Lumina can "see".
//
// Behavior:
// - When active, shows a small video preview anchored to a corner.
// - Draggable across the viewport; snaps to nearest edge on release.
// - Resizable via a corner handle (south-east only, simple).
// - Position + size persisted to localStorage so it survives reloads.
// - Captures frames on demand (capturePipFrame) so the agent can grab the
//   current webcam image when needed.
//
// Lifecycle:
// - mountCameraPip(): attaches the element to <body>, opens getUserMedia.
// - unmountCameraPip(): closes the stream and removes the element.
import { LITERAL_SVG_NS, type CameraPipController } from "./camera-pip-types.ts";

type SavedState = { x: number; y: number; w: number; h: number };

const STORAGE_KEY = "lumina:camera-pip:state";
const DEFAULT_STATE: SavedState = { x: -1, y: -1, w: 240, h: 180 };
const MIN_W = 160;
const MIN_H = 120;
const MAX_W = 640;
const MAX_H = 480;
const SNAP_MARGIN = 16;

function loadState(): SavedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      x: typeof parsed.x === "number" ? parsed.x : DEFAULT_STATE.x,
      y: typeof parsed.y === "number" ? parsed.y : DEFAULT_STATE.y,
      w: typeof parsed.w === "number" ? clamp(parsed.w, MIN_W, MAX_W) : DEFAULT_STATE.w,
      h: typeof parsed.h === "number" ? clamp(parsed.h, MIN_H, MAX_H) : DEFAULT_STATE.h,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: SavedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / disabled storage */
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function snapToEdge(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x;
  const right = vw - (x + w);
  const top = y;
  const bottom = vh - (y + h);
  const min = Math.min(left, right, top, bottom);
  if (min === left) return { x: SNAP_MARGIN, y: clamp(y, SNAP_MARGIN, vh - h - SNAP_MARGIN) };
  if (min === right) return { x: vw - w - SNAP_MARGIN, y: clamp(y, SNAP_MARGIN, vh - h - SNAP_MARGIN) };
  if (min === top) return { y: SNAP_MARGIN, x: clamp(x, SNAP_MARGIN, vw - w - SNAP_MARGIN) };
  return { y: vh - h - SNAP_MARGIN, x: clamp(x, SNAP_MARGIN, vw - w - SNAP_MARGIN) };
}

let current: CameraPipController | null = null;

export function getActiveCameraPip(): CameraPipController | null {
  return current;
}

export async function mountCameraPip(opts?: {
  onClose?: () => void;
}): Promise<CameraPipController> {
  if (current) return current;

  const state = loadState();
  if (state.x < 0 || state.y < 0) {
    state.x = window.innerWidth - state.w - SNAP_MARGIN;
    state.y = window.innerHeight - state.h - 96; // above the composer
  }

  const root = document.createElement("div");
  root.className = "lumina-camera-pip";
  root.style.width = `${state.w}px`;
  root.style.height = `${state.h}px`;
  root.style.left = `${state.x}px`;
  root.style.top = `${state.y}px`;
  root.setAttribute("role", "complementary");
  root.setAttribute("aria-label", "Webcam preview");

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // never feedback our own mic
  video.className = "lumina-camera-pip__video";

  const dragHandle = document.createElement("div");
  dragHandle.className = "lumina-camera-pip__drag";
  dragHandle.title = "Arrastra para mover";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "lumina-camera-pip__close";
  closeBtn.setAttribute("aria-label", "Cerrar cámara");
  closeBtn.title = "Cerrar cámara";
  closeBtn.innerHTML = `<svg xmlns="${LITERAL_SVG_NS}" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>`;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "lumina-camera-pip__resize";
  resizeHandle.title = "Arrastra para redimensionar";

  const liveDot = document.createElement("div");
  liveDot.className = "lumina-camera-pip__live";
  liveDot.setAttribute("aria-hidden", "true");

  root.append(video, dragHandle, liveDot, closeBtn, resizeHandle);
  document.body.appendChild(root);

  // Request webcam
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
  } catch (err) {
    console.error("[lumina-camera-pip] getUserMedia failed:", err);
    root.classList.add("lumina-camera-pip--error");
    const errorMsg = document.createElement("div");
    errorMsg.className = "lumina-camera-pip__error";
    errorMsg.textContent =
      "Sin acceso a la cámara. Revisa permisos del navegador / Windows.";
    root.appendChild(errorMsg);
  }

  // Drag handling
  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as Element).closest(".lumina-camera-pip__resize, .lumina-camera-pip__close"))
      return;
    dragging = true;
    dragOffsetX = e.clientX - root.offsetLeft;
    dragOffsetY = e.clientY - root.offsetTop;
    dragHandle.setPointerCapture(e.pointerId);
    root.classList.add("lumina-camera-pip--dragging");
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const nx = clamp(e.clientX - dragOffsetX, 0, window.innerWidth - root.offsetWidth);
    const ny = clamp(e.clientY - dragOffsetY, 0, window.innerHeight - root.offsetHeight);
    root.style.left = `${nx}px`;
    root.style.top = `${ny}px`;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("lumina-camera-pip--dragging");
    try {
      dragHandle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const snapped = snapToEdge(
      root.offsetLeft,
      root.offsetTop,
      root.offsetWidth,
      root.offsetHeight,
    );
    root.style.left = `${snapped.x}px`;
    root.style.top = `${snapped.y}px`;
    state.x = snapped.x;
    state.y = snapped.y;
    saveState(state);
  };
  dragHandle.addEventListener("pointerdown", onPointerDown);
  dragHandle.addEventListener("pointermove", onPointerMove);
  dragHandle.addEventListener("pointerup", onPointerUp);

  // Resize handling
  let resizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  const onResizeDown = (e: PointerEvent) => {
    e.stopPropagation();
    resizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartW = root.offsetWidth;
    resizeStartH = root.offsetHeight;
    resizeHandle.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: PointerEvent) => {
    if (!resizing) return;
    const dw = e.clientX - resizeStartX;
    const dh = e.clientY - resizeStartY;
    const nw = clamp(resizeStartW + dw, MIN_W, MAX_W);
    const nh = clamp(resizeStartH + dh, MIN_H, MAX_H);
    root.style.width = `${nw}px`;
    root.style.height = `${nh}px`;
  };
  const onResizeUp = (e: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    try {
      resizeHandle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    state.w = root.offsetWidth;
    state.h = root.offsetHeight;
    saveState(state);
  };
  resizeHandle.addEventListener("pointerdown", onResizeDown);
  resizeHandle.addEventListener("pointermove", onResizeMove);
  resizeHandle.addEventListener("pointerup", onResizeUp);

  // Close handler
  closeBtn.addEventListener("click", () => {
    controller.dispose();
    opts?.onClose?.();
  });

  // Window resize safety
  const onWindowResize = () => {
    const maxLeft = window.innerWidth - root.offsetWidth - SNAP_MARGIN;
    const maxTop = window.innerHeight - root.offsetHeight - SNAP_MARGIN;
    if (root.offsetLeft > maxLeft) root.style.left = `${Math.max(SNAP_MARGIN, maxLeft)}px`;
    if (root.offsetTop > maxTop) root.style.top = `${Math.max(SNAP_MARGIN, maxTop)}px`;
  };
  window.addEventListener("resize", onWindowResize);

  const captureFrame = (): string | null => {
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    try {
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      return null;
    }
  };

  const controller: CameraPipController = {
    captureFrame,
    dispose() {
      window.removeEventListener("resize", onWindowResize);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      if (root.parentNode) root.parentNode.removeChild(root);
      if (current === controller) current = null;
    },
  };

  current = controller;
  return controller;
}

export function unmountCameraPip() {
  if (current) current.dispose();
}
