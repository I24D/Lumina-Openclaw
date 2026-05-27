use crate::InstallPaths;
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const NODE_MIN_MAJOR: u32 = 22;
const NODE_MIN_MINOR: u32 = 12;
const DEFAULT_STOP_TIMEOUT_MS: u64 = 15_000;
const HEARTBEAT_INTERVAL_MS: u64 = 2_000;
const LOOP_INTERVAL_MS: u64 = 400;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub struct RuntimeLaunchSpec {
    pub runtime_root: PathBuf,
    pub node_executable_path: PathBuf,
    pub open_claw_root: PathBuf,
    pub open_claw_entry_path: PathBuf,
    pub openclaw_bundled_plugins_dir: PathBuf,
    pub proxy_root: PathBuf,
    pub proxy_entry_path: PathBuf,
    pub openclaw_config_path: PathBuf,
    pub openclaw_state_dir: PathBuf,
    pub gateway_token: String,
    pub gateway_port: u16,
    pub proxy_port: u16,
    pub i24d_chat_url: String,
    pub i24d_models_base_url: String,
    pub i24d_token: String,
    pub skip_openclaw_channels: bool,
    pub remote_brain_enabled: bool,
    pub remote_brain_url: String,
    pub remote_brain_secret: String,
    pub remote_brain_timeout_ms: u64,
    pub remote_brain_max_turns: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSessionState {
    pub schema_version: u32,
    pub updated_at: String,
    pub active_session: Option<RuntimeSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    pub session_id: String,
    pub manager_pid: u32,
    pub status: String,
    pub started_at: String,
    pub ready_at: Option<String>,
    pub last_heartbeat_at: String,
    pub last_error: Option<String>,
    pub runtime_root: String,
    pub node_executable_path: String,
    pub node_version: String,
    pub open_claw_root: String,
    pub open_claw_entry_path: String,
    pub proxy_root: String,
    pub proxy_entry_path: String,
    pub openclaw_config_path: String,
    pub openclaw_state_dir: String,
    pub openclaw_bundled_plugins_dir: String,
    pub gateway_port: u16,
    pub proxy_port: u16,
    pub gateway_pid: Option<u32>,
    pub proxy_pid: Option<u32>,
}

pub struct RuntimeManager {
    paths: InstallPaths,
    session: RuntimeSession,
    proxy_child: Child,
    gateway_child: Child,
    stop_timeout_ms: u64,
}

impl RuntimeManager {
    pub fn start(
        paths: &InstallPaths,
        spec: RuntimeLaunchSpec,
        startup_timeout_ms: u64,
    ) -> Result<Self> {
        ensure_runtime_manager_dirs(paths)?;
        initialize_startup_log(paths, &spec)?;
        cleanup_existing_runtime_session(paths, DEFAULT_STOP_TIMEOUT_MS)?;
        clear_stop_signal(paths)?;
        validate_launch_spec(&spec)?;

        if is_port_ready(spec.proxy_port) {
            bail!(
                "proxy port {} is already in use before runtime manager start",
                spec.proxy_port
            );
        }
        if is_port_ready(spec.gateway_port) {
            bail!(
                "gateway port {} is already in use before runtime manager start",
                spec.gateway_port
            );
        }

        let node_version = read_node_version(&spec.node_executable_path)?;
        let started_at = Utc::now().to_rfc3339();

        let mut proxy_child = spawn_node_child(
            &spec.node_executable_path,
            &spec.proxy_entry_path,
            &[],
            &spec.proxy_root,
            &[
                ("PROXY_PORT", spec.proxy_port.to_string()),
                ("I24D_URL", spec.i24d_chat_url.clone()),
                ("I24D_MODELS_BASE", spec.i24d_models_base_url.clone()),
                ("I24D_TOKEN", spec.i24d_token.clone()),
                ("OPENCLAW_GATEWAY_PORT", spec.gateway_port.to_string()),
                ("OPENCLAW_PORT", spec.gateway_port.to_string()),
                ("OPENCLAW_GATEWAY_TOKEN", spec.gateway_token.clone()),
                ("OPENCLAW_TOKEN", spec.gateway_token.clone()),
            ],
            "proxy",
            &paths.runtime_startup_log_file,
        )
        .context("failed to spawn the Lumina proxy runtime")?;

        let mut gateway_child = match spawn_node_child(
            &spec.node_executable_path,
            &spec.open_claw_entry_path,
            &["gateway", "run"],
            &spec.open_claw_root,
            &[
                ("OPENCLAW_CONFIG_PATH", spec.openclaw_config_path.display().to_string()),
                ("OPENCLAW_STATE_DIR", spec.openclaw_state_dir.display().to_string()),
                (
                    "OPENCLAW_BUNDLED_PLUGINS_DIR",
                    spec.openclaw_bundled_plugins_dir.display().to_string(),
                ),
                ("OPENCLAW_GATEWAY_TOKEN", spec.gateway_token.clone()),
                ("OPENCLAW_GATEWAY_PORT", spec.gateway_port.to_string()),
                ("OPENCLAW_PORT", spec.gateway_port.to_string()),
                ("OPENCLAW_TOKEN", spec.gateway_token.clone()),
                ("OPENCLAW_SKIP_PLUGIN_AUTO_ENABLE", "1".to_string()),
                ("OPENCLAW_DESKTOP_FAST_START", "1".to_string()),
                (
                    "OPENCLAW_SKIP_CHANNELS",
                    if spec.skip_openclaw_channels {
                        "1".to_string()
                    } else {
                        "0".to_string()
                    },
                ),
                (
                    "OPENCLAW_REMOTE_BRAIN_ENABLED",
                    if spec.remote_brain_enabled {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    },
                ),
                ("OPENCLAW_REMOTE_BRAIN_URL", spec.remote_brain_url.clone()),
                (
                    "OPENCLAW_REMOTE_BRAIN_SECRET",
                    spec.remote_brain_secret.clone(),
                ),
                (
                    "OPENCLAW_REMOTE_BRAIN_TIMEOUT_MS",
                    spec.remote_brain_timeout_ms.to_string(),
                ),
                (
                    "OPENCLAW_REMOTE_BRAIN_MAX_TURNS",
                    spec.remote_brain_max_turns.to_string(),
                ),
            ],
            "openclaw",
            &paths.runtime_startup_log_file,
        ) {
            Ok(child) => child,
            Err(err) => {
                kill_child_if_running(&mut proxy_child);
                return Err(err).context("failed to spawn the OpenClaw gateway runtime");
            }
        };

        let session_id = format!("{}-{}", std::process::id(), Utc::now().timestamp_millis());
        let mut session = RuntimeSession {
            session_id,
            manager_pid: std::process::id(),
            status: "starting".to_string(),
            started_at: started_at.clone(),
            ready_at: None,
            last_heartbeat_at: started_at.clone(),
            last_error: None,
            runtime_root: spec.runtime_root.display().to_string(),
            node_executable_path: spec.node_executable_path.display().to_string(),
            node_version,
            open_claw_root: spec.open_claw_root.display().to_string(),
            open_claw_entry_path: spec.open_claw_entry_path.display().to_string(),
            proxy_root: spec.proxy_root.display().to_string(),
            proxy_entry_path: spec.proxy_entry_path.display().to_string(),
            openclaw_config_path: spec.openclaw_config_path.display().to_string(),
            openclaw_state_dir: spec.openclaw_state_dir.display().to_string(),
            openclaw_bundled_plugins_dir: spec
                .openclaw_bundled_plugins_dir
                .display()
                .to_string(),
            gateway_port: spec.gateway_port,
            proxy_port: spec.proxy_port,
            gateway_pid: Some(gateway_child.id()),
            proxy_pid: Some(proxy_child.id()),
        };

        write_runtime_session(paths, &session)?;

        wait_for_ports_or_child_exit(
            &mut proxy_child,
            &mut gateway_child,
            spec.proxy_port,
            spec.gateway_port,
            startup_timeout_ms,
        )
        .map_err(|err| {
            session.status = "failed".to_string();
            session.last_error = Some(err.to_string());
            let _ = append_startup_log_line(
                &paths.runtime_startup_log_file,
                &format!("[manager] startup failed: {err:#}"),
            );
            let _ = write_runtime_session(paths, &session);
            kill_child_if_running(&mut proxy_child);
            kill_child_if_running(&mut gateway_child);
            let _ = remove_runtime_session(paths);
            err
        })?;

        let ready_at = Utc::now().to_rfc3339();
        session.status = "ready".to_string();
        session.ready_at = Some(ready_at.clone());
        session.last_heartbeat_at = ready_at;
        write_runtime_session(paths, &session)?;
        append_startup_log_line(
            &paths.runtime_startup_log_file,
            &format!(
                "[manager] runtime ready on proxy port {} and gateway port {}",
                spec.proxy_port, spec.gateway_port
            ),
        )?;

        Ok(Self {
            paths: paths.clone(),
            session,
            proxy_child,
            gateway_child,
            stop_timeout_ms: DEFAULT_STOP_TIMEOUT_MS,
        })
    }

    pub fn session(&self) -> &RuntimeSession {
        &self.session
    }

    pub fn run(mut self) -> Result<()> {
        let mut next_heartbeat = Instant::now() + Duration::from_millis(HEARTBEAT_INTERVAL_MS);

        loop {
            if self.paths.runtime_stop_signal_file.exists() {
                self.shutdown("stopping", None)?;
                return Ok(());
            }

            if let Some(exit_message) = self.poll_children()? {
                self.shutdown("failed", Some(exit_message.clone()))?;
                bail!(exit_message);
            }

            if Instant::now() >= next_heartbeat {
                self.session.last_heartbeat_at = Utc::now().to_rfc3339();
                write_runtime_session(&self.paths, &self.session)?;
                next_heartbeat = Instant::now() + Duration::from_millis(HEARTBEAT_INTERVAL_MS);
            }

            thread::sleep(Duration::from_millis(LOOP_INTERVAL_MS));
        }
    }

    fn poll_children(&mut self) -> Result<Option<String>> {
        if let Some(status) = self.proxy_child.try_wait().context("failed to poll proxy process")? {
            return Ok(Some(format!(
                "Lumina proxy exited unexpectedly with code {:?}",
                status.code()
            )));
        }

        if let Some(status) = self
            .gateway_child
            .try_wait()
            .context("failed to poll OpenClaw gateway process")?
        {
            return Ok(Some(format!(
                "OpenClaw gateway exited unexpectedly with code {:?}",
                status.code()
            )));
        }

        Ok(None)
    }

    fn shutdown(&mut self, next_status: &str, last_error: Option<String>) -> Result<()> {
        self.session.status = next_status.to_string();
        self.session.last_error = last_error;
        self.session.last_heartbeat_at = Utc::now().to_rfc3339();
        let _ = write_runtime_session(&self.paths, &self.session);

        kill_child_if_running(&mut self.gateway_child);
        wait_for_child_exit(&mut self.gateway_child, self.stop_timeout_ms);
        kill_child_if_running(&mut self.proxy_child);
        wait_for_child_exit(&mut self.proxy_child, self.stop_timeout_ms);

        remove_runtime_session(&self.paths)?;
        clear_stop_signal(&self.paths)?;
        Ok(())
    }
}

pub fn load_runtime_session(paths: &InstallPaths) -> Result<Option<RuntimeSession>> {
    if !paths.runtime_session_file.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&paths.runtime_session_file).with_context(|| {
        format!(
            "failed to read runtime session file {}",
            paths.runtime_session_file.display()
        )
    })?;
    let state: RuntimeSessionState =
        serde_json::from_str(&content).context("failed to parse runtime session state")?;
    Ok(state.active_session)
}

