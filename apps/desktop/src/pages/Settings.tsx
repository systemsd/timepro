import { useState } from 'react';
import { ChevronLeft } from '../icons';

interface Props {
  onClose: () => void;
}

const LS_AUTOSTART = 'tf_autostart';

/**
 * Team settings are "set by company manager" and read-only on the agent.
 * For the MVP these mirror the server's default policy; Phase 2 fetches them
 * live from `GET /v1/settings/effective`.
 */
const TEAM_SETTINGS_LEFT: Array<[string, string]> = [
  ['Screenshots:', '12/hr'],
  ['Auto-pause tracking:', '5 min'],
  ['Weekly time limit:', 'No limit'],
];
const TEAM_SETTINGS_RIGHT: Array<[string, string]> = [
  ['Allow adding offline time:', 'No'],
  ['Activity level tracking:', 'Yes'],
  ['App & Url tracking:', 'Yes'],
];

export function Settings({ onClose }: Props) {
  const [autoStart, setAutoStart] = useState(
    () => localStorage.getItem(LS_AUTOSTART) === '1',
  );

  const toggleAutoStart = () => {
    const next = !autoStart;
    setAutoStart(next);
    localStorage.setItem(LS_AUTOSTART, next ? '1' : '0');
  };

  return (
    <div className="settings">
      <header className="settings-header">
        <button className="settings-back" onClick={onClose}>
          <ChevronLeft /> Back
        </button>
        <span className="settings-title">Settings</span>
        <button className="settings-done" onClick={onClose}>Done</button>
      </header>

      <div className="settings-body">
        <section>
          <h3 className="section-label">User settings</h3>
          <div className="group">
            <label className="check-row">
              <input type="checkbox" checked={autoStart} onChange={toggleAutoStart} />
              Automatically start tracking when I launch TimePro
            </label>
            <label className="check-row disabled">
              <input type="checkbox" checked readOnly disabled />
              Display a notification when a screenshot is taken
            </label>
          </div>
        </section>

        <section>
          <h3 className="section-label">Team settings (set by company manager)</h3>
          <div className="group team-grid">
            {TEAM_SETTINGS_LEFT.map(([label, value]) => (
              <div className="team-row" key={label}>
                <span className="lbl">{label}</span>
                <span className="val">{value}</span>
              </div>
            ))}
            {TEAM_SETTINGS_RIGHT.map(([label, value]) => (
              <div className="team-row" key={label}>
                <span className="lbl">{label}</span>
                <span className="val">{value}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
