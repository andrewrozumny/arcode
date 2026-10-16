import { useEffect, useState } from 'react';
import { TRAFFIC_LIGHTS } from '@shared/app';

/** True while this window is in macOS full screen. */
export function useFullScreen(): boolean {
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    const api = window.acode.window;
    let cancelled = false;
    void api
      .isFullScreen()
      .then((value) => {
        if (!cancelled) setFullScreen(value);
      })
      .catch(() => undefined);
    const off = api.onFullScreen(setFullScreen);
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return fullScreen;
}

/**
 * Stand-ins for the traffic lights, which macOS hides in full screen for an inset title bar.
 * Drawn where the native ones sit, so toggling full screen does not move them.
 */
export function WindowControls() {
  const fullScreen = useFullScreen();
  if (!fullScreen) return null;
  const act = window.acode.window.action;
  return (
    <div className="window-controls" style={{ left: TRAFFIC_LIGHTS.x, top: TRAFFIC_LIGHTS.y }}>
      <button type="button" className="wc wc-close" title="Close" aria-label="Close window" onClick={() => act('close')}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5" />
        </svg>
      </button>
      {/* macOS cannot minimize a full-screen window, so the middle light is shown disabled. */}
      <button type="button" className="wc wc-minimize" aria-label="Minimize (unavailable in full screen)" disabled>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 6h6" />
        </svg>
      </button>
      <button
        type="button"
        className="wc wc-fullscreen"
        title="Exit Full Screen"
        aria-label="Exit full screen"
        onClick={() => act('toggle-full-screen')}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path className="wc-fill" d="M3.2 6.4V3.2h3.2zM8.8 5.6v3.2H5.6z" />
        </svg>
      </button>
    </div>
  );
}
