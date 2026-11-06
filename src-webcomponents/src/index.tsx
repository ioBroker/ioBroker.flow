/**
 * The flow diagram as a web component: `<iob-flow-diagram>`.
 *
 * One module for every host -- vis-2, the device manager, Aura, admin. Its manifest is a file of its
 * own (`../manifest.ts`, written as `flow-diagram.json`), so a host loads this module only when it shows
 * the element. The host sets `socket` and `settings` (and, if it has them, `theme`, `editMode` and
 * `dialogs`); everything else is in here:
 *
 * - the diagram is a stored one (`flow.0.diagrams.<id>`), kept up to date through `getObjectIds`, so an
 *   edit in the admin tab reaches every open page at once. Drawing a diagram is the admin tab's job;
 *   a widget that carries its own diagram exists only in the vis-2 widget set,
 * - the states the diagram names come from `getStateIds`, which the base class asks again whenever
 *   the diagram changes,
 * - the detail chart of a node and the big view are element dialogs the host frames,
 * - the click action "view" asks the host with `iob-navigate`; a host without views ignores it.
 *
 * React is not in the module: it comes from `/lib/esm/react-19.js`, see `vite.config.ts`.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NAVIGATE_EVENT, type WebComponentSocket, type WebComponentTheme } from '@iobroker/web-components';
import { defineWebComponent, getThemeCssVariables, IobWebComponent } from '@iobroker/web-components/element';
import {
    cachedEnergyToday,
    cachedHistory,
    cachedMax,
    cachedUnit,
    collectOids,
    computeRuntime,
    createTheme,
    detailTarget,
    diagramFromNative,
    emptyConfig,
    energyRequests,
    FlowView,
    historyRequests,
    isDiagramId,
    loadEnergyToday,
    loadHistory,
    loadUnits,
    needsClock,
    readDetail,
    toNumber,
    type FlowConfig,
    type FlowNode,
    type FlowRuntime,
    type FlowTheme,
    type HistoryReader,
} from '@flow/core';

import { HISTORY_CSS, HistoryPanel } from './HistoryPanel';
import { word } from './words';

interface FlowSettings {
    [name: string]: string | number | boolean | undefined;
    diagram?: string;
    title?: string;
    hideLabels?: boolean;
    noAnimation?: boolean;
    fullView?: boolean;
}

/** A PV setup at midday updates a dozen states per second; one drawing per burst is plenty */
const FLUSH_MS = 120;

/** How often "12 minutes ago" is recomputed and the charts check whether they are stale */
const CLOCK_MS = 30000;

const CSS = `
:host { display: block; width: 100%; height: 100%; min-height: 60px; box-sizing: border-box; }
.box { width: 100%; height: 100%; display: flex; flex-direction: column; box-sizing: border-box; padding: 4px; }
.title { font-weight: 600; font-size: 14px; padding: 0 4px 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.diagram { flex: 1; min-height: 0; display: flex; }
.diagram.zoom { cursor: pointer; }
.diagram > svg { width: 100%; height: 100%; }
.empty { margin: auto; text-align: center; padding: 12px; font-size: 14px; }
`;

const FULL_VIEW_CSS = `
.content { width: 100%; height: min(70vh, 680px); display: flex; }
.content > svg { width: 100%; height: 100%; }
`;

class FlowDiagram extends IobWebComponent<FlowSettings> {
    readonly #mount: HTMLDivElement;

    #root: Root | null = null;

    #drawTimer: ReturnType<typeof setTimeout> | null = null;

    #lastDraw = 0;

    #clock: ReturnType<typeof setInterval> | null = null;

    #observer: IntersectionObserver | null = null;

    #onScreen = true;

    #motion: MediaQueryList | null = null;

    /** The default history adapter: undefined until asked, null when there is none */
    #historyInstance: string | null | undefined = undefined;

    /** What the charts of the diagram read, to read again when it changes */
    #historyKey = '';

    /** States whose unit was asked for */
    readonly #unitsAsked = new Set<string>();

    /** The drawings of the open dialogs, run with every drawing of the element */
    readonly #dialogDrawings = new Set<() => void>();

