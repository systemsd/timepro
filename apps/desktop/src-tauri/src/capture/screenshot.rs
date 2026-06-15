//! Cross-platform screenshot capture using `xcap`.

use anyhow::{anyhow, Context, Result};
use image::ImageFormat;
use std::io::Cursor;

pub struct CapturedShot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn capture_primary_monitor() -> Result<CapturedShot> {
    let monitors = xcap::Monitor::all().context("enumerate monitors")?;
    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| xcap::Monitor::all().ok().and_then(|m| m.into_iter().next()))
        .ok_or_else(|| anyhow!("no monitor available"))?;

    let image = primary.capture_image().context("capture image")?;
    let width = image.width();
    let height = image.height();

    let mut buf = Vec::with_capacity(256 * 1024);
    image
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .context("encode png")?;

    Ok(CapturedShot { png: buf, width, height })
}