pub fn request_runtime_stop(paths: &InstallPaths, timeout_ms: u64) -> Result<()> {
    let existing = load_runtime_session(paths)?;
    if existing.is_none() {
        clear_stop_signal(paths)?;
        remove_runtime_session(paths)?;
        return Ok(());
    }

    if let Some(parent) = paths.runtime_stop_signal_file.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&paths.runtime_stop_signal_file, b"stop\n").with_context(|| {
        format!(
            "failed to write stop signal {}",
            paths.runtime_stop_signal_file.display()
        )
    })?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if load_runtime_session(paths)?.is_none() {
            clear_stop_signal(paths)?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }

    if let Some(session) = load_runtime_session(paths)? {
        force_kill_runtime_session(&session)?;
    }
    remove_runtime_session(paths)?;
    clear_stop_signal(paths)?;
    Ok(())
}

fn ensure_runtime_manager_dirs(paths: &InstallPaths) -> Result<()> {
    fs::create_dir_all(&paths.install_root)?;
    if let Some(parent) = paths.runtime_session_file.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn initialize_startup_log(paths: &InstallPaths, spec: &RuntimeLaunchSpec) -> Result<()> {
    if let Some(parent) = paths.runtime_startup_log_file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&paths.runtime_startup_log_file)
        .with_context(|| {
            format!(
                "failed to open startup log {}",
                paths.runtime_startup_log_file.display()
            )
        })?;
    writeln!(file, "[manager] startup log initialized at {}", Utc::now().to_rfc3339())?;
    writeln!(file, "[manager] runtime root: {}", spec.runtime_root.display())?;
    writeln!(
        file,
        "[manager] openclaw root: {}",
        spec.open_claw_root.display()
    )?;
    writeln!(
        file,
        "[manager] bundled plugins: {}",
        spec.openclaw_bundled_plugins_dir.display()
    )?;
    writeln!(file, "[manager] proxy root: {}", spec.proxy_root.display())?;
    Ok(())
}

