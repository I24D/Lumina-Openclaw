#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{anyhow, Context, Result};
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use http::{Method, Response, StatusCode};
use mime_guess::MimeGuess;
use percent_encoding::percent_decode_str;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use url::Url;

const READY_TIMEOUT_MS: u64 = 600_000;
const POLL_INTERVAL_MS: u64 = 500;
const UI_SCHEME: &str = "lumina";
const UI_HOST: &str = "localhost";
const UI_WINDOWS_HOST: &str = "lumina.localhost";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static UI_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);
static SPLASH_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererConfig {
    auth_service_url: String,
    gateway_url: String,
    gateway_token: String,
    proxy_url: String,
    default_tab: String,
    require_lumina_auth: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchConfig {
    openclaw_config_path: String,
    openclaw_state_dir: String,
    gateway_token: String,
    gateway_port: u16,
    proxy_port: u16,
    i24d_chat_url: String,
    i24d_models_base_url: String,
    i24d_token: String,
    remote_brain_enabled: bool,
    remote_brain_url: String,
    remote_brain_secret: String,
    remote_brain_timeout_ms: u64,
    remote_brain_max_turns: u64,
    runtime_release_manifest_url: String,
    runtime_release_channel: String,
    skip_open_claw_channels: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePaths {
    repo_root: String,
    runtime_root: String,
    ui_index_path: String,
    node_runtime_path: String,
    runtime_manager_binary_path: String,
    open_claw_root: String,
    open_claw_entry_path: String,
    open_claw_bundled_plugins_dir: String,
    proxy_root: String,
    proxy_entry_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartupState {
    config: LaunchConfig,
    runtime_paths: RuntimePaths,
    renderer_config: RendererConfig,
}

#[derive(Debug, Clone)]
struct HelperContext {
    desktop_root: PathBuf,
    repo_root: PathBuf,
    resource_root: Option<PathBuf>,
}

struct RuntimeManagerSession {
    child: Child,
}

struct AppState {
    helper_context: Mutex<Option<HelperContext>>,
    startup_state: Mutex<Option<StartupState>>,
    runtime_manager: Mutex<Option<RuntimeManagerSession>>,
    shutdown_requested: std::sync::atomic::AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            helper_context: Mutex::new(None),
            startup_state: Mutex::new(None),
            runtime_manager: Mutex::new(None),
            shutdown_requested: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCapabilities {
    quit: bool,
    restart: bool,
    check_for_updates: bool,
    install_update: bool,
}

impl DesktopCapabilities {
    fn tauri(startup: &StartupState) -> Self {
        let updates_enabled = is_runtime_update_supported(startup);
        Self {
            quit: true,
            restart: true,
            check_for_updates: updates_enabled,
            install_update: updates_enabled,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateStatus {
    supported: bool,
    available: bool,
    downloaded: bool,
    current_version: String,
    latest_version: Option<String>,
    scheduled_restart: bool,
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBundleManifest {
    bundle_version: String,
    channel: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapperUpdateCheck {
    supported: bool,
    available: bool,
    current_version: Option<String>,
    latest_version: String,
    latest_channel: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapperInstalledRelease {
    bundle_version: String,
    channel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TauriInitializationPayload {
    renderer_config: RendererConfig,
    capabilities: DesktopCapabilities,
}

#[tauri::command(rename_all = "camelCase")]
fn get_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command(rename_all = "camelCase")]
fn save_preferred_model(model_ref: String, state: State<AppState>) -> std::result::Result<(), String> {
    let startup = clone_startup_state(&state).map_err(|error| error.to_string())?;
    let helper_context = clone_helper_context(&state).map_err(|error| error.to_string())?;
    run_node_helper(
        &helper_context,
        &startup,
        &["save-preferred-model", model_ref.as_str()],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn open_external(url: String) -> std::result::Result<(), String> {
    open::that_detached(url).map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command(rename_all = "camelCase")]
fn restart_app(app: AppHandle) {
    app.request_restart();
}

#[tauri::command(rename_all = "camelCase")]
fn check_for_updates(app: AppHandle, state: State<AppState>) -> DesktopUpdateStatus {
    let startup = match clone_startup_state(&state) {
        Ok(startup) => startup,
        Err(error) => {
            return unsupported_update_status(
                &app,
                None,
                &format!("Runtime update check is unavailable: {error}"),
            )
        }
    };

    if let Some(message) = update_support_error(&startup) {
        return unsupported_update_status(&app, Some(&startup), &message);
    }

    match run_bootstrapper_update_check(&startup) {
        Ok(update_check) => desktop_update_status_from_check(&app, &startup, update_check),
        Err(error) => failed_update_status(
            &app,
            &startup,
            format!("Runtime update check failed: {error:#}"),
        ),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn install_update(app: AppHandle, state: State<AppState>) -> DesktopUpdateStatus {
    let startup = match clone_startup_state(&state) {
        Ok(startup) => startup,
        Err(error) => {
            return unsupported_update_status(
                &app,
                None,
                &format!("Runtime update install is unavailable: {error}"),
            )
        }
    };

    if let Some(message) = update_support_error(&startup) {
        return unsupported_update_status(&app, Some(&startup), &message);
    }

    let current_version = current_runtime_version(&app, Some(&startup));
    let update_check = match run_bootstrapper_update_check(&startup) {
        Ok(update_check) => update_check,
        Err(error) => {
            return failed_update_status(
                &app,
                &startup,
                format!("Runtime update check failed: {error:#}"),
            )
        }
    };

    if !update_check.available {
        return DesktopUpdateStatus {
            supported: update_check.supported,
            available: false,
            downloaded: false,
            current_version,
            latest_version: Some(update_check.latest_version),
            scheduled_restart: false,
            message: Some("No runtime update is available.".to_string()),
        };
    }

    match run_bootstrapper_install(&startup) {
        Ok(installed_release) => DesktopUpdateStatus {
            supported: true,
            available: true,
            downloaded: true,
            current_version,
            latest_version: Some(installed_release.bundle_version.clone()),
            scheduled_restart: true,
            message: Some(format!(
                "Runtime {} was installed on channel {}. Restart Lumina to apply it.",
                installed_release.bundle_version, installed_release.channel
            )),
        },
        Err(error) => failed_update_status(
            &app,
            &startup,
            format!("Runtime update install failed: {error:#}"),
        ),
    }
}

fn unsupported_update_status(
    app: &AppHandle,
    startup: Option<&StartupState>,
    message: &str,
) -> DesktopUpdateStatus {
    DesktopUpdateStatus {
        supported: false,
        available: false,
        downloaded: false,
        current_version: current_runtime_version(app, startup),
        latest_version: None,
        scheduled_restart: false,
        message: Some(message.to_string()),
    }
}

fn failed_update_status(app: &AppHandle, startup: &StartupState, message: String) -> DesktopUpdateStatus {
    DesktopUpdateStatus {
        supported: true,
        available: false,
        downloaded: false,
        current_version: current_runtime_version(app, Some(startup)),
        latest_version: None,
        scheduled_restart: false,
        message: Some(message),
    }
}

fn current_runtime_version(app: &AppHandle, startup: Option<&StartupState>) -> String {
    startup
        .and_then(resolve_current_runtime_release)
        .map(|release| release.bundle_version)
        .unwrap_or_else(|| app.package_info().version.to_string())
}

fn resolve_current_runtime_release(startup: &StartupState) -> Option<RuntimeBundleManifest> {
    let runtime_root = PathBuf::from(startup.runtime_paths.runtime_root.trim());
    let dev_bundle_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)?
        .join("build")
        .join("runtime-bundle")
        .join("bundle.manifest.json");
    let candidates = [
        runtime_root.join("bundle.manifest.json"),
        dev_bundle_manifest,
    ];

    candidates.iter().find_map(|candidate| {
        std::fs::read_to_string(candidate)
            .ok()
            .and_then(|content| serde_json::from_str::<RuntimeBundleManifest>(&content).ok())
    })
}

fn update_support_error(startup: &StartupState) -> Option<String> {
    let manifest_source = startup.config.runtime_release_manifest_url.trim();
    if manifest_source.is_empty() {
        return Some("Runtime release manifest URL is not configured.".to_string());
    }
    if !is_secure_release_manifest_source(manifest_source) {
        return Some(
            "Runtime release manifest URL must use HTTPS or a local file path.".to_string(),
        );
    }

    let runtime_manager_binary = startup.runtime_paths.runtime_manager_binary_path.trim();
    if runtime_manager_binary.is_empty() {
        return Some("Lumina runtime manager binary is not configured.".to_string());
    }
    let runtime_manager_binary = PathBuf::from(runtime_manager_binary);
    if !runtime_manager_binary.exists() {
        return Some(format!(
            "Lumina runtime manager binary is missing at {}.",
            runtime_manager_binary.display()
        ));
    }

    None
}

fn is_runtime_update_supported(startup: &StartupState) -> bool {
    update_support_error(startup).is_none()
}

fn is_secure_release_manifest_source(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }

    match Url::parse(trimmed) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            url.scheme().eq_ignore_ascii_case("https")
        }
        Err(_) => true,
        _ => true,
    }
}

fn desktop_update_status_from_check(
    app: &AppHandle,
    startup: &StartupState,
    update_check: BootstrapperUpdateCheck,
) -> DesktopUpdateStatus {
    let current_version = update_check
        .current_version
        .clone()
        .or_else(|| resolve_current_runtime_release(startup).map(|release| release.bundle_version))
        .unwrap_or_else(|| app.package_info().version.to_string());
    let latest_version = Some(update_check.latest_version.clone());
    let message = if update_check.available {
        Some(format!(
            "Runtime update {} is available on channel {}.",
            update_check.latest_version, update_check.latest_channel
        ))
    } else {
        None
    };

    DesktopUpdateStatus {
        supported: update_check.supported,
        available: update_check.available,
        downloaded: false,
        current_version,
        latest_version,
        scheduled_restart: false,
        message,
    }
}

fn run_bootstrapper_update_check(startup: &StartupState) -> Result<BootstrapperUpdateCheck> {
    let mut args = vec![
        "check-update".to_string(),
        "--release-manifest".to_string(),
        startup.config.runtime_release_manifest_url.trim().to_string(),
        "--json".to_string(),
    ];

    if let Some(current_release) = resolve_current_runtime_release(startup) {
        args.push("--current-version".to_string());
        args.push(current_release.bundle_version);
        args.push("--current-channel".to_string());
        args.push(current_release.channel);
    } else if !startup.config.runtime_release_channel.trim().is_empty() {
        args.push("--current-channel".to_string());
        args.push(startup.config.runtime_release_channel.trim().to_string());
    }

    run_bootstrapper_command(startup, &args)
}

fn run_bootstrapper_install(startup: &StartupState) -> Result<BootstrapperInstalledRelease> {
    let args = vec![
        "install".to_string(),
        "--release-manifest".to_string(),
        startup.config.runtime_release_manifest_url.trim().to_string(),
        "--json".to_string(),
    ];
    run_bootstrapper_command(startup, &args)
}

fn run_bootstrapper_command<T>(startup: &StartupState, args: &[String]) -> Result<T>
where
    T: DeserializeOwned,
{
    let runtime_manager_binary = PathBuf::from(startup.runtime_paths.runtime_manager_binary_path.trim());
    let mut command = Command::new(&runtime_manager_binary);
    command.args(args);
    if !startup.runtime_paths.repo_root.trim().is_empty() {
        let current_dir = PathBuf::from(startup.runtime_paths.repo_root.trim());
        if current_dir.exists() {
            command.current_dir(current_dir);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_child_console(&mut command);

    let output = command
        .output()
        .with_context(|| format!("Failed to execute {}.", runtime_manager_binary.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "{} exited with code {}. {}",
            runtime_manager_binary.display(),
            output.status.code().unwrap_or_default(),
            stderr.trim()
        ));
    }

    serde_json::from_slice::<T>(&output.stdout).context("Failed to parse bootstrapper JSON output.")
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(lumina_protocol_plugin())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_version,
            save_preferred_model,
            open_external,
            quit_app,
            restart_app,
            check_for_updates,
            install_update
        ])
        .setup(|app| {
            let helper_context = match resolve_helper_context(app.handle()) {
                Ok(ctx) => ctx,
                Err(error) => {
                    eprintln!("[lumina] Fatal: could not resolve helper context: {error:#}");
                    return Err(error.into());
                }
            };

            {
                let state: State<AppState> = app.state();
                let mut slot = state.helper_context.lock().expect("helper context mutex poisoned");
                *slot = Some(helper_context.clone());
            }

            // Set SPLASH_ROOT immediately so splash.html can be served.
            let splash_root = resolve_splash_root(&helper_context);
            *SPLASH_ROOT.lock().expect("SPLASH_ROOT mutex poisoned") = Some(splash_root);

            let menu = build_app_menu(app)?;
            app.set_menu(menu)?;
            app.on_menu_event(handle_menu_event);

            // Create the splash window FIRST — before running any I/O (node, etc.).
            // If the window can't be created, we have no choice but to fail hard.
            if let Err(error) = create_main_window(app.handle(), &helper_context, None) {
                eprintln!("[lumina] Fatal: could not create main window: {error:#}");
                return Err(error.into());
            }

            // Everything else (startup resolution + bootstrap) runs in background.
            let app_handle = app.handle().clone();
            let hc = helper_context.clone();
            thread::spawn(move || full_startup(app_handle, hc));

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, run_event| {
        if matches!(run_event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.shutdown_requested.store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = stop_runtime_manager(&state);
            }
        }
    });
}

// ── Startup background thread ─────────────────────────────────────────────────

fn full_startup(app: AppHandle, helper_context: HelperContext) {
    emit_setup_progress(&app, "Iniciando Lumina\u{2026}");

    let startup = match resolve_startup_state(&helper_context) {
        Ok(s) => s,
        Err(error) => {
            emit_setup_error(&app, &format!("Error iniciando Lumina: {error:#}"));
            return;
        }
    };

    set_ui_root_from_startup(&startup);

    // Inject the real init payload into the already-open splash window so that
    // when we later navigate to index.html the init data is available.
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(payload_json) = serde_json::to_string(&TauriInitializationPayload {
            renderer_config: startup.renderer_config.clone(),
            capabilities: DesktopCapabilities::tauri(&startup),
        }) {
            let _ = window.eval(&format!("window.__LUMINA_TAURI_INIT__ = {payload_json};"));
        }
    }

    if let Some(state) = app.try_state::<AppState>() {
        *state.startup_state.lock().expect("startup state mutex poisoned") = Some(startup.clone());
    }

    bootstrap_runtime(app, helper_context, startup);
}

// ── Bootstrap background thread ────────────────────────────────────────────────

fn bootstrap_runtime(app: AppHandle, helper_context: HelperContext, startup: StartupState) {
    let openclaw_entry = PathBuf::from(startup.runtime_paths.open_claw_entry_path.trim());
    let needs_install = !openclaw_entry.exists();

    let effective_startup = if needs_install {
        let manifest_url = startup.config.runtime_release_manifest_url.trim().to_string();
        if manifest_url.is_empty() {
            emit_setup_error(
                &app,
                "OpenClaw Runtime no está instalado y runtimeReleaseManifestUrl no está configurado.\n\
                 Configura LUMINA_RUNTIME_RELEASE_MANIFEST_URL en render-preset.json.",
            );
            return;
        }

        emit_setup_progress(&app, "Preparando descarga del OpenClaw Runtime\u{2026}");

        match run_bootstrapper_install_for_first_run(&app, &helper_context, &startup, &manifest_url) {
            Ok(_) => {
                emit_setup_progress(&app, "Runtime descargado. Configurando rutas\u{2026}");
                match resolve_startup_state(&helper_context) {
                    Ok(new_startup) => {
                        set_ui_root_from_startup(&new_startup);
                        if let Some(state) = app.try_state::<AppState>() {
                            *state.startup_state.lock().expect("startup state mutex poisoned") =
                                Some(new_startup.clone());
                        }
                        new_startup
                    }
                    Err(error) => {
                        emit_setup_error(&app, &format!("Error resolviendo runtime instalado: {error:#}"));
                        return;
                    }
                }
            }
            Err(error) => {
                emit_setup_error(&app, &format!("Error descargando OpenClaw Runtime: {error:#}"));
                return;
            }
        }
    } else {
        startup
    };

    emit_setup_progress(&app, "Iniciando OpenClaw\u{2026}");

    let state = app.state::<AppState>();
    let started = match start_runtime_manager(&helper_context, &effective_startup, state) {
        Ok(()) => {
            if let Some(window) = app.get_webview_window("main") {
                let mut gateway_url = Url::parse(&format!(
                    "http://127.0.0.1:{}/",
                    effective_startup.config.gateway_port
                ))
                .expect("valid local gateway URL");
                gateway_url.set_fragment(Some(&format!(
                    "token={}",
                    effective_startup.config.gateway_token
                )));
                if let Ok(gateway_url_json) = serde_json::to_string(gateway_url.as_str()) {
                    let _ = window.eval(&format!(
                        "window.location.replace({gateway_url_json});"
                    ));
                }
            }
            true
        }
        Err(error) => {
            emit_setup_error(&app, &format!("Error iniciando OpenClaw: {error:#}"));
            false
        }
    };

    if started {
        spawn_gateway_watchdog(app, helper_context, effective_startup);
    }
}

fn run_bootstrapper_install_for_first_run(
    app: &AppHandle,
    helper_context: &HelperContext,
    startup: &StartupState,
    manifest_url: &str,
) -> Result<()> {
    let runtime_manager_binary =
        PathBuf::from(startup.runtime_paths.runtime_manager_binary_path.trim());
    if !runtime_manager_binary.exists() {
        return Err(anyhow!(
            "Bootstrapper binary not found at {}.",
            runtime_manager_binary.display()
        ));
    }

    let node_runtime_path = if !startup.runtime_paths.node_runtime_path.trim().is_empty() {
        PathBuf::from(startup.runtime_paths.node_runtime_path.trim())
    } else {
        resolve_helper_node_path(helper_context)?
    };

    let mut command = Command::new(&runtime_manager_binary);
    command
        .arg("install")
        .arg("--release-manifest")
        .arg(manifest_url)
        .env("NODE_EXECUTABLE", &node_runtime_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !startup.runtime_paths.repo_root.trim().is_empty() {
        let repo_root = PathBuf::from(startup.runtime_paths.repo_root.trim());
        if repo_root.exists() {
            command.current_dir(repo_root);
        }
    }

    hide_child_console(&mut command);

    let mut child = command.spawn().context("Failed to spawn bootstrapper install")?;

    // Forward bootstrapper stdout to the splash screen in real time.
    // Lines starting with "PROGRESS:downloaded:total" are parsed into a percentage.
    // All other stdout lines are captured for error reporting.
    let captured = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        let output = captured.clone();
        let app_handle = app.clone();
        thread::spawn(move || {
            let mut download_percent = 0u64;
            let mut extract_percent = 0u64;
            let mut activate_percent = 0u64;
            let mut current_message = String::from("Preparando OpenClaw Runtime...");
            for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
                if let Some(rest) = line.strip_prefix("PROGRESS:") {
                    let parts: Vec<&str> = rest.split(':').collect();
                    if parts.len() == 3 {
                        if let (phase, Ok(completed), Ok(total)) = (
                            parts[0],
                            parts[1].parse::<u64>(),
                            parts[2].parse::<u64>(),
                        ) {
                            if total > 0 {
                                let phase_percent = (completed.saturating_mul(100) / total).min(100);
                                let detail = match phase {
                                    "download" => {
                                        download_percent = phase_percent;
                                        current_message = "Descargando OpenClaw Runtime...".to_string();
                                        Some(format!(
                                            "{:.0} MB / {:.0} MB",
                                            completed as f64 / 1_048_576.0,
                                            total as f64 / 1_048_576.0
                                        ))
                                    }
                                    "extract" => {
                                        download_percent = download_percent.max(100);
                                        extract_percent = phase_percent;
                                        current_message = "Extrayendo OpenClaw Runtime...".to_string();
                                        Some(format!(
                                            "{:.0} MB / {:.0} MB",
                                            completed as f64 / 1_048_576.0,
                                            total as f64 / 1_048_576.0
                                        ))
                                    }
                                    "activate" => {
                                        download_percent = download_percent.max(100);
                                        extract_percent = extract_percent.max(100);
                                        activate_percent = phase_percent;
                                        current_message = "Activando runtime instalado...".to_string();
                                        Some(format!("{completed} / {total} pasos"))
                                    }
                                    _ => None,
                                };
                                let _ = app_handle.emit(
                                    "lumina-setup-progress",
                                    serde_json::json!({
                                        "message": current_message,
                                        "detail": detail,
                                        "percent": combined_setup_percent(
                                            download_percent,
                                            extract_percent,
                                            activate_percent,
                                        ),
                                    }),
                                );
                            }
                        }
                    } else if parts.len() == 2 {
                        if let (Ok(downloaded), Ok(total)) = (
                            parts[0].parse::<u64>(),
                            parts[1].parse::<u64>(),
                        ) {
                            if total > 0 {
                                download_percent = (downloaded.saturating_mul(100) / total).min(100);
                                current_message = "Descargando OpenClaw Runtime...".to_string();
                                let _ = app_handle.emit(
                                    "lumina-setup-progress",
                                    serde_json::json!({
                                        "message": current_message,
                                        "detail": format!(
                                            "{:.0} MB / {:.0} MB",
                                            downloaded as f64 / 1_048_576.0,
                                            total as f64 / 1_048_576.0
                                        ),
                                        "percent": combined_setup_percent(
                                            download_percent,
                                            extract_percent,
                                            activate_percent,
                                        ),
                                    }),
                                );
                            }
                        }
                    }
                } else if let Some(message) = line.strip_prefix("STATUS:") {
                    let message = message.trim();
                    if !message.is_empty() {
                        current_message = message.to_string();
                        apply_setup_status_floor(
                            message,
                            &mut download_percent,
                            &mut extract_percent,
                            &mut activate_percent,
                        );
                        let _ = app_handle.emit(
                            "lumina-setup-progress",
                            serde_json::json!({
                                "message": message,
                                "percent": combined_setup_percent(
                                    download_percent,
                                    extract_percent,
                                    activate_percent,
                                ),
                            }),
                        );
                    }
                } else {
                    append_output(&output, &line);
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let output = captured.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                append_output(&output, &line);
            }
        });
    }

    let status = child.wait().context("Failed to wait for bootstrapper install")?;
    if !status.success() {
        let tail = captured.lock().expect("output mutex poisoned").trim().to_string();
        return Err(anyhow!(
            "Bootstrapper install exited with code {}. {}",
            status.code().unwrap_or_default(),
            tail
        ));
    }
    let _ = app.emit(
        "lumina-setup-progress",
        serde_json::json!({
            "message": "OpenClaw Runtime listo.",
            "detail": "Instalacion completada",
            "percent": 100,
        }),
    );
    Ok(())
}

fn set_ui_root_from_startup(startup: &StartupState) {
    if let Some(ui_root) = PathBuf::from(startup.runtime_paths.ui_index_path.trim())
        .parent()
        .map(Path::to_path_buf)
    {
        *UI_ROOT.lock().expect("UI_ROOT mutex poisoned") = Some(ui_root);
    }
}

fn resolve_splash_root(helper_context: &HelperContext) -> PathBuf {
    if let Some(resource_root) = &helper_context.resource_root {
        resource_root.join("desktop-shell")
    } else {
        helper_context.desktop_root.join("dist")
    }
}

fn emit_setup_progress(app: &AppHandle, message: &str) {
    let _ = app.emit("lumina-setup-progress", serde_json::json!({ "message": message }));
}

fn combined_setup_percent(download_percent: u64, extract_percent: u64, activate_percent: u64) -> u64 {
    let weighted = download_percent.saturating_mul(35)
        + extract_percent.saturating_mul(50)
        + activate_percent.saturating_mul(15);
    (weighted / 100).min(100)
}

fn apply_setup_status_floor(
    message: &str,
    download_percent: &mut u64,
    extract_percent: &mut u64,
    activate_percent: &mut u64,
) {
    match message {
        "Validando archivos descargados..." => {
            *download_percent = (*download_percent).max(100);
        }
        "Extrayendo OpenClaw Runtime..." => {
            *download_percent = (*download_percent).max(100);
            *extract_percent = (*extract_percent).max(1);
        }
        "Validando estructura del runtime..." => {
            *download_percent = (*download_percent).max(100);
            *extract_percent = (*extract_percent).max(98);
        }
        "Preparando instalacion final..." => {
            *download_percent = (*download_percent).max(100);
            *extract_percent = (*extract_percent).max(100);
            *activate_percent = (*activate_percent).max(10);
        }
        "Activando runtime instalado..." => {
            *download_percent = (*download_percent).max(100);
            *extract_percent = (*extract_percent).max(100);
            *activate_percent = (*activate_percent).max(90);
        }
        _ => {}
    }
}

fn emit_setup_error(app: &AppHandle, error: &str) {
    let _ = app.emit("lumina-setup-error", serde_json::json!({ "error": error }));
}

// ── Tauri protocol plugin ──────────────────────────────────────────────────────

fn lumina_protocol_plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("lumina-protocol")
        .register_uri_scheme_protocol(UI_SCHEME, |_ctx, request| serve_ui_request(request))
        .build()
}

fn serve_ui_request(request: http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return text_response(StatusCode::METHOD_NOT_ALLOWED, "Only GET and HEAD are supported.");
    }

    let uri_path = request.uri().path();

    // Resolve the file: check UI_ROOT first, then SPLASH_ROOT as fallback.
    let file_path = resolve_file_path_for_request(uri_path);
    let file_path = match file_path {
        Some(p) => p,
        None => {
            let ui_ready = UI_ROOT.lock().expect("UI_ROOT mutex poisoned").is_some();
            if !ui_ready {
                return text_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Lumina UI root has not been initialized yet.",
                );
            }
            return text_response(StatusCode::NOT_FOUND, "Lumina UI asset not found.");
        }
    };

    let mime = mime_for_path(&file_path);
    let body = if request.method() == Method::HEAD {
        Vec::new()
    } else {
        match std::fs::read(&file_path) {
            Ok(bytes) => bytes,
            Err(_) => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read UI asset."),
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(CACHE_CONTROL, cache_control_for_path(&file_path))
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn resolve_file_path_for_request(uri_path: &str) -> Option<PathBuf> {
    // 1. Try UI_ROOT (the installed/bundled OpenClaw UI).
    {
        let guard = UI_ROOT.lock().expect("UI_ROOT mutex poisoned");
        if let Some(ui_root) = guard.as_ref() {
            if let Some(path) = resolve_ui_file_path(ui_root, uri_path) {
                return Some(path);
            }
        }
    }

    // 2. Fallback to SPLASH_ROOT (desktop-shell assets: splash.html, etc.).
    {
        let guard = SPLASH_ROOT.lock().expect("SPLASH_ROOT mutex poisoned");
        if let Some(splash_root) = guard.as_ref() {
            if let Some(path) = resolve_ui_file_path(splash_root, uri_path) {
                return Some(path);
            }
        }
    }

    None
}

fn request_path_to_relative(uri_path: &str) -> Option<PathBuf> {
    let raw = if uri_path.trim().is_empty() || uri_path == "/" {
        "index.html"
    } else {
        uri_path.trim_start_matches('/')
    };

    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    let mut relative = PathBuf::new();
    for component in Path::new(decoded.as_ref()).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }

    if decoded.ends_with('/') || relative.as_os_str().is_empty() {
        relative.push("index.html");
    }

    Some(relative)
}

fn resolve_ui_file_path(root: &Path, uri_path: &str) -> Option<PathBuf> {
    let relative_path = request_path_to_relative(uri_path)?;
    let candidate = root.join(&relative_path);
    if candidate.is_file() {
        return Some(candidate);
    }

    if relative_path.extension().is_none() {
        let fallback = root.join("index.html");
        if fallback.is_file() {
            return Some(fallback);
        }
    }

    None
}

fn text_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn mime_for_path(path: &Path) -> &'static str {
    MimeGuess::from_path(path)
        .first_raw()
        .unwrap_or("application/octet-stream")
}

fn cache_control_for_path(path: &Path) -> &'static str {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_lowercase();
            lower == "index.html" || lower == "splash.html"
        })
        .unwrap_or(false)
    {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    }
}

// ── Window & menu ──────────────────────────────────────────────────────────────

fn build_app_menu<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let file_menu = SubmenuBuilder::new(app, "File")
        .text("reload", "Reload")
        .separator()
        .text("quit", "Quit")
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu])
        .build()
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id() {
        id if id == "reload" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.reload();");
            }
        }
        id if id == "quit" => app.exit(0),
        _ => {}
    }
}

fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    helper_context: &HelperContext,
    startup: Option<&StartupState>,
) -> Result<()> {
    let init_script = match startup {
        Some(s) => load_initialization_script(helper_context, s)?,
        None => {
            // Splash-only mode: load tauri-init.js with a null payload so Tauri IPC
            // is already wired up when the splash page runs.
            match resolve_tauri_init_script_path(helper_context) {
                Ok(path) => match std::fs::read_to_string(&path) {
                    Ok(script) => format!("window.__LUMINA_TAURI_INIT__ = null;\n{script}"),
                    Err(_) => "window.__LUMINA_TAURI_INIT__ = null;".to_string(),
                },
                Err(_) => "window.__LUMINA_TAURI_INIT__ = null;".to_string(),
            }
        }
    };

    // Start with splash so the user sees something immediately.
    let url = Url::parse(&format!("{UI_SCHEME}://{UI_HOST}/splash.html"))
        .context("Failed to build Lumina splash URL.")?;

    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
        .title("Lumina OpenClaw")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .background_color(Color(14, 16, 21, 255))
        .visible(true)
        .focused(true)
        .initialization_script(init_script)
        .on_navigation(|url| {
            if is_internal_url(url) {
                return true;
            }
            if is_external_url(url) {
                let _ = open::that_detached(url.as_str());
            }
            false
        })
        .on_new_window(|url, _features| {
            if is_external_url(&url) {
                let _ = open::that_detached(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            // Once the real OpenClaw UI loads, make sure the window is focused.
            if matches!(payload.event(), PageLoadEvent::Finished) && is_internal_url(payload.url()) {
                let _ = window.set_focus();
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(TitleBarStyle::Transparent);

    builder
        .build()
        .context("Failed to create the Lumina main window.")?;

    Ok(())
}

fn is_internal_url(url: &Url) -> bool {
    if url.scheme().eq_ignore_ascii_case(UI_SCHEME) {
        return url
            .host_str()
            .map(|host| host.eq_ignore_ascii_case(UI_HOST))
            .unwrap_or(true);
    }

    matches!(url.scheme(), "http" | "https")
    && url
        .host_str()
        .map(|host| {
            host.eq_ignore_ascii_case(UI_WINDOWS_HOST)
                || host.eq_ignore_ascii_case("127.0.0.1")
                || host.eq_ignore_ascii_case("localhost")
        })
        .unwrap_or(false)
}

fn is_external_url(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => !is_internal_url(url),
        "mailto" => true,
        _ => false,
    }
}

fn load_initialization_script(
    helper_context: &HelperContext,
    startup: &StartupState,
) -> Result<String> {
    let payload = TauriInitializationPayload {
        renderer_config: startup.renderer_config.clone(),
        capabilities: DesktopCapabilities::tauri(startup),
    };
    let payload_json = serde_json::to_string(&payload)?;
    let script_path = resolve_tauri_init_script_path(helper_context)?;
    let script_body = std::fs::read_to_string(&script_path).with_context(|| {
        format!(
            "Failed to read the Tauri initialization script at {}.",
            script_path.display()
        )
    })?;

    Ok(format!(
        "window.__LUMINA_TAURI_INIT__ = {payload_json};\n{script_body}"
    ))
}

fn has_packaged_desktop_shell(resource_root: &Path) -> bool {
    resource_root.join("desktop-shell").join("tauri-bridge.js").exists()
        && resource_root.join("desktop-shell").join("tauri-init.js").exists()
}

fn resolve_packaged_resource_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("resources"));
            candidates.push(exe_dir.join("Resources"));
            if let Some(parent_dir) = exe_dir.parent() {
                candidates.push(parent_dir.join("Resources"));
            }
        }
    }

    candidates
        .into_iter()
        .find(|candidate| has_packaged_desktop_shell(candidate))
        .map(strip_unc_prefix)
}

