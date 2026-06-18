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

/// Gaussian-blur a PNG in memory (for the `screenshots.blur = always` policy).
/// On any decode/encode failure the original bytes are returned unchanged so a
/// blur error never drops a screenshot.
pub fn blur_png_or_original(png: Vec<u8>) -> Vec<u8> {
    match blur_inner(&png) {
        Ok(out) => out,
        Err(err) => {
            tracing::warn!(error = ?err, "screenshot blur failed; uploading unblurred");
            png
        }
    }
}

fn blur_inner(png: &[u8]) -> Result<Vec<u8>> {
    let img = image::load_from_memory_with_format(png, ImageFormat::Png)
        .context("decode png for blur")?;
    let blurred = img.blur(12.0);
    let mut buf = Vec::with_capacity(png.len());
    blurred
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .context("encode blurred png")?;
    Ok(buf)
}