fn append_startup_log_line(path: &Path, line: &str) -> Result<()> {
    append_startup_log_raw(path, &format!("{line}\n"))
}

fn append_startup_log_raw(path: &Path, text: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("failed to append startup log {}", path.display()))?;
    file.write_all(text.as_bytes())?;
    Ok(())
}

fn validate_launch_spec(spec: &RuntimeLaunchSpec) -> Result<()> {
    validate_file(&spec.node_executable_path, "Node executable")?;
    validate_dir(&spec.open_claw_root, "OpenClaw root")?;
    validate_file(&spec.open_claw_entry_path, "OpenClaw entry")?;
    validate_dir(
        &spec.openclaw_bundled_plugins_dir,
        "OpenClaw bundled plugins directory",
    )?;
    validate_dir(&spec.proxy_root, "Proxy root")?;
    validate_file(&spec.proxy_entry_path, "Proxy entry")?;
    validate_parent_dir(&spec.openclaw_config_path, "OpenClaw config path")?;
    validate_dir(&spec.openclaw_state_dir, "OpenClaw state directory")?;
    Ok(())
}

fn validate_file(path: &Path, label: &str) -> Result<()> {
    if !path.exists() || !path.is_file() {
        bail!("{label} does not exist: {}", path.display());
    }
    Ok(())
}

