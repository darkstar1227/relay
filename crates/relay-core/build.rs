fn main() {
    let package = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let bytes = std::fs::read(package).expect("package.json must be available to build Relay core");
    let value: serde_json::Value = serde_json::from_slice(&bytes).expect("invalid package.json");
    let version = value["version"]
        .as_str()
        .expect("package.json version must be a string");
    assert!(
        version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b)),
        "invalid release version"
    );
    println!("cargo:rustc-env=RELAY_VERSION={version}");
    println!(
        "cargo:rustc-env=RELAY_TARGET={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    println!(
        "cargo:rustc-env=RELAY_PROFILE={}",
        std::env::var("PROFILE").expect("Cargo profile")
    );
}
