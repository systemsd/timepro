//! Cross-platform idle detection via `user-idle`.

use user_idle::UserIdle;

/// Seconds since the user's last input event.
/// Returns 0 if the OS API is unavailable rather than failing hard —
/// idle is advisory, not a correctness requirement.
pub fn seconds_idle() -> u64 {
    UserIdle::get_time().map(|d| d.as_seconds()).unwrap_or(0)
}