    #theme: { source: WebComponentTheme; lang: string; theme: FlowTheme } | null = null;

    constructor() {
        super();
        const shadow = this.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = CSS;
        this.#mount = document.createElement('div');
        this.#mount.className = 'box';
        shadow.append(style, this.#mount);
    }

    connectedCallback(): void {
        super.connectedCallback();
        document.addEventListener('visibilitychange', this.#onMotionChange);
        // A diagram scrolled out of view or in a hidden tab must not keep the compositor busy
        if (typeof IntersectionObserver !== 'undefined') {
            this.#observer = new IntersectionObserver(entries => {
                const onScreen = entries.some(entry => entry.isIntersecting);
                if (onScreen !== this.#onScreen) {
                    this.#onScreen = onScreen;
                    this.render();
                }
            });
            this.#observer.observe(this);
        }
        if (typeof window.matchMedia === 'function') {
            this.#motion = window.matchMedia('(prefers-reduced-motion: reduce)');
            this.#motion.addEventListener?.('change', this.#onMotionChange);
        }
        this.#clock = setInterval(() => {
            if (needsClock(this.#config)) {
                this.render();
            }
            this.#loadHistory();
        }, CLOCK_MS);
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        document.removeEventListener('visibilitychange', this.#onMotionChange);
        this.#motion?.removeEventListener?.('change', this.#onMotionChange);
        this.#motion = null;
        this.#observer?.disconnect();
        this.#observer = null;
        if (this.#clock) {
            clearInterval(this.#clock);
            this.#clock = null;
        }
        if (this.#drawTimer) {
            clearTimeout(this.#drawTimer);
            this.#drawTimer = null;
        }
        // A host that only moves the element connects it again in the same task: keep React then
        queueMicrotask(() => {
            if (!this.isConnected && this.#root) {
                this.#root.unmount();
                this.#root = null;
            }
        });
    }

    protected getObjectIds(settings: FlowSettings): string[] {
        return settings.diagram && isDiagramId(settings.diagram) ? [settings.diagram] : [];
    }

    protected getStateIds(): string[] {
        return collectOids(this.#config);
    }

    /** Called by the base class after every change; drawn at most once per {@link FLUSH_MS} */
    protected render(): void {
        if (this.#drawTimer) {
            return;
        }
        const wait = this.#lastDraw + FLUSH_MS - Date.now();
        if (wait <= 0) {
            this.#draw();
        } else {
            this.#drawTimer = setTimeout(() => {
                this.#drawTimer = null;
                this.#draw();
            }, wait);
        }
    }

    /** The diagram the settings name, empty while it is not there (yet) */
    get #config(): FlowConfig {
        const id = this.settings.diagram;
        const object = id ? this.objects[id] : null;
        return (object && diagramFromNative(object.native)) || emptyConfig();
    }

