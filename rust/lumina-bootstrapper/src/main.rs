mod contract;
mod runtime_manager;

use anyhow::{bail, Context, Result};
use chrono::Utc;
use clap::{Args, Parser, Subcommand};
use contract::{BundleManifest, ReleaseManifest};
use reqwest::blocking::Client;
use runtime_manager::{load_runtime_session, request_runtime_stop, RuntimeLaunchSpec, RuntimeManager};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tar::Archive;
use url::Url;
use walkdir::WalkDir;

const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Parser, Debug)]
#[command(name = "lumina-bootstrapper")]
#[command(about = "Installs and resolves external Lumina desktop runtimes")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Install(InstallArgs),
    CheckUpdate(CheckUpdateArgs),
    Status(OutputArgs),
    ResolveRuntime(OutputArgs),
    Start(StartArgs),
    Stop(StopArgs),
}

#[derive(Args, Debug)]
struct InstallArgs {
    #[arg(long)]
    release_manifest: String,
    #[arg(long)]
    install_root: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    force: bool,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(Args, Debug)]
struct CheckUpdateArgs {
    #[arg(long)]
    release_manifest: String,
    #[arg(long)]
    install_root: Option<PathBuf>,
    #[arg(long)]
    current_version: Option<String>,
    #[arg(long)]
    current_channel: Option<String>,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(Args, Debug)]
struct OutputArgs {
    #[arg(long)]
    install_root: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(Args, Debug)]
struct StartArgs {
    #[arg(long)]
    install_root: Option<PathBuf>,
    #[arg(long)]
    runtime_root: PathBuf,
    #[arg(long)]
    node_executable_path: PathBuf,
    #[arg(long)]
    open_claw_root: PathBuf,
    #[arg(long)]
    open_claw_entry_path: PathBuf,
    #[arg(long)]
    openclaw_bundled_plugins_dir: PathBuf,
    #[arg(long)]
    proxy_root: PathBuf,
    #[arg(long)]
    proxy_entry_path: PathBuf,
    #[arg(long)]
    openclaw_config_path: PathBuf,
    #[arg(long)]
    openclaw_state_dir: PathBuf,
    #[arg(long)]
    gateway_token: String,
    #[arg(long)]
    gateway_port: u16,
    #[arg(long)]
    proxy_port: u16,
    #[arg(long)]
    i24d_chat_url: String,
    #[arg(long)]
    i24d_models_base_url: String,
    #[arg(long, default_value = "")]
    i24d_token: String,
    #[arg(long, action = clap::ArgAction::Set, default_value_t = true)]
    skip_openclaw_channels: bool,
    #[arg(long, default_value_t = false)]
    remote_brain_enabled: bool,
    #[arg(long, default_value = "")]
    remote_brain_url: String,
    #[arg(long, default_value = "")]
    remote_brain_secret: String,
    #[arg(long, default_value_t = 45_000)]
    remote_brain_timeout_ms: u64,
    #[arg(long, default_value_t = 8)]
    remote_brain_max_turns: u32,
    #[arg(long, default_value_t = 30_000)]
    startup_timeout_ms: u64,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(Args, Debug)]
struct StopArgs {
    #[arg(long)]
    install_root: Option<PathBuf>,
    #[arg(long, default_value_t = 15_000)]
    timeout_ms: u64,
    #[arg(long, default_value_t = false)]
    json: bool,
}

#[derive(Debug, Clone)]
enum ManifestSource {
    Url(Url),
    File(PathBuf),
}

