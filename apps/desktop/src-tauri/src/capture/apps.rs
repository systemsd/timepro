//! Active-application tracking (B5). Polls the frontmost window's app name +
//! title. URL tracking (browsers) is deferred to a companion browser extension.
//!
//! Window titles can leak content, so they're truncated to 256 chars. Best
//! effort — returns None if the platform API is unavailable (e.g. missing
//! permission), never panics.

pub struct ActiveApp {
    pub app_name: String,
    pub window_title: Option<String>,
}

pub fn active_app() -> Option<ActiveApp> {
    match active_win_pos_rs::get_active_window() {
        Ok(w) => {
            let app_name = if !w.app_name.is_empty() {
                w.app_name
            } else {
                // fall back to the executable's file name
                let base = w
                    .process_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                if base.is_empty() {
                    return None;
                }
                base
            };
            let title = if w.title.is_empty() {
                None
            } else {
                Some(truncate(&w.title, 256))
            };
            Some(ActiveApp {
                app_name: truncate(&app_name, 256),
                window_title: title,
            })
        }
        Err(_) => None,
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}