fn resolve_tauri_init_script_path(helper_context: &HelperContext) -> Result<PathBuf> {
    let path = if let Some(resource_root) = &helper_context.resource_root {
        resource_root.join("desktop-shell").join("tauri-init.js")
    } else {
        helper_context.desktop_root.join("dist").join("tauri-init.js")
    };

    if path.exists() {
        Ok(path)
    } else {
        Err(anyhow!(
            "Tauri init script not found at {}. Run the desktop TypeScript build first.",
            path.display()
        ))
    }
}

fn resolve_helper_context<R: Runtime>(app: &AppHandle<R>) -> Result<HelperContext> {
    let desktop_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("Could not resolve desktop root."))?;
    let repo_root = desktop_root
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("Could not resolve repo root."))?;
    let resource_root = resolve_packaged_resource_root(app);

    Ok(HelperContext {
        desktop_root,
        repo_root,
        resource_root,
    })
}

fn resolve_startup_state(helper_context: &HelperContext) -> Result<StartupState> {
    let helper_output = run_node_helper_without_startup(helper_context, &["resolve-startup-state"])?;
    serde_json::from_str::<StartupState>(&helper_output)
        .context("Failed to parse startup state from tauri bridge.")
}

fn run_node_helper_without_startup(helper_context: &HelperContext, args: &[&str]) -> Result<String> {
    let node_path = resolve_helper_node_path(helper_context)?;
    let helper_script = resolve_helper_script_path(helper_context)?;
    let mut command = Command::new(node_path);
    command.arg(helper_script);
    for arg in args {
        command.arg(arg);
    }
    apply_helper_environment(&mut command, helper_context);
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    hide_child_console(&mut command);

    let output = command
        .output()
        .context("Failed to execute tauri bridge helper.")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "Tauri bridge helper failed with exit code {}. {}",
            output.status.code().unwrap_or_default(),
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_node_helper(helper_context: &HelperContext, startup: &StartupState, args: &[&str]) -> Result<String> {
    let helper_script = resolve_helper_script_path(helper_context)?;
    let node_path = if !startup.runtime_paths.node_runtime_path.trim().is_empty() {
        PathBuf::from(startup.runtime_paths.node_runtime_path.trim())
    } else {
        resolve_helper_node_path(helper_context)?
    };

    let mut command = Command::new(node_path);
    command.arg(helper_script);
    for arg in args {
        command.arg(arg);
    }
    apply_helper_environment(&mut command, helper_context);
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    hide_child_console(&mut command);

    let output = command
        .output()
        .context("Failed to execute tauri bridge helper.")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "Tauri bridge helper failed with exit code {}. {}",
            output.status.code().unwrap_or_default(),
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn apply_helper_environment(command: &mut Command, helper_context: &HelperContext) {
    let effective_repo_root = if helper_context.repo_root.exists() {
        helper_context.repo_root.clone()
    } else if let Some(resource_root) = &helper_context.resource_root {
        resource_root.clone()
    } else {
        helper_context.desktop_root.clone()
    };
    command.env("LUMINA_REPO_ROOT", strip_unc_prefix(effective_repo_root));
    if let Some(resource_root) = &helper_context.resource_root {
        command.env("LUMINA_RESOURCE_ROOT", strip_unc_prefix(resource_root.clone()));
    }
}

fn resolve_helper_script_path(helper_context: &HelperContext) -> Result<PathBuf> {
    let path = if let Some(resource_root) = &helper_context.resource_root {
        resource_root.join("desktop-shell").join("tauri-bridge.js")
    } else {
        helper_context.desktop_root.join("dist").join("tauri-bridge.js")
    };

    if path.exists() {
        // Canonicalize to ensure node.exe always receives a fully-qualified
        // absolute path (no drive-relative "C:..." forms that cause lstat 'C:').
        std::fs::canonicalize(&path)
            .map(strip_unc_prefix)
            .with_context(|| format!("Failed to resolve path for tauri-bridge at {}", path.display()))
    } else {
        Err(anyhow!(
            "Tauri bridge helper not found at {}. Run the desktop TypeScript build first.",
            path.display()
        ))
    }
}

fn resolve_helper_node_path(helper_context: &HelperContext) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(resource_root) = &helper_context.resource_root {
        candidates.push(resource_root.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
        candidates.push(resource_root.join(if cfg!(windows) { "node.exe" } else { "node" }));
    }
    candidates.push(
        helper_context
            .desktop_root
            .join("build")
            .join("runtime-node")
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
    );

    if let Some(found) = candidates.into_iter().find(|candidate| candidate.exists()) {
        return std::fs::canonicalize(&found)
            .map(strip_unc_prefix)
            .with_context(|| format!("Failed to resolve node.exe path at {}", found.display()));
    }

    find_node_on_path().ok_or_else(|| anyhow!("Node.js runtime was not found for the Tauri bridge."))
}

/// On Windows, `std::fs::canonicalize` returns extended-length paths
/// prefixed with `\\?\`. Node.js handles these, but stripping the prefix
/// produces shorter, more compatible paths.
#[cfg(windows)]
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    path
}

fn find_node_on_path() -> Option<PathBuf> {
    let path_value = std::env::var_os("PATH")?;
    let candidates: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd"]
    } else {
        &["node"]
    };

    for segment in std::env::split_paths(&path_value) {
        for candidate in candidates {
            let full_path = segment.join(candidate);
            if full_path.exists() {
                return Some(full_path);
            }
        }
    }

    None
}