#[derive(Debug, Clone)]
pub struct InstallPaths {
    pub install_root: PathBuf,
    pub downloads_dir: PathBuf,
    pub releases_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub state_file: PathBuf,
    pub runtime_session_file: PathBuf,
    pub runtime_stop_signal_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
    schema_version: u32,
    updated_at: String,
    active_release: Option<InstalledRelease>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRelease {
    release_id: String,
    channel: String,
    bundle_id: String,
    bundle_version: String,
    platform: String,
    arch: String,
    runtime_root: String,
    bundle_manifest_path: String,
    release_manifest_source: String,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    install_root: String,
    state_file: String,
    active_release: Option<InstalledRelease>,
    runtime_session: Option<runtime_manager::RuntimeSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedRuntime {
    release_id: String,
    bundle_id: String,
    bundle_version: String,
    channel: String,
    runtime_root: String,
    bundle_manifest_path: String,
    defaults_file_path: String,
    node_executable_path: String,
    open_claw_entry_path: String,
    ui_index_path: String,
    proxy_entry_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheckStatus {
    supported: bool,
    available: bool,
    current_version: Option<String>,
    latest_version: String,
    current_channel: Option<String>,
    latest_channel: String,
    release_manifest_source: String,
}

#[derive(Debug)]
struct FileDigest {
    byte_size: u64,
    file_count: u64,
    sha256: String,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("[lumina-bootstrapper] {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Install(args) => {
            let source = parse_manifest_source(&args.release_manifest)?;
            let install_paths = resolve_install_paths(args.install_root);
            let release = install_runtime(&source, &install_paths, args.force)?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&release)?);
            } else {
                println!(
                    "Installed runtime {} at {}",
                    release.bundle_version, release.runtime_root
                );
            }
        }
        Commands::CheckUpdate(args) => {
            let source = parse_manifest_source(&args.release_manifest)?;
            let install_paths = resolve_install_paths(args.install_root);
            let status = check_update(
                &source,
                &install_paths,
                args.current_version,
                args.current_channel,
            )?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&status)?);
            } else if status.available {
                println!(
                    "Runtime update available: {} -> {}",
                    status.current_version.unwrap_or_else(|| "none".to_string()),
                    status.latest_version
                );
            } else {
                println!(
                    "Runtime is current at {}",
                    status
                        .current_version
                        .unwrap_or_else(|| status.latest_version.clone())
                );
            }
        }
        Commands::Status(args) => {
            let install_paths = resolve_install_paths(args.install_root);
            let state = load_state(&install_paths)?;
            let status = RuntimeStatus {
                install_root: install_paths.install_root.display().to_string(),
                state_file: install_paths.state_file.display().to_string(),
                active_release: state.active_release,
                runtime_session: load_runtime_session(&install_paths)?,
            };
            if args.json {
                println!("{}", serde_json::to_string_pretty(&status)?);
            } else {
                match (&status.active_release, &status.runtime_session) {
                    (Some(active), Some(session)) => {
                        println!(
                            "Active runtime {} ({}) at {}",
                            active.bundle_version, active.release_id, active.runtime_root
                        );
                        println!(
                            "Runtime manager session {} ({}) using gateway {} and proxy {}",
                            session.session_id, session.status, session.gateway_port, session.proxy_port
                        );
                    }
                    (Some(active), None) => {
                        println!(
                            "Active runtime {} ({}) at {}",
                            active.bundle_version, active.release_id, active.runtime_root
                        );
                    }
                    (None, Some(session)) => {
                        println!(
                            "Runtime manager session {} ({}) using gateway {} and proxy {}",
                            session.session_id, session.status, session.gateway_port, session.proxy_port
                        );
                    }
                    (None, None) => {
                        println!("No active external runtime installed.");
                    }
                }
            }
        }
        Commands::ResolveRuntime(args) => {
            let install_paths = resolve_install_paths(args.install_root);
            let resolved = resolve_active_runtime(&install_paths)?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&resolved)?);
            } else {
                println!("{}", resolved.runtime_root);
            }
        }
        Commands::Start(args) => {
            let install_paths = resolve_install_paths(args.install_root);
            let manager = RuntimeManager::start(
                &install_paths,
                RuntimeLaunchSpec {
                    runtime_root: args.runtime_root,
                    node_executable_path: args.node_executable_path,
                    open_claw_root: args.open_claw_root,
                    open_claw_entry_path: args.open_claw_entry_path,
                    openclaw_bundled_plugins_dir: args.openclaw_bundled_plugins_dir,
                    proxy_root: args.proxy_root,
                    proxy_entry_path: args.proxy_entry_path,
                    openclaw_config_path: args.openclaw_config_path,
                    openclaw_state_dir: args.openclaw_state_dir,
                    gateway_token: args.gateway_token,
                    gateway_port: args.gateway_port,
                    proxy_port: args.proxy_port,
                    i24d_chat_url: args.i24d_chat_url,
                    i24d_models_base_url: args.i24d_models_base_url,
                    i24d_token: args.i24d_token,
                    skip_openclaw_channels: args.skip_openclaw_channels,
                    remote_brain_enabled: args.remote_brain_enabled,
                    remote_brain_url: args.remote_brain_url,
                    remote_brain_secret: args.remote_brain_secret,
                    remote_brain_timeout_ms: args.remote_brain_timeout_ms,
                    remote_brain_max_turns: args.remote_brain_max_turns,
                },
                args.startup_timeout_ms,
            )?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(manager.session())?);
            } else {
                println!(
                    "Started runtime manager session {} on gateway {}",
                    manager.session().session_id,
                    manager.session().gateway_port
                );
            }
            manager.run()?;
        }
        Commands::Stop(args) => {
            let install_paths = resolve_install_paths(args.install_root);
            request_runtime_stop(&install_paths, args.timeout_ms)?;
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "stopped": true,
                        "installRoot": install_paths.install_root.display().to_string(),
                    }))?
                );
            } else {
                println!("Stopped the Lumina runtime manager session.");
            }
        }
    }

    Ok(())
}