fn validate_dir(path: &Path, label: &str) -> Result<()> {
    if !path.exists() || !path.is_dir() {
        bail!("{label} does not exist: {}", path.display());
    }
    Ok(())
}

fn validate_parent_dir(path: &Path, label: &str) -> Result<()> {
    let parent = path.parent().context(format!(
        "{label} does not have a parent directory: {}",
        path.display()
    ))?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    Ok(())
}

fn cleanup_existing_runtime_session(paths: &InstallPaths, timeout_ms: u64) -> Result<()> {
    let session = match load_runtime_session(paths)? {
        Some(session) => session,
        None => {
            clear_stop_signal(paths)?;
            return Ok(());
        }
    };

    if !is_runtime_session_alive(&session) {
        force_kill_runtime_session(&session)?;
        remove_runtime_session(paths)?;
        clear_stop_signal(paths)?;
        return Ok(());
    }

    request_runtime_stop(paths, timeout_ms)?;
    Ok(())
}

fn is_runtime_session_alive(session: &RuntimeSession) -> bool {
    session.manager_pid > 0
        && is_pid_alive(session.manager_pid)
        && (is_port_ready(session.proxy_port) || is_port_ready(session.gateway_port))
}

fn read_node_version(node_executable_path: &Path) -> Result<String> {
    let mut command = Command::new(node_executable_path);
    sanitize_node_command_environment(&mut command);
    command
        .arg("-e")
        .arg("process.stdout.write(process.versions.node)")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command.output().with_context(|| {
        format!(
            "failed to execute Node runtime {}",
            node_executable_path.display()
        )
    })?;
    if !output.status.success() {
        bail!(
            "Node runtime check failed for {}: {}",
            node_executable_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version_is_supported(&version) {
        bail!(
            "Lumina OpenClaw requires Node.js v{NODE_MIN_MAJOR}.{NODE_MIN_MINOR}+ but found v{} at {}",
            version,
            node_executable_path.display()
        );
    }
    Ok(version)
}

fn node_version_is_supported(raw_version: &str) -> bool {
    let mut parts = raw_version.trim().split('.');
    let major = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or_default();
    let minor = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or_default();

    major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR)
}

fn spawn_node_child(
    node_executable_path: &Path,
    entry_path: &Path,
    entry_args: &[&str],
    cwd: &Path,
    envs: &[(&str, String)],
    prefix: &str,
    startup_log_path: &Path,
) -> Result<Child> {
    let mut command = Command::new(node_executable_path);
    command
        .arg(entry_path)
        .args(entry_args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    sanitize_node_command_environment(&mut command);

    for (key, value) in envs {
        command.env(key, value);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let _ = append_startup_log_line(
        startup_log_path,
        &format!(
            "[manager] spawning {prefix}: {} {} (cwd: {})",
            node_executable_path.display(),
            entry_path.display(),
            cwd.display()
        ),
    );

    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to spawn runtime child {} via {}",
            entry_path.display(),
            node_executable_path.display()
        )
    })?;

    if let Some(stdout) = child.stdout.take() {
        forward_stream(
            stdout,
            prefix.to_string(),
            false,
            startup_log_path.to_path_buf(),
        );
    }
    if let Some(stderr) = child.stderr.take() {
        forward_stream(
            stderr,
            prefix.to_string(),
            true,
            startup_log_path.to_path_buf(),
        );
    }

    Ok(child)
}

