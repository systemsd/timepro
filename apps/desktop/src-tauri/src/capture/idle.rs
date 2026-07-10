//! Cross-platform idle detection via `user-idle`.

use user_idle::UserIdle;

/// Above this, an idle reading is treated as bogus. No genuine in-session idle is
/// hours long; a very long *real* idle is handled by the server abandoned-timer
/// sweep instead.
const MAX_PLAUSIBLE_IDLE_SECS: u64 = 6 * 3600; // 6h

/// Reject an implausibly large reading. Some Windows edge cases (process
/// throttling / resume-from-suspend) return a garbage value (e.g. ~u32::MAX
/// seconds). Left unchecked, the idle auto-pause back-dates the stop by that
/// amount and the server clamps it to the entry start — wiping a legitimate
/// entry to 0 minutes (a real time-loss bug, seen live: idle_secs ≈ 4.29M). Treat
/// a bogus reading as "not idle" so it can never fire a destructive back-date.
fn sanitize_idle(secs: u64) -> u64 {
    if secs > MAX_PLAUSIBLE_IDLE_SECS {
        0
    } else {
        secs
    }
}

/// Seconds since the user's last input event.
/// Returns 0 if the OS API is unavailable rather than failing hard — idle is
/// advisory, not a correctness requirement.
pub fn seconds_idle() -> u64 {
    sanitize_idle(UserIdle::get_time().map(|d| d.as_seconds()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::{sanitize_idle, MAX_PLAUSIBLE_IDLE_SECS};

    #[test]
    fn passes_plausible_idle_through() {
        for s in [0, 5, 300, 3600, MAX_PLAUSIBLE_IDLE_SECS] {
            assert_eq!(sanitize_idle(s), s);
        }
    }

    #[test]
    fn zeroes_bogus_readings() {
        // The exact value that wiped a live entry, plus u32::MAX territory.
        for s in [4_294_967, MAX_PLAUSIBLE_IDLE_SECS + 1, u32::MAX as u64, u64::MAX] {
            assert_eq!(sanitize_idle(s), 0, "bogus {s} must be treated as not-idle");
        }
    }
}