fn parse_manifest_source(raw: &str) -> Result<ManifestSource> {
    if let Ok(url) = Url::parse(raw) {
        if matches!(url.scheme(), "http" | "https") {
            return Ok(ManifestSource::Url(url));
        }
    }

    let candidate = PathBuf::from(raw);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()?.join(candidate)
    };
    Ok(ManifestSource::File(resolved))
}

fn resolve_install_paths(install_root: Option<PathBuf>) -> InstallPaths {
    let default_root = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".lumina")
        .join("runtime-manager");
    let root = install_root.unwrap_or(default_root);
    InstallPaths {
        downloads_dir: root.join("downloads"),
        releases_dir: root.join("releases"),
        staging_dir: root.join("staging"),
        state_file: root.join("state.json"),
        runtime_session_file: root.join("runtime-session.json"),
        runtime_stop_signal_file: root.join("runtime-stop.signal"),
        install_root: root,
    }
}

fn install_runtime(
    source: &ManifestSource,
    paths: &InstallPaths,
    force: bool,
) -> Result<InstalledRelease> {
    ensure_install_dirs(paths)?;

    let client = build_http_client()?;
    let release_manifest_text = read_text_from_source(source, &client)?;
    let release_manifest: ReleaseManifest =
        serde_json::from_str(&release_manifest_text).context("failed to parse release manifest")?;
    release_manifest.validate_basic()?;
    release_manifest.validate_target_matches_host()?;

    let runtime_bundle_artifact = release_manifest.runtime_bundle_artifact()?.clone();
    let detached_bundle_manifest_artifact =
        release_manifest.detached_bundle_manifest_artifact()?.clone();

    let transaction_id = format!(
        "{}-{}-{}",
        release_manifest.version,
        std::process::id(),
        Utc::now().timestamp_millis()
    );
    let transaction_root = paths.staging_dir.join(transaction_id);
    let downloads_root = transaction_root.join("downloads");
    let downloaded_bundle_path = downloads_root.join(&runtime_bundle_artifact.file_name);
    let detached_bundle_manifest_path =
        downloads_root.join(&detached_bundle_manifest_artifact.file_name);
    let extracted_root = transaction_root.join("extracted");
    let assembled_runtime_root = transaction_root.join("runtime-root");

    fs::create_dir_all(&transaction_root)?;
    fs::create_dir_all(&downloads_root)?;
    fetch_artifact_to_path(
        source,
        &runtime_bundle_artifact,
        &downloaded_bundle_path,
        &client,
    )?;
    fetch_artifact_to_path(
        source,
        &detached_bundle_manifest_artifact,
        &detached_bundle_manifest_path,
        &client,
    )?;

    verify_file_artifact(&runtime_bundle_artifact, &downloaded_bundle_path)?;
    verify_file_artifact(
        &detached_bundle_manifest_artifact,
        &detached_bundle_manifest_path,
    )?;

    let bundle_manifest: BundleManifest = serde_json::from_str(
        &fs::read_to_string(&detached_bundle_manifest_path)
            .with_context(|| format!("failed to read {}", detached_bundle_manifest_path.display()))?,
    )
    .context("failed to parse detached bundle manifest")?;
    bundle_manifest.validate_basic()?;
    release_manifest.validate_bundle_linkage(&display_source(source), &bundle_manifest)?;

    extract_runtime_bundle(&downloaded_bundle_path, &extracted_root)?;

    let extracted_bundle_manifest_path = extracted_root.join("bundle.manifest.json");
    let expected_bundle_manifest_sha = runtime_bundle_artifact
        .bundle_manifest_sha256
        .clone()
        .context("runtime bundle artifact is missing bundleManifestSha256")?;
    let extracted_bundle_manifest_sha = compute_file_sha256(&extracted_bundle_manifest_path)?;
    if extracted_bundle_manifest_sha != expected_bundle_manifest_sha {
        bail!(
            "extracted bundle manifest sha256 mismatch: expected {}, got {}",
            expected_bundle_manifest_sha,
            extracted_bundle_manifest_sha
        );
    }

    verify_extracted_payload(&bundle_manifest, &extracted_root)?;
    assemble_runtime_root(
        &bundle_manifest,
        &release_manifest_text,
        &detached_bundle_manifest_path,
        &extracted_root,
        &assembled_runtime_root,
    )?;

    let release_id = format!(
        "{}-{}-{}",
        bundle_manifest.bundle_version, bundle_manifest.platform, bundle_manifest.arch
    );
    let final_release_dir = paths.releases_dir.join(&release_id);
    if final_release_dir.exists() {
        if force {
            fs::remove_dir_all(&final_release_dir).with_context(|| {
                format!("failed to remove existing release {}", final_release_dir.display())
            })?;
        } else if final_release_dir.join("bundle.manifest.json").exists() {
            let existing = InstalledRelease {
                release_id: release_id.clone(),
                channel: release_manifest.channel.clone(),
                bundle_id: bundle_manifest.bundle_id.clone(),
                bundle_version: bundle_manifest.bundle_version.clone(),
                platform: bundle_manifest.platform.clone(),
                arch: bundle_manifest.arch.clone(),
                runtime_root: final_release_dir.display().to_string(),
                bundle_manifest_path: final_release_dir
                    .join("bundle.manifest.json")
                    .display()
                    .to_string(),
                release_manifest_source: display_source(source),
                installed_at: Utc::now().to_rfc3339(),
            };
            write_state(
                paths,
                &BootstrapState {
                    schema_version: STATE_SCHEMA_VERSION,
                    updated_at: Utc::now().to_rfc3339(),
                    active_release: Some(existing.clone()),
                },
            )?;
            clean_directory_if_exists(&transaction_root)?;
            return Ok(existing);
        } else {
            fs::remove_dir_all(&final_release_dir).with_context(|| {
                format!(
                    "failed to replace corrupt existing release {}",
                    final_release_dir.display()
                )
            })?;
        }
    }

    fs::rename(&assembled_runtime_root, &final_release_dir).with_context(|| {
        format!(
            "failed to activate assembled runtime {} -> {}",
            assembled_runtime_root.display(),
            final_release_dir.display()
        )
    })?;

    let installed_release = InstalledRelease {
        release_id,
        channel: release_manifest.channel,
        bundle_id: bundle_manifest.bundle_id,
        bundle_version: bundle_manifest.bundle_version,
        platform: bundle_manifest.platform,
        arch: bundle_manifest.arch,
        runtime_root: final_release_dir.display().to_string(),
        bundle_manifest_path: final_release_dir
            .join("bundle.manifest.json")
            .display()
            .to_string(),
        release_manifest_source: display_source(source),
        installed_at: Utc::now().to_rfc3339(),
    };

    write_state(
        paths,
        &BootstrapState {
            schema_version: STATE_SCHEMA_VERSION,
            updated_at: Utc::now().to_rfc3339(),
            active_release: Some(installed_release.clone()),
        },
    )?;
    clean_directory_if_exists(&transaction_root)?;
    Ok(installed_release)
}

