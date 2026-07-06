// Thin wrapper around Tauri's invoke() that gives us typed return values
// and surfaces command errors as plain strings — keeping the UI free of
// `unknown` casts.

import { invoke } from '@tauri-apps/api/core';
import type { Project, Session, Task, TimerView } from './types';

export const ipc = {
  devLogin: (email: string) => invoke<Session>('dev_login', { email }),
  opscoreLogin: () => invoke<Session>('opscore_login'),
  logout: () => invoke<void>('logout'),
  currentSession: () => invoke<Session | null>('current_session'),

  listProjects: () => invoke<Project[]>('list_projects'),
  // projectId: a project uuid, or 'none' for the "No project" bucket.
  listTasks: (projectId: string) => invoke<Task[]>('list_tasks', { projectId }),

  timerStart: (projectId: string | null, taskId: string | null, description: string | null) =>
    invoke<TimerView>('timer_start', {
      args: { project_id: projectId, task_id: taskId, description },
    }),
  timerStop: () => invoke<TimerView>('timer_stop'),
  timerCurrent: () => invoke<TimerView | null>('timer_current'),

  takeScreenshotNow: () => invoke<string>('take_screenshot_now'),
  idleSeconds: () => invoke<number>('idle_seconds'),
  viewOnline: () => invoke<string>('view_online'),
};