    /** The colors of the host for the diagram - the node accents stay those of flow, they carry a meaning */
    #flowTheme(): FlowTheme {
        const host = this.theme;
        // the base class keeps the object of the theme as long as its values stay the same
        if (this.#theme?.source !== host || this.#theme.lang !== this.systemLang) {
            this.#theme = {
                source: host,
                lang: this.systemLang,
                theme: createTheme(host.type, {
                    locale: this.systemLang,
                    text: host.text,
                    textSecondary: host.textSecondary,
                    surface: host.paper,
                    border: host.divider,
                }),
            };
        }
        return this.#theme.theme;
    }

    #animate(): boolean {
        return !document.hidden && this.#onScreen && !this.#motion?.matches && !this.settings.noAnimation;
    }

    #onMotionChange = (): void => this.render();

    #runtime(config: FlowConfig, theme: FlowTheme): FlowRuntime {
        return computeRuntime(config, oid => (this.states[oid] ? toNumber(this.states[oid].val) : null), theme, {
            units: cachedUnit,
            maxima: cachedMax,
            times: oid => (this.states[oid] ? { ts: this.states[oid].ts, lc: this.states[oid].lc } : undefined),
            now: Date.now(),
            history: cachedHistory,
            raw: oid => this.states[oid]?.val,
            energy: cachedEnergyToday,
        });
    }

    #draw(): void {
        if (!this.isConnected) {
            return;
        }
        this.#lastDraw = Date.now();
        const config = this.#config;
        this.#askUnits(config);
        const historyKey = JSON.stringify([historyRequests(config), energyRequests(config)]);
        if (historyKey !== this.#historyKey) {
            this.#historyKey = historyKey;
            this.#loadHistory();
        }
        const theme = this.#flowTheme();
        this.#root ||= createRoot(this.#mount);
        this.#root.render(this.#renderBox(config, theme));
        this.#dialogDrawings.forEach(draw => draw());
    }

    #renderBox(config: FlowConfig, theme: FlowTheme): React.JSX.Element {
        const { diagram, title, hideLabels, fullView } = this.settings;
        const lang = this.systemLang;
        // read, but not there yet: draw nothing rather than the hint for a moment. Only an ID of a stored
        // diagram is read at all (getObjectIds) - anything else, e.g. the name `12V` instead of
        // `flow.0.diagrams.12v`, never arrives and gets the hint at once instead of an empty box forever
        const loading = !!diagram && isDiagramId(diagram) && !!this.socket && this.objects[diagram] === undefined;
        const zoom = !!fullView && !!config.nodes.length;

        let content: React.JSX.Element | null = null;
        if (config.nodes.length) {
            content = (
                <FlowView
                    runtime={this.#runtime(config, theme)}
                    theme={theme}
                    animate={this.#animate()}
                    hideLabels={!!hideLabels}
                    onNodeClick={this.#onNodeClick}
                />
            );
        } else if (!loading) {
            content = (
                <div
                    className="empty"
                    style={{ color: theme.textSecondary }}
                >
                    {`${word('wc_choose_diagram', lang)} ${word('wc_diagram_help', lang)}`}
                </div>
            );
        }

        return (
            <>
                {title ? (
                    <div
                        className="title"
                        style={{ color: theme.text }}
                    >
                        {title}
                    </div>
                ) : null}
                <div
                    className={zoom ? 'diagram zoom' : 'diagram'}
                    onClick={zoom ? this.#openFullView : undefined}
                >
                    {content}
                </div>
            </>
        );
    }

    /** What the numbers are in comes from the objects; read once per state and page */
    #askUnits(config: FlowConfig): void {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        const ids = collectOids(config).filter(id => !this.#unitsAsked.has(id));
        if (!ids.length) {
            return;
        }
        ids.forEach(id => this.#unitsAsked.add(id));
        loadUnits(ids, id =>
            this.objects[id] !== undefined ? Promise.resolve(this.objects[id]) : socket.getObject(id),
        )
            .then(() => this.render())
            .catch(() => undefined);
    }

    #getHistoryInstance(socket: WebComponentSocket): Promise<string | null> {
        if (this.#historyInstance !== undefined) {
            return Promise.resolve(this.#historyInstance);
        }
        return socket.getObject('system.config').then(object => {
            this.#historyInstance =
                (object as ioBroker.SystemConfigObject | null | undefined)?.common?.defaultHistory || null;
            return this.#historyInstance;
        });
    }

    #historyReader(socket: WebComponentSocket, instance: string): HistoryReader {
        return (oid, options) =>
            socket.getHistory(oid, { instance, aggregate: 'average', ignoreNull: true, ...options });
    }

    /** Read the recorded values the charts of the diagram need, from the default history adapter */
    #loadHistory(): void {
        const socket = this.socket;
        const config = this.#config;
        const requests = historyRequests(config);
        const energy = energyRequests(config);
        if (!socket || (!requests.length && !energy.length)) {
            return;
        }
        this.#getHistoryInstance(socket)
            .then(async instance => {
                if (!instance) {
                    return;
                }
                const read = this.#historyReader(socket, instance);
                const [charts, today] = await Promise.all([loadHistory(requests, read), loadEnergyToday(energy, read)]);
                if (charts || today) {
                    this.render();
                }
            })
            .catch(() => undefined);
    }

    #onNodeClick = (node: FlowNode, event: React.MouseEvent): void => {
        const action = node.action;
        if (!action || action.type === 'none') {
            return;
        }
        // the node answers the click, not the big view behind it
        event.stopPropagation();
        if (this.editMode) {
            return;
        }
        switch (action.type) {
            case 'toggle': {
                const oid = action.oid;
                const socket = this.socket;
                if (oid && socket) {
                    // Read first: the value may belong to a state the diagram does not show
                    socket
                        .getState(oid)
                        .then(state => this.setState(oid, !state?.val))
                        .catch((error: unknown) => console.warn(`flow: cannot toggle ${oid}: ${String(error)}`));
                }
                break;
            }
            case 'setValue':
                if (action.oid) {
                    void this.setState(action.oid, action.value ?? null);
                }
                break;
            case 'url':
                if (action.url) {
                    if (action.newTab) {
                        window.open(action.url, '_blank', 'noopener,noreferrer');
                    } else {
                        window.location.href = action.url;
                    }
                }
                break;
            case 'view':
                if (action.view) {
                    this.emit(NAVIGATE_EVENT, { view: action.view });
                }
                break;
            case 'chart':
                void this.#openChart(node.id);
                break;
            default:
                break;
        }
    };

    /**
     * Show React content in a dialog of the host. It is drawn again with the element, so the big view
     * follows the values
     *
     * @param title title of the dialog
     * @param css styles of the content, in a shadow root of its own
     * @param size the size wanted
     * @param size.width in px
     * @param size.height in px
     * @param content what to draw
     */
    async #openInDialog(
        title: string,
        css: string,
        size: { width: number; height?: number },
        content: () => React.ReactNode,
    ): Promise<void> {
        const element = document.createElement('div');
        // the host moves the content into its dialog, out of this element: it brings the theme along
        for (const [name, value] of Object.entries(getThemeCssVariables(this.theme))) {
            element.style.setProperty(name, value);
        }
        const shadow = element.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = css;
        const mount = document.createElement('div');
        mount.className = 'content';
        shadow.append(style, mount);
        const root = createRoot(mount);
        const draw = (): void => root.render(content());
        this.#dialogDrawings.add(draw);
        draw();
        try {
            await this.openDialog({ title, element, ...size });
        } finally {
            this.#dialogDrawings.delete(draw);
            root.unmount();
        }
    }

    /** The detail view of a node: its value over time, from the default history adapter */
    #openChart(nodeId: string): Promise<void> {
        const config = this.#config;
        const socket = this.socket;
        const node = this.#runtime(config, this.#flowTheme()).nodeById[nodeId];
        const target = node ? detailTarget(node.node, config, cachedUnit) : null;
        if (!socket || !node || !target) {
            return Promise.resolve();
        }
        const lang = this.systemLang;
        const load = async (start: number, end: number, step: number): ReturnType<typeof readDetail> => {
            const instance = await this.#getHistoryInstance(socket);
            if (!instance) {
                throw new Error(word('insp_history_no_adapter', lang));
            }
            return readDetail(this.#historyReader(socket, instance), target, start, end, step);
        };
        return this.#openInDialog(node.node.label || node.node.id, HISTORY_CSS, { width: 800 }, () => (
            <HistoryPanel
                color={node.color}
                theme={this.#flowTheme()}
                unit={target.unit}
                load={load}
                t={key => word(key, lang)}
            />
        ));
    }

    /** The whole diagram, big: a card is often too small for a diagram with labels */
    #openFullView = (): void => {
        if (this.editMode) {
            return;
        }
        const title = this.settings.title || word('widget_label', this.systemLang);
        void this.#openInDialog(title, FULL_VIEW_CSS, { width: 1100, height: 760 }, () => {
            const theme = this.#flowTheme();
            return (
                <FlowView
                    runtime={this.#runtime(this.#config, theme)}
                    theme={theme}
                    animate={this.#animate()}
                    onNodeClick={this.#onNodeClick}
                />
            );
        });
    };
}

/** The tag of the manifest (`manifest.ts`), set by the build */
declare const __FLOW_TAG__: string;

defineWebComponent(__FLOW_TAG__, FlowDiagram);