fn check_update(
    source: &ManifestSource,
    paths: &InstallPaths,
    current_version: Option<String>,
    current_channel: Option<String>,
) -> Result<UpdateCheckStatus> {
    ensure_install_dirs(paths)?;

    let client = build_http_client()?;
    let release_manifest_text = read_text_from_source(source, &client)?;
    let release_manifest: ReleaseManifest =
        serde_json::from_str(&release_manifest_text).context("failed to parse release manifest")?;
    release_manifest.validate_basic()?;
    release_manifest.validate_target_matches_host()?;

    let state = load_state(paths)?;
    let effective_current_version = normalize_optional_string(current_version).or_else(|| {
        state
            .active_release
            .as_ref()
            .map(|release| release.bundle_version.clone())
    });
    let effective_current_channel = normalize_optional_string(current_channel).or_else(|| {
        state
            .active_release
            .as_ref()
            .map(|release| release.channel.clone())
    });
    let available = effective_current_version
        .as_deref()
        .map(|version| compare_versions(version, &release_manifest.version) == Ordering::Less)
        .unwrap_or(true);

    Ok(UpdateCheckStatus {
        supported: true,
        available,
        current_version: effective_current_version,
        latest_version: release_manifest.version,
        current_channel: effective_current_channel,
        latest_channel: release_manifest.channel,
        release_manifest_source: display_source(source),
    })
}