// ── Runtime manager ────────────────────────────────────────────────────────────

fn start_runtime_manager(
    helper_context: &HelperContext,
    startup: &StartupState,
    state: State<AppState>,
) -> Result<()> {
    let runtime_manager_binary = PathBuf::from(startup.runtime_paths.runtime_manager_binary_path.trim());
    if !runtime_manager_binary.exists() {
        return Err(anyhow!(
            "Lumina runtime manager binary is missing at {}.",
            runtime_manager_binary.display()
        ));
    }

    let node_runtime_path = if !startup.runtime_paths.node_runtime_path.trim().is_empty() {
        PathBuf::from(startup.runtime_paths.node_runtime_path.trim())
    } else {
        resolve_helper_node_path(helper_context)?
    };

    let mut command = Command::new(&runtime_manager_binary);
    command
        .arg("start")
        .arg("--runtime-root")
        .arg(&startup.runtime_paths.runtime_root)
        .arg("--node-executable-path")
        .arg(node_runtime_path)
        .arg("--open-claw-root")
        .arg(&startup.runtime_paths.open_claw_root)
        .arg("--open-claw-entry-path")
        .arg(&startup.runtime_paths.open_claw_entry_path)
        .arg("--openclaw-bundled-plugins-dir")
        .arg(&startup.runtime_paths.open_claw_bundled_plugins_dir)
        .arg("--proxy-root")
        .arg(&startup.runtime_paths.proxy_root)
        .arg("--proxy-entry-path")
        .arg(&startup.runtime_paths.proxy_entry_path)
        .arg("--openclaw-config-path")
        .arg(&startup.config.openclaw_config_path)
        .arg("--openclaw-state-dir")
        .arg(&startup.config.openclaw_state_dir)
        .arg("--gateway-token")
        .arg(&startup.config.gateway_token)
        .arg("--gateway-port")
        .arg(startup.config.gateway_port.to_string())
        .arg("--proxy-port")
        .arg(startup.config.proxy_port.to_string())
        .arg("--i24d-chat-url")
        .arg(&startup.config.i24d_chat_url)
        .arg("--i24d-models-base-url")
        .arg(&startup.config.i24d_models_base_url)
        .arg("--skip-openclaw-channels")
        .arg(startup.config.skip_open_claw_channels.to_string())
        .arg(format!("--i24d-token={}", startup.config.i24d_token))
        .arg("--remote-brain-timeout-ms")
        .arg(startup.config.remote_brain_timeout_ms.to_string())
        .arg("--remote-brain-max-turns")
        .arg(startup.config.remote_brain_max_turns.to_string())
        .arg("--startup-timeout-ms")
        .arg(READY_TIMEOUT_MS.to_string())
        .current_dir(&startup.runtime_paths.repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    sanitize_runtime_command_environment(&mut command);
    hide_child_console(&mut command);

    if startup.config.remote_brain_enabled {
        command.arg("--remote-brain-enabled");
    }
    if !startup.config.remote_brain_url.trim().is_empty() {
        command
            .arg("--remote-brain-url")
            .arg(&startup.config.remote_brain_url);
    }
    if !startup.config.remote_brain_secret.trim().is_empty() {
        command
            .arg("--remote-brain-secret")
            .arg(&startup.config.remote_brain_secret);
    }

    let mut child = command.spawn().context("Failed to start the Lumina runtime manager.")?;
    let output = Arc::new(Mutex::new(String::new()));

    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, output.clone(), "[runtime-manager] ");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, output.clone(), "[runtime-manager] ");
    }

    wait_for_ports_or_exit(
        &mut child,
        startup.config.proxy_port,
        startup.config.gateway_port,
        output.clone(),
    )?;

    let mut runtime_manager = state
        .runtime_manager
        .lock()
        .expect("runtime manager mutex poisoned");
    *runtime_manager = Some(RuntimeManagerSession { child });
    Ok(())
}

