import { useEffect, useState } from 'react';
import type { GateTarget } from '@shared/app';
import type { GatesOverview } from '@shared/claude';
import { claudeApi } from './api';

const GATE_LABELS: Record<GateTarget, string> = {
  all: 'Everything',
  lint: 'Style and types',
  test: 'Tests',
  build: 'Build',
  deploy: 'Before shipping',
};

/** What the gates check, and which parts of the code have automated tests. Plain words, no jargon. */
export function GatesView({ root }: { root: string }) {
  const [data, setData] = useState<GatesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    claudeApi().gates(root).then(
      (overview) => {
        if (live) setData(overview);
      },
      (err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [root]);

  if (error) return <div className="cl-notice">Could not read the gates: {error}</div>;
  if (!data) return <div className="cl-notice">Loading…</div>;

  return (
    <div className="cl-cards stack">
      <div className="cl-card">
        <div className="cl-card-title">What the gates run</div>
        {data.gates.map((gate) => (
          <div className="cl-row cl-gate" key={gate.target}>
            <div className="cl-row-main">
              <div className="cl-name">{GATE_LABELS[gate.target]}</div>
              <span className="cl-path">scripts/gates.sh {gate.target}</span>
              {gate.missing.length === 0 ? (
                <span className="cl-badge ok">ready</span>
              ) : (
                <span className="cl-badge error">missing script: {gate.missing.join(', ')}</span>
              )}
            </div>
            <div className="cl-desc">{gate.explanation}</div>
            {gate.commands.length > 0 ? <div className="cl-path">{gate.commands.join(' → ')}</div> : null}
          </div>
        ))}
      </div>

      {data.areas.length > 0 && (
        <div className="cl-card">
          <div className="cl-card-title">What the tests cover</div>
          <div className="cl-desc">Approximate: counts it(...) and test(...) calls in *.test.ts files.</div>
          {data.areas.map((area) => (
            <div className="cl-row" key={area.folder}>
              <div className="cl-row-main">
                <div className="cl-name">{area.name}</div>
                <div className="cl-path">{area.folder}</div>
              </div>
              {area.testFiles === 0 ? (
                <span className="cl-badge error">NO TESTS</span>
              ) : (
                <span className="cl-badge ok">
                  {area.testFiles} {area.testFiles === 1 ? 'file' : 'files'}, ~{area.tests} tests
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="cl-notice">{data.resultNote}</div>
    </div>
  );
}