fn resolve_active_runtime(paths: &InstallPaths) -> Result<ResolvedRuntime> {
    let state = load_state(paths)?;
    let active = state
        .active_release
        .context("no active external runtime is installed")?;
    let runtime_root = PathBuf::from(&active.runtime_root);
    let bundle_manifest_path = runtime_root.join("bundle.manifest.json");
    let bundle_manifest: BundleManifest =
        serde_json::from_str(&fs::read_to_string(&bundle_manifest_path).with_context(|| {
            format!("failed to read {}", bundle_manifest_path.display())
        })?)
        .context("failed to parse active bundle manifest")?;
    bundle_manifest.validate_basic()?;

    Ok(ResolvedRuntime {
        release_id: active.release_id,
        bundle_id: bundle_manifest.bundle_id,
        bundle_version: bundle_manifest.bundle_version,
        channel: bundle_manifest.channel,
        runtime_root: runtime_root.display().to_string(),
        bundle_manifest_path: bundle_manifest_path.display().to_string(),
        defaults_file_path: runtime_root
            .join(normalize_relative_path(&bundle_manifest.launch.defaults_file)?)
            .display()
            .to_string(),
        node_executable_path: runtime_root
            .join(normalize_relative_path(&bundle_manifest.launch.node_executable)?)
            .display()
            .to_string(),
        open_claw_entry_path: runtime_root
            .join(normalize_relative_path(&bundle_manifest.launch.open_claw_entry)?)
            .display()
            .to_string(),
        ui_index_path: runtime_root
            .join(normalize_relative_path(&bundle_manifest.launch.ui_index)?)
            .display()
            .to_string(),
        proxy_entry_path: runtime_root
            .join(normalize_relative_path(&bundle_manifest.launch.proxy_entry)?)
            .display()
            .to_string(),
    })
}

fn build_http_client() -> Result<Client> {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .user_agent("lumina-bootstrapper/1.0.0")
        .build()
        .context("failed to build HTTP client")
}

fn ensure_install_dirs(paths: &InstallPaths) -> Result<()> {
    fs::create_dir_all(&paths.install_root)?;
    fs::create_dir_all(&paths.downloads_dir)?;
    fs::create_dir_all(&paths.releases_dir)?;
    fs::create_dir_all(&paths.staging_dir)?;
    Ok(())
}

fn read_text_from_source(source: &ManifestSource, client: &Client) -> Result<String> {
    match source {
        ManifestSource::Url(url) => client
            .get(url.clone())
            .send()
            .context("failed to fetch release manifest")?
            .error_for_status()
            .context("release manifest request failed")?
            .text()
            .context("failed to read release manifest body"),
        ManifestSource::File(path) => fs::read_to_string(path)
            .with_context(|| format!("failed to read release manifest {}", path.display())),
    }
}

