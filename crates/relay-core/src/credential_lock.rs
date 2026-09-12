use crate::{storage, Result};

/// Hold the same inode/flock as the existing Python daemon until FIFO EOF.
#[cfg(unix)]
pub fn run(args: &[String]) -> Result<()> {
    use std::fs::File;
    use std::io::{self, Write};
    use std::path::Path;
    let [path, ready, release] = args else {
        return Err("invalid credential lock arguments");
    };
    let _lock = storage::open_locked_private(Path::new(path), None)
        .map_err(|_| "cannot acquire credential lock")?;
    File::create(ready)
        .and_then(|mut pipe| pipe.write_all(b"ready\n"))
        .map_err(|_| "cannot signal credential lock readiness")?;
    let mut release = File::open(release).map_err(|_| "cannot open credential release pipe")?;
    io::copy(&mut release, &mut io::sink()).map_err(|_| "cannot read credential release pipe")?;
    Ok(())
}

#[cfg(not(unix))]
pub fn run(_: &[String]) -> Result<()> {
    Err("credential FIFO lock requires POSIX")
}
