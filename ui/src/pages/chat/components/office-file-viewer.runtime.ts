import { setDefaultFileViewerAssetBaseUrl } from "@file-viewer/core";
import * as fileViewerBrowser from "@file-viewer/core/browser";
import officePreset from "@file-viewer/preset-office";

type ViewerController = {
  destroy: () => void;
  downloadOriginalFile: () => Promise<void>;
  load: (options: unknown) => Promise<void>;
};

const mountViewer = (
  fileViewerBrowser as unknown as {
    mountViewer: (parent: HTMLElement) => ViewerController;
  }
).mountViewer;

export type OfficeFileViewerHandle = {
  destroy: () => void;
  download: () => Promise<void>;
};

type OfficeFileViewerParams = {
  parent: HTMLElement;
  source: string;
  name: string;
  basePath?: string | null;
  authToken?: string | null;
  signal?: AbortSignal;
};

function normalizedBasePath(basePath?: string | null): string {
  const trimmed = basePath?.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function assistantMediaUrl(source: string, basePath?: string | null): string {
  const params = new URLSearchParams({ source });
  return `${normalizedBasePath(basePath)}/__openclaw__/assistant-media?${params.toString()}`;
}

function viewerTheme(): "light" | "dark" {
  return document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
}

export async function createOfficeFileViewer(
  params: OfficeFileViewerParams,
): Promise<OfficeFileViewerHandle> {
  const headers = new Headers();
  const authToken = params.authToken?.trim();
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  const response = await fetch(assistantMediaUrl(params.source, params.basePath), {
    credentials: "same-origin",
    headers,
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Document request failed (${response.status}).`);
  }

  const blob = await response.blob();
  const file = new File([blob], params.name, {
    type: blob.type || "application/octet-stream",
    lastModified: Date.now(),
  });
  const assetBaseUrl = `${normalizedBasePath(params.basePath)}/file-viewer/`;
  setDefaultFileViewerAssetBaseUrl(assetBaseUrl);

  const viewer = mountViewer(params.parent);
  let controller: ViewerController | null = viewer;
  const abortViewer = () => controller?.destroy();
  params.signal?.addEventListener("abort", abortViewer, { once: true });
  try {
    await viewer.load({
      file,
      filename: params.name,
      size: file.size,
      options: {
        preset: officePreset,
        rendererMode: "replace",
        builtinRenderers: "none",
        autoRenderers: false,
        theme: viewerTheme(),
        locale: "auto",
        styleIsolation: "shadow",
        fit: "contain",
        ui: {
          density: "compact",
          surfaceBackground: "transparent",
        },
        toolbar: false,
      },
    });
  } catch (error) {
    viewer.destroy();
    controller = null;
    throw error;
  }

  return {
    destroy: () => {
      params.signal?.removeEventListener("abort", abortViewer);
      controller?.destroy();
      controller = null;
    },
    download: () => controller?.downloadOriginalFile() ?? Promise.resolve(),
  };
}