fn sanitize_runtime_command_environment(command: &mut Command) {
    let exact_keys = [
        "ELECTRON_RUN_AS_NODE",
        "INIT_CWD",
        "NODE_OPTIONS",
        "NODE_PATH",
        "OPENCLAW_PLUGIN_CATALOG_PATHS",
        "OPENCLAW_MPM_CATALOG_PATHS",
    ];
    for key in exact_keys {
        command.env_remove(key);
    }

    for (key, _) in std::env::vars_os() {
        let key_text = key.to_string_lossy().to_ascii_lowercase();
        if key_text.starts_with("npm_")
            || key_text.starts_with("pnpm_")
            || key_text.starts_with("yarn_")
            || key_text.starts_with("vite_")
        {
            command.env_remove(key);
        }
    }
}

fn hide_child_console(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn spawn_output_reader<T>(stream: T, output: Arc<Mutex<String>>, prefix: &'static str)
where
    T: IntoReader + Send + 'static,
{
    thread::spawn(move || {
        let reader = stream.into_reader();
        for line in reader.lines().map_while(std::result::Result::ok) {
            eprintln!("{prefix}{line}");
            append_output(&output, &line);
        }
    });
}

fn append_output(output: &Arc<Mutex<String>>, line: &str) {
    let mut guard = output.lock().expect("runtime output mutex poisoned");
    guard.push_str(line);
    guard.push('\n');
    if guard.len() > 12_000 {
        let start = guard.len().saturating_sub(12_000);
        let tail = guard[start..].to_string();
        *guard = tail;
    }
}

fn wait_for_ports_or_exit(
    child: &mut Child,
    proxy_port: u16,
    gateway_port: u16,
    output: Arc<Mutex<String>>,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(READY_TIMEOUT_MS);
    while Instant::now() < deadline {
        // Check ports first: on warm start the bootstrapper exits as soon as it
        // confirms the existing session is healthy, which can happen before we
        // reach the try_wait() check below — causing a false "exited before
        // readiness" error and preventing navigation from firing.
        if is_port_ready(proxy_port) && is_port_ready(gateway_port) {
            return Ok(());
        }

        if let Some(status) = child.try_wait().context("Failed while checking runtime manager status.")? {
            // Give ports a final grace window in case they opened at the same
            // instant the bootstrapper exited (warm-start race).
            thread::sleep(Duration::from_millis(200));
            if is_port_ready(proxy_port) && is_port_ready(gateway_port) {
                return Ok(());
            }
            let tail = output.lock().expect("runtime output mutex poisoned").trim().to_string();
            if tail.is_empty() {
                return Err(anyhow!(
                    "Lumina runtime manager exited before readiness with code {}.",
                    status.code().unwrap_or_default()
                ));
            }
            return Err(anyhow!("Lumina runtime manager exited before readiness. {tail}"));
        }

        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }

    let tail = output.lock().expect("runtime output mutex poisoned").trim().to_string();
    if tail.is_empty() {
        Err(anyhow!(
            "Lumina runtime manager did not open ports {proxy_port}/{gateway_port} within {} seconds.",
            READY_TIMEOUT_MS / 1000
        ))
    } else {
        Err(anyhow!(tail))
    }
}

fn is_port_ready(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(400),
    )
    .is_ok()
}

fn stop_runtime_manager(state: &AppState) -> Result<()> {
    let startup = {
        let guard = state.startup_state.lock().expect("startup state mutex poisoned");
        guard.clone()
    };
    let Some(startup) = startup else {
        return Ok(());
    };

    let mut runtime_manager = state
        .runtime_manager
        .lock()
        .expect("runtime manager mutex poisoned");
    let Some(mut session) = runtime_manager.take() else {
        return Ok(());
    };

    let runtime_manager_binary = PathBuf::from(startup.runtime_paths.runtime_manager_binary_path.trim());
    if runtime_manager_binary.exists() {
        let mut stop_command = Command::new(&runtime_manager_binary);
        stop_command
            .arg("stop")
            .arg("--timeout-ms")
            .arg("15000")
            .current_dir(&startup.runtime_paths.repo_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hide_child_console(&mut stop_command);
        let stop_output = stop_command.output();

        if let Ok(stop_output) = stop_output {
            if !stop_output.status.success() {
                let stderr = String::from_utf8_lossy(&stop_output.stderr);
                eprintln!("[runtime-manager] shutdown request failed: {}", stderr.trim());
            }
        }
    }

    if session
        .child
        .try_wait()
        .context("Failed while stopping runtime manager.")?
        .is_none()
    {
        let _ = session.child.kill();
    }

    Ok(())
}

fn spawn_gateway_watchdog(app: AppHandle, helper_context: HelperContext, startup: StartupState) {
    use std::sync::atomic::Ordering;
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(5));

            let state = match app.try_state::<AppState>() {
                Some(s) => s,
                None => break,
            };

            if state.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }

            if is_port_ready(startup.config.gateway_port) {
                continue;
            }

            if state.shutdown_requested.load(Ordering::Relaxed) {
                break;
            }

            eprintln!(
                "[watchdog] Gateway port {} is down, restarting runtime manager...",
                startup.config.gateway_port
            );

            match start_runtime_manager(&helper_context, &startup, state) {
                Ok(()) => {
                    eprintln!("[watchdog] Runtime manager restarted successfully.");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.location.reload();");
                    }
                }
                Err(err) => {
                    eprintln!("[watchdog] Restart failed: {err:#}");
                    emit_setup_error(
                        &app,
                        &format!("El gateway se desconectó y no pudo reiniciarse: {err:#}"),
                    );
                    break;
                }
            }
        }
    });
}

fn clone_startup_state(state: &State<AppState>) -> Result<StartupState> {
    state
        .startup_state
        .lock()
        .expect("startup state mutex poisoned")
        .clone()
        .ok_or_else(|| anyhow!("Startup state is unavailable."))
}

fn clone_helper_context(state: &State<AppState>) -> Result<HelperContext> {
    state
        .helper_context
        .lock()
        .expect("helper context mutex poisoned")
        .clone()
        .ok_or_else(|| anyhow!("Helper context is unavailable."))
}

trait IntoReader {
    fn into_reader(self) -> BufReader<Box<dyn std::io::Read + Send>>;
}

impl IntoReader for ChildStdout {
    fn into_reader(self) -> BufReader<Box<dyn std::io::Read + Send>> {
        BufReader::new(Box::new(self))
    }
}

impl IntoReader for ChildStderr {
    fn into_reader(self) -> BufReader<Box<dyn std::io::Read + Send>> {
        BufReader::new(Box::new(self))
    }
}
