//! Win32 / COM action executors.
//!
//! All of these are synchronous and run on the HTTP worker thread. The cost
//! is negligible (each call is one COM round-trip on the desktop).

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, MAX_PATH, TRUE};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationWindowPattern,
    UIA_WindowPatternId,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, ShowWindow, SW_MINIMIZE, SW_SHOWNORMAL,
};

#[derive(Debug, Serialize)]
pub struct ActionResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ActionResult {
    pub fn ok(msg: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: msg.into(),
            details: None,
        }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: msg.into(),
            details: None,
        }
    }
    pub fn with_details(mut self, v: serde_json::Value) -> Self {
        self.details = Some(v);
        self
    }
}

/// RAII guard for COM apartment init on the current thread.
pub struct ComGuard;

impl ComGuard {
    pub fn new() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

// ── Open application ────────────────────────────────────────────────────

/// Resolves a friendly app name ("chrome", "vs code", "visual studio code") to
/// an executable path or shell URI, then launches it via ShellExecute.
/// Falls back to Get-StartApps (MSIX / Start Menu lookup) if ShellExecute
/// can't find the basename.
pub fn open_app(name: &str) -> ActionResult {
    let key = normalize(name);
    let target = resolve_known_app(&key).unwrap_or_else(|| name.to_string());

    if try_shell_execute(&target) {
        return ActionResult::ok(format!("abriendo {target}"));
    }
    // Fallback: Get-StartApps locates UWP / MSIX / Start-pinned apps that don't
    // have an App Paths registry entry. Slower (~200 ms) but very tolerant.
    match open_via_appsfolder(name) {
        Ok(r) if r.ok => r,
        Ok(_) => ActionResult::err(format!("no pude abrir «{name}»")),
        Err(e) => ActionResult::err(format!("no pude abrir «{name}»: {e}")),
    }
}

fn try_shell_execute(target: &str) -> bool {
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = format!("{target}\0").encode_utf16().collect();
    let hinst = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    hinst.0 as isize > 32
}

fn normalize(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .replace(['á', 'à'], "a")
        .replace(['é', 'è'], "e")
        .replace(['í', 'ì'], "i")
        .replace(['ó', 'ò'], "o")
        .replace(['ú', 'ù'], "u")
        .replace('ñ', "n")
}

fn resolve_known_app(key: &str) -> Option<String> {
    // Map of normalized spoken names → ShellExecute targets.
    // Targets can be executable basenames (resolved via PATH/AppPaths) or
    // shell: URIs that AppsFolder honors.
    let pairs: &[(&[&str], &str)] = &[
        (&["chrome", "google chrome"], "chrome.exe"),
        (&["edge", "microsoft edge"], "msedge.exe"),
        (&["firefox"], "firefox.exe"),
        (
            &["vscode", "vs code", "visual studio code", "code"],
            "code.cmd",
        ),
        (&["notepad", "bloc de notas"], "notepad.exe"),
        (&["calculadora", "calculator", "calc"], "calc.exe"),
        (&["explorador", "explorer", "file explorer"], "explorer.exe"),
        (&["spotify"], "spotify.exe"),
        (&["whatsapp"], "whatsapp.exe"),
        (&["terminal", "windows terminal", "wt"], "wt.exe"),
        (&["powershell"], "powershell.exe"),
        (&["cmd", "command prompt"], "cmd.exe"),
        (&["settings", "configuracion", "ajustes"], "ms-settings:"),
    ];

    for (aliases, target) in pairs {
        if aliases.iter().any(|a| *a == key) {
            return Some((*target).to_string());
        }
    }
    None
}

// ── Foreground window control via UIA ────────────────────────────────────

pub fn close_foreground_window() -> Result<ActionResult> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Ok(ActionResult::err("no hay ventana en primer plano"));
    }
    let title = window_title(hwnd);

    let _com = ComGuard::new()?;
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .context("CoCreateInstance(CUIAutomation)")?;
        let element: IUIAutomationElement = automation
            .ElementFromHandle(hwnd)
            .context("ElementFromHandle")?;
        let pattern_obj = element
            .GetCurrentPattern(UIA_WindowPatternId)
            .context("GetCurrentPattern(Window) — esta ventana no soporta Window pattern")?;
        let window: IUIAutomationWindowPattern = pattern_obj.cast()?;
        window.Close().context("WindowPattern.Close failed")?;
    }
    Ok(ActionResult::ok(format!("cerrando {title}")))
}

pub fn minimize_foreground_window() -> ActionResult {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return ActionResult::err("no hay ventana en primer plano");
    }
    let title = window_title(hwnd);
    let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
    ActionResult::ok(format!("minimizando {title}"))
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::from("(sin título)");
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let written = GetWindowTextW(hwnd, &mut buf);
        if written <= 0 {
            return String::from("(sin título)");
        }
        String::from_utf16_lossy(&buf[..written as usize])
    }
}