fn fetch_artifact_to_path(
    release_source: &ManifestSource,
    artifact: &contract::ReleaseArtifact,
    target_path: &Path,
    client: &Client,
) -> Result<()> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let bytes = if let Some(url) = &artifact.url {
        client
            .get(url)
            .send()
            .with_context(|| format!("failed to download artifact {}", artifact.id))?
            .error_for_status()
            .with_context(|| format!("artifact request failed for {}", artifact.id))?
            .bytes()
            .with_context(|| format!("failed to read artifact body for {}", artifact.id))?
            .to_vec()
    } else {
        match release_source {
            ManifestSource::Url(base_url) => {
                let artifact_url = base_url
                    .join(&artifact.relative_path)
                    .with_context(|| format!("failed to resolve artifact URL for {}", artifact.id))?;
                client
                    .get(artifact_url)
                    .send()
                    .with_context(|| format!("failed to download artifact {}", artifact.id))?
                    .error_for_status()
                    .with_context(|| format!("artifact request failed for {}", artifact.id))?
                    .bytes()
                    .with_context(|| format!("failed to read artifact body for {}", artifact.id))?
                    .to_vec()
            }
            ManifestSource::File(manifest_path) => {
                let base_dir = manifest_path
                    .parent()
                    .context("release manifest file path does not have a parent directory")?;
                fs::read(base_dir.join(&artifact.relative_path)).with_context(|| {
                    format!(
                        "failed to read artifact {} relative to {}",
                        artifact.id,
                        manifest_path.display()
                    )
                })?
            }
        }
    };

    let mut file = File::create(target_path)
        .with_context(|| format!("failed to create {}", target_path.display()))?;
    file.write_all(&bytes)
        .with_context(|| format!("failed to write {}", target_path.display()))?;
    Ok(())
}

fn verify_file_artifact(artifact: &contract::ReleaseArtifact, target_path: &Path) -> Result<()> {
    let metadata = fs::metadata(target_path)
        .with_context(|| format!("failed to stat {}", target_path.display()))?;
    if metadata.len() != artifact.byte_size {
        bail!(
            "artifact {} byte size mismatch: expected {}, got {}",
            artifact.id,
            artifact.byte_size,
            metadata.len()
        );
    }
    let sha256 = compute_file_sha256(target_path)?;
    if sha256 != artifact.sha256 {
        bail!(
            "artifact {} sha256 mismatch: expected {}, got {}",
            artifact.id,
            artifact.sha256,
            sha256
        );
    }
    Ok(())
}

fn extract_runtime_bundle(archive_path: &Path, extract_root: &Path) -> Result<()> {
    fs::create_dir_all(extract_root)?;
    let archive_file =
        File::open(archive_path).with_context(|| format!("failed to open {}", archive_path.display()))?;
    let decoder = flate2::read::GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);

    for entry in archive.entries().context("failed to enumerate bundle archive entries")? {
        let mut entry = entry.context("failed to read bundle archive entry")?;
        let entry_path = entry.path().context("failed to read archive entry path")?;
        let relative_path = normalize_archive_path(entry_path.as_ref())?;
        let destination = extract_root.join(&relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&destination).with_context(|| {
            format!(
                "failed to unpack archive entry {} to {}",
                relative_path.display(),
                destination.display()
            )
        })?;
    }

    Ok(())
}

fn verify_extracted_payload(bundle_manifest: &BundleManifest, extracted_root: &Path) -> Result<()> {
    for entry in &bundle_manifest.entries {
        let relative_path = normalize_relative_path(&entry.bundle_relative_path)?;
        let target_path = extracted_root.join(&relative_path);
        if !target_path.exists() {
            bail!(
                "bundle entry {} is missing from extracted archive: {}",
                entry.id,
                target_path.display()
            );
        }
        let digest = if target_path.is_dir() {
            compute_directory_digest(&target_path)?
        } else {
            FileDigest {
                byte_size: fs::metadata(&target_path)?.len(),
                file_count: 1,
                sha256: compute_file_sha256(&target_path)?,
            }
        };
        if digest.byte_size != entry.byte_size {
            bail!(
                "bundle entry {} byte size mismatch: expected {}, got {}",
                entry.id,
                entry.byte_size,
                digest.byte_size
            );
        }
        if digest.file_count != entry.file_count {
            bail!(
                "bundle entry {} file count mismatch: expected {}, got {}",
                entry.id,
                entry.file_count,
                digest.file_count
            );
        }
        if digest.sha256 != entry.sha256 {
            bail!("bundle entry {} sha256 mismatch", entry.id);
        }
    }

    Ok(())
}

