fn main() {
    println!("cargo:rerun-if-env-changed=LUMINA_TAURI_EMBED_RESOURCES");

    let embed_resources = matches!(
        std::env::var("LUMINA_TAURI_EMBED_RESOURCES").as_deref(),
        Ok("1" | "true" | "yes" | "on")
    );

    if !embed_resources {
        std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"resources":[]}}"#);
    }

    tauri_build::build()
}