fn forward_stream<R>(stream: R, prefix: String, is_stderr: bool, startup_log_path: PathBuf)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let output = format!("[{prefix}] {line}");
                    if is_stderr {
                        eprint!("{output}");
                    } else {
                        print!("{output}");
                    }
                    let _ = append_startup_log_raw(&startup_log_path, &output);
                }
                Err(_) => break,
            }
        }
    });
}

fn sanitize_node_command_environment(command: &mut Command) {
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

    let inherited_keys: Vec<OsString> = std::env::vars_os().map(|(key, _)| key).collect();
    for key in inherited_keys {
        let key_text = key.to_string_lossy().to_ascii_lowercase();
        if key_text.starts_with("electron_")
            || key_text.starts_with("lumina_")
            || key_text.starts_with("npm_")
            || key_text.starts_with("openclaw_")
            || key_text.starts_with("pnpm_")
            || key_text.starts_with("vite_")
            || key_text.starts_with("yarn_")
        {
            command.env_remove(key);
        }
    }
}

fn wait_for_ports_or_child_exit(
    proxy_child: &mut Child,
    gateway_child: &mut Child,
    proxy_port: u16,
    gateway_port: u16,
    timeout_ms: u64,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if is_port_ready(proxy_port) && is_port_ready(gateway_port) {
            return Ok(());
        }

        if let Some(status) = proxy_child.try_wait().context("failed to poll proxy child")? {
            bail!("Lumina proxy exited before readiness with code {:?}", status.code());
        }
        if let Some(status) = gateway_child
            .try_wait()
            .context("failed to poll OpenClaw gateway child")?
        {
            bail!(
                "OpenClaw gateway exited before readiness with code {:?}",
                status.code()
            );
        }

        if Instant::now() >= deadline {
            bail!(
                "runtime manager timed out while waiting for proxy port {} and gateway port {}",
                proxy_port,
                gateway_port
            );
        }

        thread::sleep(Duration::from_millis(LOOP_INTERVAL_MS));
    }
}

fn is_port_ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok()
}

fn write_runtime_session(paths: &InstallPaths, session: &RuntimeSession) -> Result<()> {
    let state = RuntimeSessionState {
        schema_version: 1,
        updated_at: Utc::now().to_rfc3339(),
        active_session: Some(session.clone()),
    };
    fs::write(
        &paths.runtime_session_file,
        format!("{}\n", serde_json::to_string_pretty(&state)?),
    )
    .with_context(|| {
        format!(
            "failed to write runtime session file {}",
            paths.runtime_session_file.display()
        )
    })?;
    Ok(())
}

fn remove_runtime_session(paths: &InstallPaths) -> Result<()> {
    if paths.runtime_session_file.exists() {
        fs::remove_file(&paths.runtime_session_file).with_context(|| {
            format!(
                "failed to remove runtime session file {}",
                paths.runtime_session_file.display()
            )
        })?;
    }
    Ok(())
}

fn clear_stop_signal(paths: &InstallPaths) -> Result<()> {
    if paths.runtime_stop_signal_file.exists() {
        fs::remove_file(&paths.runtime_stop_signal_file).with_context(|| {
            format!(
                "failed to remove runtime stop signal {}",
                paths.runtime_stop_signal_file.display()
            )
        })?;
    }
    Ok(())
}

fn is_pid_alive(pid: u32) -> bool {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system.process(Pid::from_u32(pid)).is_some()
}

fn force_kill_runtime_session(session: &RuntimeSession) -> Result<()> {
    for pid in [session.gateway_pid, session.proxy_pid, Some(session.manager_pid)]
        .into_iter()
        .flatten()
    {
        force_kill_pid(pid);
    }
    Ok(())
}

fn force_kill_pid(pid: u32) {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    if let Some(process) = system.process(Pid::from_u32(pid)) {
        let _ = process.kill();
    }
}

fn kill_child_if_running(child: &mut Child) {
    let _ = child.kill();
}

fn wait_for_child_exit(child: &mut Child, timeout_ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_support_requires_minimum_major_minor() {
        assert!(node_version_is_supported("22.12.0"));
        assert!(node_version_is_supported("24.0.0"));
        assert!(!node_version_is_supported("22.11.9"));
        assert!(!node_version_is_supported("20.18.1"));
    }
}
