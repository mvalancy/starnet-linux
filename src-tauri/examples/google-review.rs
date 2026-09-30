//! Developer-only Google verification preview. Never part of the installed app.
//! cargo run --example google-review -- <installed-client.json> [port] [--with-model]
//!
//! Opens EVERY Google Workspace service (dev/google-review-release.cjs) against real Google endpoints in an
//! isolated review workspace, so the data-access verification demo can be recorded. See
//! docs/GOOGLE_REVIEW_BUILD.md. --with-model keeps the model/key from dev/.env.dev (or your shell) so an
//! agent can actually drive the Google tools on camera; without it the station runs the offline replay model.
#[allow(dead_code)]
#[path = "../src/credentials.rs"]
mod credentials;

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let with_model = args.iter().any(|a| a == "--with-model");
    let mut positional = args.iter().filter(|a| !a.starts_with("--"));
    let client_file = positional
        .next()
        .ok_or("Supply Google's installed Desktop client JSON path")?;
    let port: u16 = positional
        .next()
        .map(String::as_str)
        .unwrap_or("9498")
        .parse()
        .map_err(|_| "Invalid preview port")?;
    if port < 1024 {
        return Err("Use an unprivileged preview port".into());
    }
    let client =
        std::fs::read_to_string(client_file).map_err(|_| "Cannot read Desktop registration")?;
    let parsed: serde_json::Value =
        serde_json::from_str(&client).map_err(|_| "Invalid Desktop registration JSON")?;
    if !parsed["installed"].is_object() || !parsed["web"].is_null() {
        return Err(
            "Use an installed Desktop registration, never a confidential Web client".into(),
        );
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Missing repository root")?;
    let key = credentials::connector_encryption_key()?;
    let node = std::env::var_os("STARNET_REVIEW_NODE").unwrap_or_else(|| "node".into());
    // Dedicated, kept review workspace: the recording demonstrates restart continuity, and it never
    // shares state with the general dev seed. dev/ is gitignored scratch, never bundled.
    let workspace = root.join("dev/.google-review-workspace");
    // NODE_OPTIONS paths must not contain spaces or quotes; forward slashes work on every platform.
    let preload = root
        .join("dev/google-review-release.cjs")
        .to_string_lossy()
        .replace('\\', "/");
    if preload.contains(' ') || preload.contains('"') {
        return Err(
            "Move the repository to a path without spaces to run the review preview".into(),
        );
    }
    eprintln!("Google review preview: http://127.0.0.1:{port}");
    eprintln!("UNVERIFIED developer preview: real Google endpoints, ALL Workspace services open; isolated dev/.google-review-workspace; no public activation.");
    eprintln!("Google-derived content outside connector credentials is not encrypted by this candidate. Use a dedicated test account and test data.");
    if !with_model {
        eprintln!("Offline replay model: agents cannot drive Google tools. Re-run with --with-model to record the demo.");
    }
    let mut cmd = std::process::Command::new(node);
    cmd.current_dir(root)
        .arg(root.join("dev/seed.js"))
        .arg("--workspace")
        .arg(&workspace)
        .arg("--keep")
        // Only the review launcher's own preload rides NODE_OPTIONS; anything inherited is dropped.
        .env("NODE_OPTIONS", format!("--require={preload}"))
        .env("STARNET_GOOGLE_REVIEW", "1")
        .env("STARNET_CONNECTOR_ENCRYPTION_KEY", key)
        .env("STARNET_DESKTOP_SHELL", "1")
        .env("STARNET_GOOGLE_DESKTOP_CLIENT_JSON", client)
        .env("SKYNET_WORKSPACES", &workspace)
        .env("STARNET_WORKSPACES", &workspace)
        .env("SKYNET_PORT", port.to_string())
        .env("STARNET_PORT", port.to_string());
    if !with_model {
        cmd.env("SKYNET_OPENROUTER_KEY", "")
            .env("STARNET_OPENROUTER_KEY", "")
            .env("SKYNET_DEFAULT_MODEL", "replay")
            .env("STARNET_DEFAULT_MODEL", "replay");
    }
    let status = cmd
        .status()
        .map_err(|_| "Unable to launch review sidecar")?;
    if status.success() {
        Ok(())
    } else {
        Err("Review sidecar stopped with an error; inspect its log".into())
    }
}
