/**
 * Settings catalog (B6). Single source of truth for every configurable
 * setting: key, type, default, allowed values, and how it's edited.
 *
 * Scope model is 2-level per C5: an org default, optionally overridden
 * per user. The `settings_scoped` table stores non-default values; anything
 * absent falls back to the registry default here.
 *
 * Values from the S11 screenshot. Some settings only take effect once their
 * underlying feature ships (noted with `enforcedBy`).
 */

export type SettingType = 'bool' | 'number' | 'enum';

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  default: boolean | number | string;
  /** enum options (value+label) */
  options?: Array<{ value: string; label: string }>;
  /** number bounds + unit */
  min?: number;
  max?: number;
  unit?: string;
  /** false = org-only, cannot be overridden per user */
  overridable: boolean;
  description?: string;
  /** feature that must exist for this setting to actually do anything */
  enforcedBy?: 'screenshots' | 'activity' | 'app_url' | 'idle' | 'offline_time' | 'notify' | 'limits' | 'display' | 'time';
}

export const SETTINGS: SettingDef[] = [
  {
    key: 'screenshots.enabled',
    label: 'Take screenshots',
    type: 'bool',
    default: true,
    overridable: true,
    enforcedBy: 'screenshots',
  },
  {
    key: 'screenshots.per_hour',
    label: 'Screenshots per hour',
    type: 'number',
    default: 30,
    min: 0,
    max: 60,
    unit: '/hr',
    overridable: true,
    description: 'Average — screenshots are taken at random intervals.',
    enforcedBy: 'screenshots',
  },
  {
    key: 'screenshots.blur',
    label: 'Blur',
    type: 'enum',
    default: 'allow',
    options: [
      { value: 'allow', label: 'Allow blur' },
      { value: 'always', label: 'Always blur' },
      { value: 'never', label: 'No blur' },
    ],
    overridable: true,
    enforcedBy: 'screenshots',
  },
  {
    key: 'activity.tracking',
    label: 'Activity Level tracking',
    type: 'bool',
    default: true,
    overridable: true,
    enforcedBy: 'activity',
  },
  {
    key: 'app_url.tracking',
    label: 'App & URL tracking',
    type: 'bool',
    default: true,
    overridable: true,
    enforcedBy: 'app_url',
  },
  {
    key: 'limits.weekly_hours',
    label: 'Weekly time limit',
    type: 'number',
    default: 40,
    min: 0,
    max: 168,
    unit: 'h',
    overridable: true,
    enforcedBy: 'limits',
  },
  {
    key: 'tracking.auto_pause_minutes',
    label: 'Auto-pause tracking after',
    type: 'number',
    default: 5,
    min: 1,
    max: 120,
    unit: 'min',
    overridable: true,
    enforcedBy: 'idle',
  },
  {
    key: 'tracking.require_task',
    label: 'Require a task to track time',
    type: 'bool',
    // Default OFF for a staged rollout: ship the enforcement + the v0.1.14 agent
    // (which disables Start without a task), let everyone auto-update, THEN flip
    // this on org-wide. Turning it on before old agents update would lock them
    // out of tracking (they send no task_id).
    default: false,
    overridable: true,
    description:
      'Employees must pick an assigned task before the timer can start. When off, tracking works with or without a task.',
  },
  {
    key: 'time.allow_offline',
    label: 'Allow adding Offline Time',
    type: 'bool',
    default: false,
    overridable: true,
    enforcedBy: 'offline_time',
  },
  {
    key: 'screenshots.notify',
    label: 'Notify when screenshot is taken',
    type: 'bool',
    default: false,
    overridable: true,
    enforcedBy: 'notify',
  },
  {
    key: 'screenshots.allow_self_delete',
    label: 'Allow employees to delete own screenshots',
    type: 'bool',
    default: false,
    overridable: true,
    enforcedBy: 'screenshots',
    description: 'Admins and managers can always delete screenshots of people they manage (C9).',
  },
  {
    key: 'time.allow_self_edit',
    label: 'Allow employees to edit own time entries',
    type: 'bool',
    default: true,
    overridable: true,
    enforcedBy: 'time',
    description:
      'Employees can edit the project/description, trim, split, or delete their own activities. Admins and managers can always edit time for people they manage.',
  },
  {
    key: 'screenshots.retention_days',
    label: 'Keep screenshots for',
    type: 'enum',
    default: '90',
    options: [
      { value: '30', label: '1 month' },
      { value: '90', label: '3 months' },
      { value: '180', label: '6 months' },
      { value: '365', label: '1 year' },
      { value: '0', label: 'Forever' },
    ],
    overridable: false,
    enforcedBy: 'screenshots',
    description: 'Screenshots older than this are deleted automatically. "Forever" keeps them indefinitely.',
  },
  {
    key: 'display.week_starts_on',
    label: 'Week starts on',
    type: 'enum',
    default: 'mon',
    options: [
      { value: 'mon', label: 'Monday' },
      { value: 'sun', label: 'Sunday' },
    ],
    overridable: false,
    enforcedBy: 'display',
  },
  {
    key: 'display.currency',
    label: 'Currency symbol',
    type: 'enum',
    default: 'Rs',
    options: [
      { value: 'Rs', label: 'Rs' },
      { value: '$', label: '$' },
      { value: '€', label: '€' },
      { value: '£', label: '£' },
      { value: '₹', label: '₹' },
    ],
    overridable: false,
    enforcedBy: 'display',
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Default value map keyed by setting key. */
export function registryDefaults(): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {};
  for (const s of SETTINGS) out[s.key] = s.default;
  return out;
}

/** Coerce/validate an incoming value against a setting's type + bounds. */
export function validateValue(def: SettingDef, value: unknown): boolean | number | string {
  if (def.type === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${def.key} must be a boolean`);
    return value;
  }
  if (def.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${def.key} must be a number`);
    if (def.min != null && n < def.min) throw new Error(`${def.key} below min ${def.min}`);
    if (def.max != null && n > def.max) throw new Error(`${def.key} above max ${def.max}`);
    return n;
  }
  // enum
  const s = String(value);
  if (def.options && !def.options.some((o) => o.value === s)) {
    throw new Error(`${def.key} must be one of ${def.options.map((o) => o.value).join(', ')}`);
  }
  return s;
}