fn assemble_runtime_root(
    bundle_manifest: &BundleManifest,
    release_manifest_text: &str,
    detached_bundle_manifest_path: &Path,
    extracted_root: &Path,
    assembled_runtime_root: &Path,
) -> Result<()> {
    clean_directory_if_exists(assembled_runtime_root)?;
    fs::create_dir_all(assembled_runtime_root)?;

    fs::copy(
        detached_bundle_manifest_path,
        assembled_runtime_root.join("bundle.manifest.json"),
    )
    .context("failed to stage detached bundle manifest into the runtime root")?;
    fs::write(
        assembled_runtime_root.join("release.manifest.json"),
        release_manifest_text,
    )
    .context("failed to stage release manifest into the runtime root")?;

    let payload_root = extracted_root.join(normalize_relative_path(&bundle_manifest.install.payload_root)?);
    for entry in fs::read_dir(&payload_root)
        .with_context(|| format!("failed to enumerate payload root {}", payload_root.display()))?
    {
        let entry = entry?;
        let source_path = entry.path();
        let target = assembled_runtime_root.join(entry.file_name());
        if fs::rename(&source_path, &target).is_err() {
            copy_path_recursively(&source_path, &target)?;
            clean_path_if_exists(&source_path)?;
        }
    }

    Ok(())
}

fn load_state(paths: &InstallPaths) -> Result<BootstrapState> {
    if !paths.state_file.exists() {
        return Ok(BootstrapState {
            schema_version: STATE_SCHEMA_VERSION,
            updated_at: Utc::now().to_rfc3339(),
            active_release: None,
        });
    }

    let content = fs::read_to_string(&paths.state_file)
        .with_context(|| format!("failed to read {}", paths.state_file.display()))?;
    let state: BootstrapState =
        serde_json::from_str(&content).context("failed to parse bootstrap state")?;
    Ok(state)
}

fn write_state(paths: &InstallPaths, state: &BootstrapState) -> Result<()> {
    if let Some(parent) = paths.state_file.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        &paths.state_file,
        format!("{}\n", serde_json::to_string_pretty(state)?),
    )
    .with_context(|| format!("failed to write {}", paths.state_file.display()))?;
    Ok(())
}

fn display_source(source: &ManifestSource) -> String {
    match source {
        ManifestSource::Url(url) => url.to_string(),
        ManifestSource::File(path) => path.display().to_string(),
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedVersion {
    core: Vec<u64>,
    prerelease: Option<Vec<PrereleaseIdentifier>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PrereleaseIdentifier {
    Numeric(u64),
    Alpha(String),
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    match (parse_version(left), parse_version(right)) {
        (Some(left), Some(right)) => compare_parsed_versions(&left, &right),
        _ => left.trim().cmp(right.trim()),
    }
}

fn parse_version(value: &str) -> Option<ParsedVersion> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core_raw, prerelease_raw) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };

    let core: Vec<u64> = core_raw
        .split('.')
        .map(|segment| segment.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;

    if core.is_empty() {
        return None;
    }

    let prerelease = match prerelease_raw {
        Some(raw) if raw.is_empty() => return None,
        Some(raw) => Some(
            raw.split('.')
                .map(parse_prerelease_identifier)
                .collect::<Option<Vec<_>>>()?,
        ),
        None => None,
    };

    Some(ParsedVersion { core, prerelease })
}

fn parse_prerelease_identifier(value: &str) -> Option<PrereleaseIdentifier> {
    if value.is_empty() {
        return None;
    }
    if value.chars().all(|character| character.is_ascii_digit()) {
        return value
            .parse::<u64>()
            .ok()
            .map(PrereleaseIdentifier::Numeric);
    }
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Some(PrereleaseIdentifier::Alpha(value.to_string()));
    }
    None
}

fn compare_parsed_versions(left: &ParsedVersion, right: &ParsedVersion) -> Ordering {
    let max_components = left.core.len().max(right.core.len());
    for index in 0..max_components {
        let left_component = left.core.get(index).copied().unwrap_or_default();
        let right_component = right.core.get(index).copied().unwrap_or_default();
        match left_component.cmp(&right_component) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }

    match (&left.prerelease, &right.prerelease) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => compare_prerelease(left, right),
    }
}