// ── Volume control ──────────────────────────────────────────────────────

pub fn set_volume(percent: u32) -> Result<ActionResult> {
    let _com = ComGuard::new()?;
    let level = (percent.min(100) as f32) / 100.0;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .context("MMDeviceEnumerator")?;
        let device: IMMDevice = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .context("GetDefaultAudioEndpoint")?;
        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_INPROC_SERVER, None)
            .context("Activate IAudioEndpointVolume")?;
        endpoint
            .SetMasterVolumeLevelScalar(level, std::ptr::null())
            .context("SetMasterVolumeLevelScalar")?;
    }
    Ok(ActionResult::ok(format!("volumen al {percent}%")))
}

// ── File search ─────────────────────────────────────────────────────────

/// Lightweight file search: walk common user folders looking for filenames
/// that contain the query (case-insensitive). Capped to keep latency low.
pub fn search_file(query: &str) -> ActionResult {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return ActionResult::err("consulta vacía");
    }

    let roots: Vec<PathBuf> = ["USERPROFILE"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(PathBuf::from)
        .flat_map(|home| {
            ["Documents", "Desktop", "Downloads", "Pictures", "OneDrive"]
                .iter()
                .map(move |sub| home.join(sub))
        })
        .filter(|p| p.exists())
        .collect();

    let mut hits = Vec::new();
    let mut scanned = 0usize;
    for root in &roots {
        walk_capped(root, &needle, &mut hits, &mut scanned, 0, 6, 20_000);
        if hits.len() >= 20 {
            break;
        }
    }
    let top: Vec<String> = hits.iter().take(10).map(|p| p.display().to_string()).collect();
    let msg = if top.is_empty() {
        format!("no encontré archivos para «{query}»")
    } else {
        format!("encontré {} archivos para «{query}»", hits.len())
    };
    ActionResult::ok(msg).with_details(serde_json::json!({
        "matches": top,
        "scanned": scanned,
        "totalHits": hits.len(),
    }))
}

fn walk_capped(
    dir: &std::path::Path,
    needle: &str,
    hits: &mut Vec<PathBuf>,
    scanned: &mut usize,
    depth: usize,
    max_depth: usize,
    max_scanned: usize,
) {
    if depth > max_depth || *scanned >= max_scanned || hits.len() >= 50 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        *scanned += 1;
        if *scanned >= max_scanned {
            return;
        }
        let path = entry.path();
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_lowercase();
        if name.contains(needle) {
            hits.push(path.clone());
            if hits.len() >= 50 {
                return;
            }
        }
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() && !is_skip_dir(&name) {
                walk_capped(&path, needle, hits, scanned, depth + 1, max_depth, max_scanned);
            }
        }
    }
}

fn is_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "target"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | "appdata"
    )
}

// ── List foreground windows (helper for the LLM context) ───────────────

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    pub title: String,
    pub process: String,
    pub pid: u32,
}

pub fn list_visible_windows() -> Vec<WindowInfo> {
    let mut acc: Vec<WindowInfo> = Vec::new();
    let ptr = &mut acc as *mut Vec<WindowInfo> as isize;
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(ptr));
    }
    acc
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let acc = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return TRUE;
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let written = GetWindowTextW(hwnd, &mut buf);
    if written <= 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&buf[..written as usize]);
    let mut pid: u32 = 0;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let process = process_image_name(pid).unwrap_or_default();
    acc.push(WindowInfo { title, process, pid });
    TRUE
}

fn process_image_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; MAX_PATH as usize];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(handle);
        if !ok || size == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        Some(
            path.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&path)
                .to_string(),
        )
    }
}

// ── Open arbitrary shell URI (used by intent for known apps that need it) ─

pub fn shell_open(target: &str) -> Result<ActionResult> {
    // Re-uses ShellExecute; honors AppsFolder shortcuts and ms-settings URIs.
    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = format!("{target}\0").encode_utf16().collect();
    let hinst = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if hinst.0 as isize > 32 {
        Ok(ActionResult::ok(format!("abriendo {target}")))
    } else {
        Err(anyhow!("ShellExecute returned {}", hinst.0 as isize))
    }
}

// ── Powershell helper for AppsFolder shortcuts (UWP / MSIX apps) ────────

/// Lookup an UWP/MSIX app by display name and launch via `explorer.exe shell:AppsFolder\<AUMID>`.
/// Slow (~200ms) — only used when ShellExecute by exe name failed.
pub fn open_via_appsfolder(display: &str) -> Result<ActionResult> {
    let script = format!(
        "Get-StartApps -Name '*{}*' | Select-Object -First 1 -ExpandProperty AppID",
        display.replace('\'', "''")
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .context("spawn powershell.exe for Get-StartApps")?;
    let aumid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if aumid.is_empty() {
        return Ok(ActionResult::err(format!("no encontré la app «{display}»")));
    }
    let target = format!("shell:AppsFolder\\{aumid}");
    shell_open(&target)
}
