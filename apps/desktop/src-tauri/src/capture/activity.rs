//! Activity aggregation (B4). MVP derives an activity level from idle time —
//! each tick counts as active or idle, accumulated into a per-minute bucket.
//! Keyboard/mouse event *counts* (requiring low-level input hooks) are a
//! future enhancement; the active/idle ratio gives a real 0–100 score now.

use chrono::{DateTime, Timelike, Utc};

#[derive(Debug, Clone)]
pub struct ActivitySample {
    pub bucket_minute: DateTime<Utc>,
    pub active_seconds: u16,
    pub idle_seconds: u16,
    pub activity_score: u16,
}

#[derive(Default)]
pub struct ActivityAggregator {
    current_minute: Option<DateTime<Utc>>,
    active: u16,
    idle: u16,
}

impl ActivityAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a tick covering `tick_secs` seconds. `idle_seconds` is seconds
    /// since the last input. Returns a completed sample when the minute rolls.
    pub fn tick(&mut self, now: DateTime<Utc>, idle_seconds: u64, tick_secs: u16) -> Option<ActivitySample> {
        let minute = now
            .with_second(0)
            .and_then(|t| t.with_nanosecond(0))
            .unwrap_or(now);

        let mut completed = None;
        match self.current_minute {
            Some(m) if m == minute => {}
            Some(m) => {
                completed = Some(self.flush(m));
                self.current_minute = Some(minute);
            }
            None => self.current_minute = Some(minute),
        }

        // The tick is "active" if there was input within it.
        if idle_seconds < tick_secs as u64 {
            self.active = (self.active + tick_secs).min(60);
        } else {
            self.idle = (self.idle + tick_secs).min(60);
        }
        completed
    }

    fn flush(&mut self, minute: DateTime<Utc>) -> ActivitySample {
        let active = self.active.min(60);
        let idle = self.idle.min(60);
        self.active = 0;
        self.idle = 0;
        let score = (((active as f32) / 60.0) * 100.0).round() as u16;
        ActivitySample {
            bucket_minute: minute,
            active_seconds: active,
            idle_seconds: idle,
            activity_score: score.min(100),
        }
    }
}