fn compare_prerelease(left: &[PrereleaseIdentifier], right: &[PrereleaseIdentifier]) -> Ordering {
    let max_identifiers = left.len().max(right.len());
    for index in 0..max_identifiers {
        match (left.get(index), right.get(index)) {
            (Some(PrereleaseIdentifier::Numeric(left)), Some(PrereleaseIdentifier::Numeric(right))) => {
                match left.cmp(right) {
                    Ordering::Equal => {}
                    ordering => return ordering,
                }
            }
            (Some(PrereleaseIdentifier::Alpha(left)), Some(PrereleaseIdentifier::Alpha(right))) => {
                match left.cmp(right) {
                    Ordering::Equal => {}
                    ordering => return ordering,
                }
            }
            (Some(PrereleaseIdentifier::Numeric(_)), Some(PrereleaseIdentifier::Alpha(_))) => {
                return Ordering::Less
            }
            (Some(PrereleaseIdentifier::Alpha(_)), Some(PrereleaseIdentifier::Numeric(_))) => {
                return Ordering::Greater
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }

    Ordering::Equal
}

fn normalize_relative_path(raw: &str) -> Result<PathBuf> {
    let normalized = raw.replace('\\', "/");
    if normalized.is_empty() || normalized == "." || normalized == ".." {
        bail!("invalid relative path {}", raw);
    }
    if normalized.starts_with('/') || normalized.starts_with("../") || normalized.contains("/../") {
        bail!("path escapes the runtime root: {}", raw);
    }
    Ok(PathBuf::from(normalized))
}

fn normalize_archive_path(raw: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("archive entry path escapes the extraction root: {}", raw.display())
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        bail!("archive entry path resolved to an empty path");
    }
    Ok(normalized)
}

fn compute_file_sha256(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn compute_directory_digest(root: &Path) -> Result<FileDigest> {
    #[derive(Debug)]
    struct FileEntry {
        relative_path: String,
        byte_size: u64,
        sha256: String,
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry?;
        if entry.file_type().is_symlink() {
            bail!("bundle payloads must not contain symbolic links: {}", entry.path().display());
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let relative_path = entry
            .path()
            .strip_prefix(root)
            .with_context(|| format!("failed to relativize {}", entry.path().display()))?;
        let relative_path = relative_path.to_string_lossy().replace('\\', "/");
        files.push(FileEntry {
            relative_path,
            byte_size: entry.metadata()?.len(),
            sha256: compute_file_sha256(entry.path())?,
        });
    }

    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let mut byte_size = 0u64;
    let mut hasher = Sha256::new();
    for file in files.iter() {
        hasher.update(b"file\0");
        hasher.update(file.relative_path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.byte_size.to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\0");
        byte_size += file.byte_size;
    }

    Ok(FileDigest {
        byte_size,
        file_count: files.len() as u64,
        sha256: hex::encode(hasher.finalize()),
    })
}

fn copy_path_recursively(source: &Path, target: &Path) -> Result<()> {
    if source.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_path_recursively(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target).with_context(|| {
        format!(
            "failed to copy {} to {}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn clean_directory_if_exists(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to remove directory {}", path.display()))?;
    }
    Ok(())
}

fn clean_path_if_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to remove directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to remove file {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_target_is_mapped_to_contract_values() {
        assert!(matches!(contract::host_platform(), "win32" | "darwin" | "linux"));
        assert!(matches!(contract::host_arch(), "x64" | "arm64" | "x86" | "ia32" | "arm"));
    }

    #[test]
    fn normalize_relative_path_rejects_escape_sequences() {
        assert!(normalize_relative_path("../escape").is_err());
        assert!(normalize_relative_path("/absolute").is_err());
        assert!(normalize_relative_path("safe/file.txt").is_ok());
    }

    #[test]
    fn normalize_archive_path_rejects_parent_segments() {
        assert!(normalize_archive_path(Path::new("../escape")).is_err());
        assert!(normalize_archive_path(Path::new("payload/ui/index.html")).is_ok());
    }

    #[test]
    fn compare_versions_handles_numeric_progression() {
        assert_eq!(compare_versions("1.2.3", "1.2.4"), Ordering::Less);
        assert_eq!(compare_versions("1.2.10", "1.2.3"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.3", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn compare_versions_handles_prerelease_progression() {
        assert_eq!(compare_versions("1.2.3-beta.1", "1.2.3"), Ordering::Less);
        assert_eq!(compare_versions("1.2.3-beta.2", "1.2.3-beta.10"), Ordering::Less);
        assert_eq!(compare_versions("1.2.3+build.1", "1.2.3+build.9"), Ordering::Equal);
    }
}
