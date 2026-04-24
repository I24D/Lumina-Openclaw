use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub schema_version: u32,
    pub bundle_id: String,
    pub bundle_kind: String,
    pub bundle_version: String,
    pub created_at: String,
    pub channel: String,
    pub platform: String,
    pub arch: String,
    pub product: ProductIdentity,
    pub source: BundleSource,
    pub install: BundleInstall,
    pub launch: BundleLaunch,
    pub entries: Vec<BundleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductIdentity {
    pub app_id: String,
    pub product_name: String,
    pub vendor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSource {
    pub desktop_package_name: String,
    pub desktop_package_version: String,
    pub open_claw_package_name: String,
    pub open_claw_version: String,
    pub host_node_version: String,
    pub lockfile_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInstall {
    pub payload_root: String,
    pub copy_mode: String,
    pub launch_strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleLaunch {
    pub defaults_file: String,
    pub node_executable: String,
    pub open_claw_entry: String,
    pub ui_index: String,
    pub proxy_entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntry {
    pub id: String,
    pub kind: String,
    pub layout: String,
    pub bundle_relative_path: String,
    pub install_relative_path: String,
    pub required: bool,
    pub executable: bool,
    pub byte_size: u64,
    pub file_count: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub manifest_id: String,
    pub channel: String,
    pub version: String,
    pub published_at: String,
    pub product: ProductIdentity,
    pub target: ReleaseTarget,
    pub bundle: ReleaseBundle,
    pub bootstrap: ReleaseBootstrap,
    pub artifacts: Vec<ReleaseArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTarget {
    pub platform: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseBundle {
    pub bundle_id: String,
    pub bundle_version: String,
    pub min_bootstrap_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseBootstrap {
    pub strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifact {
    pub id: String,
    pub role: String,
    pub platform: String,
    pub arch: String,
    pub format: String,
    pub file_name: String,
    pub relative_path: String,
    pub url: Option<String>,
    pub byte_size: u64,
    pub sha256: String,
    pub bundle_manifest_sha256: Option<String>,
    pub bundle_manifest_relative_path: Option<String>,
}

impl BundleManifest {
    pub fn validate_basic(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!("unsupported bundle manifest schemaVersion {}", self.schema_version);
        }
        if self.bundle_kind != "desktop-runtime" {
            bail!("unsupported bundle kind {}", self.bundle_kind);
        }
        if self.install.copy_mode != "merge-contents-of-payload-root" {
            bail!("unsupported bundle copyMode {}", self.install.copy_mode);
        }
        if self.install.launch_strategy != "desktop-runtime-bundle" {
            bail!(
                "unsupported bundle launchStrategy {}",
                self.install.launch_strategy
            );
        }
        if self.entries.is_empty() {
            bail!("bundle manifest entries must not be empty");
        }
        Ok(())
    }
}

impl ReleaseManifest {
    pub fn validate_basic(&self) -> Result<()> {
        if self.schema_version != 1 {
            bail!(
                "unsupported release manifest schemaVersion {}",
                self.schema_version
            );
        }
        if self.bootstrap.strategy != "download-and-expand-runtime-bundle" {
            bail!(
                "unsupported bootstrap strategy {}",
                self.bootstrap.strategy
            );
        }
        if self.artifacts.is_empty() {
            bail!("release manifest artifacts must not be empty");
        }
        Ok(())
    }

    pub fn validate_target_matches_host(&self) -> Result<()> {
        let host_platform = host_platform();
        let host_arch = host_arch();
        if self.target.platform != host_platform {
            bail!(
                "release manifest target platform mismatch: expected {}, got {}",
                host_platform,
                self.target.platform
            );
        }
        if self.target.arch != host_arch {
            bail!(
                "release manifest target arch mismatch: expected {}, got {}",
                host_arch,
                self.target.arch
            );
        }
        Ok(())
    }

    pub fn runtime_bundle_artifact(&self) -> Result<&ReleaseArtifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.role == "runtime-bundle")
            .context("release manifest does not contain a runtime-bundle artifact")
    }

    pub fn detached_bundle_manifest_artifact(&self) -> Result<&ReleaseArtifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.role == "bundle-manifest")
            .context("release manifest does not contain a bundle-manifest artifact")
    }

    pub fn validate_bundle_linkage(
        &self,
        release_source: &str,
        bundle_manifest: &BundleManifest,
    ) -> Result<()> {
        if bundle_manifest.bundle_id != self.bundle.bundle_id {
            bail!(
                "bundle manifest bundleId mismatch: release={}, bundle={}",
                self.bundle.bundle_id,
                bundle_manifest.bundle_id
            );
        }
        if bundle_manifest.bundle_version != self.bundle.bundle_version {
            bail!(
                "bundle manifest version mismatch: release={}, bundle={}",
                self.bundle.bundle_version,
                bundle_manifest.bundle_version
            );
        }
        if bundle_manifest.platform != self.target.platform {
            bail!(
                "bundle manifest platform mismatch: release={}, bundle={}",
                self.target.platform,
                bundle_manifest.platform
            );
        }
        if bundle_manifest.arch != self.target.arch {
            bail!(
                "bundle manifest arch mismatch: release={}, bundle={}",
                self.target.arch,
                bundle_manifest.arch
            );
        }

        let runtime_bundle = self.runtime_bundle_artifact()?;
        if runtime_bundle.platform != self.target.platform || runtime_bundle.arch != self.target.arch {
            bail!("runtime bundle artifact target does not match the release target");
        }

        if runtime_bundle.bundle_manifest_relative_path.is_none()
            || runtime_bundle.bundle_manifest_sha256.is_none()
        {
            bail!("runtime bundle artifact is missing bundle manifest linkage fields");
        }

        let detached_manifest = self.detached_bundle_manifest_artifact()?;
        if detached_manifest.platform != self.target.platform || detached_manifest.arch != self.target.arch
        {
            bail!("detached bundle manifest artifact target does not match the release target");
        }

        if runtime_bundle
            .bundle_manifest_relative_path
            .as_deref()
            != Some(detached_manifest.relative_path.as_str())
        {
            return Err(anyhow!(
                "runtime bundle artifact bundleManifestRelativePath does not point to the detached bundle manifest in {}",
                release_source
            ));
        }

        Ok(())
    }
}

pub fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    }
}

pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}
