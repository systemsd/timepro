// Mirror of the Rust-side types returned by Tauri commands.
// Hand-maintained for now; in Phase 2 we generate these from OpenAPI.

export interface Session {
  user_id: string;
  organization_id: string;
  organization_name: string;
  display_name: string;
  role: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  status: string;
  is_billable: boolean;
}

/**
 * An OpsCore Internal Product — a peer of Project, never nested under one.
 * `is_billable` is always false (internal time); kept so both lists share a shape.
 */
export interface Product {
  id: string;
  name: string;
  color: string;
  stage: string; // IDEA | VALIDATE | PLAN | BUILD | LAUNCH | IMPROVE | PAUSED | SUNSET
  is_billable: boolean;
}

/** What the timer is tracked against: exactly one project OR one product. */
export type TrackingContext =
  | { kind: 'project'; id: string }
  | { kind: 'product'; id: string };

export interface Task {
  id: string;
  name: string;
  status: string; // TODO | IN_PROGRESS | REVIEW | BLOCKED | DONE
  priority: string; // LOW | MEDIUM | HIGH | URGENT
  project_id: string | null;
  product_id: string | null;
}

export interface TimerView {
  time_entry_id: string;
  project_id: string | null;
  product_id: string | null;
  started_at: string;
}

export interface ScreenshotUploadEvent {
  id: string;
  captured_at: string;
  bytes: number;
  local_path: string;
}
