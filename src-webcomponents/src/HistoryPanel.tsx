/**
 * The detail view of a node, as the content of a dialog the host frames: its value over a chosen
 * period, with minimum, average and maximum.
 *
 * The same as `HistoryDialog` of the editor package, without MUI: the host draws the frame, the
 * title and the close button, this draws plain HTML and the chart of the core.
 */
import React from 'react';

import { HistoryChart, historyStatsText, type FlowTheme, type HistoryPoint } from '@flow/core';

/** The periods on offer, in ms */
const PERIODS: [string, number][] = [
    ['1h', 3600000],
    ['6h', 6 * 3600000],
    ['24h', 24 * 3600000],
    ['7d', 7 * 24 * 3600000],
    ['30d', 30 * 24 * 3600000],
];

/** Points per chart: enough for a dialog's width, few enough for a month of a busy state */
const POINTS = 300;

/** Styles of the panel, in the shadow root of the dialog content */
export const HISTORY_CSS = `
.periods { display: flex; gap: 4px; justify-content: flex-end; margin-bottom: 8px; flex-wrap: wrap; }
.periods button {
    font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--flow-border); background: transparent; color: inherit;
}
.periods button[aria-pressed='true'] { background: var(--flow-accent); border-color: var(--flow-accent); color: #fff; }
.message { padding: 48px 0; text-align: center; opacity: 0.7; }
.error { padding: 24px 0; text-align: center; color: var(--iob-error, #d32f2f); }
.stats { display: flex; gap: 24px; justify-content: center; margin-top: 8px; font-size: 14px; }
`;

export interface HistoryPanelProps {
    color: string;
    theme: FlowTheme;
    unit?: string;
    /** Reads the recorded values of a stretch of time, averaged into steps of `step` ms */
    load: (start: number, end: number, step: number) => Promise<HistoryPoint[]>;
    t: (key: string) => string;
}

export function HistoryPanel(props: HistoryPanelProps): React.JSX.Element {
    const { color, theme, unit, load, t } = props;
    const [period, setPeriod] = React.useState(PERIODS[2][1]);
    const [data, setData] = React.useState<{
        period: number;
        start: number;
        end: number;
        points: HistoryPoint[];
    } | null>(null);
    // kept with its period, like the data: another period starts without it
    const [error, setError] = React.useState<{ period: number; message: string } | null>(null);

    // The element hands in a new function on every drawing; only opening and choosing a period read
    const loadRef = React.useRef(load);
    React.useEffect(() => {
        loadRef.current = load;
    });

    React.useEffect(() => {
        let cancelled = false;
        const end = Date.now();
        const start = end - period;
        loadRef
            .current(start, end, Math.max(Math.round(period / POINTS), 1000))
            .then(points => !cancelled && setData({ period, start, end, points }))
            .catch(
                (caught: unknown) =>
                    !cancelled &&
                    setError({ period, message: caught instanceof Error ? caught.message : String(caught) }),
            );
        return () => {
            cancelled = true;
        };
    }, [period]);

    const current = data && data.period === period ? data : null;
    const stats = current ? historyStatsText(current.points, unit, theme.locale) : null;

    let body: React.JSX.Element;
    if (error && error.period === period) {
        body = <div className="error">{error.message}</div>;
    } else if (!current) {
        body = <div className="message">…</div>;
    } else if (current.points.length < 2) {
        body = <div className="message">{t('history_no_data')}</div>;
    } else {
        body = (
            <>
                <HistoryChart
                    points={current.points}
                    start={current.start}
                    end={current.end}
                    color={color}
                    theme={theme}
                    unit={unit}
                />
                {stats ? (
                    <div className="stats">
                        <span>
                            {t('history_min')}: <b>{stats.min}</b>
                        </span>
                        <span>
                            {t('history_avg')}: <b>{stats.avg}</b>
                        </span>
                        <span>
                            {t('history_max')}: <b>{stats.max}</b>
                        </span>
                    </div>
                ) : null}
            </>
        );
    }

    return (
        <div style={{ ['--flow-accent' as string]: color, ['--flow-border' as string]: theme.border }}>
            <div className="periods">
                {PERIODS.map(([name, length]) => (
                    <button
                        key={name}
                        type="button"
                        aria-pressed={period === length}
                        onClick={() => setPeriod(length)}
                    >
                        {name}
                    </button>
                ))}
            </div>
            {body}
        </div>
    );
}
