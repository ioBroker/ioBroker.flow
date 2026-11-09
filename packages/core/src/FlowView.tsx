/**
 * The renderer. One `<svg>` with a `viewBox`, so the whole diagram scales into whatever box the host
 * gives it -- a 2x2 tile in the device manager or a full-width vis-2 view -- without any of the
 * per-element pixel arithmetic the predecessor needs.
 *
 * No MUI, no `styled()`, no icon package: see `theme.ts` for why, and `icons.tsx` for the icons.
 * The only dependency is React itself.
 *
 * The animation is CSS on a second, dashed copy of each line. That keeps it on the compositor, makes
 * it pausable with one class on the root element, and costs one extra `<path>` per flowing edge --
 * where a JavaScript animation would cost a `requestAnimationFrame` loop per diagram and a re-render
 * of everything in it.
 */
import React from 'react';

import { iconPlacement } from './defaults';
import { fitFontSize, textWidth } from './format';
import { diagramStyle, type DiagramStyle } from './styles';
import { withAlpha, type FlowTheme } from './theme';
import { renderBuiltinIcon } from './icons';
import type { EdgeRuntime, FlowRuntime, NodeRuntime } from './runtime';
import type { FlowNode, Point } from './types';

/**
 * `--ef-shift` is the distance the dash pattern travels in one cycle: one gap, negative along the
 * path and positive against it. Because the pattern repeats every gap, the end of a cycle looks
 * exactly like its start and the loop is seamless whatever the duration.
 */
const CSS = `
.ef-root { display: block; width: 100%; height: 100%; }
.ef-dots {
    animation-name: ef-flow;
    animation-duration: var(--ef-dur, 1s);
    animation-timing-function: linear;
    animation-iteration-count: infinite;
}
.ef-paused .ef-dots { animation-play-state: paused; }
.ef-clickable { cursor: pointer; }
.ef-blink { animation: ef-blink 1.2s ease-in-out infinite; }
.ef-paused .ef-blink { animation-play-state: paused; }
@keyframes ef-blink { 50% { opacity: 0.35; } }
.ef-node-hit { fill: transparent; stroke: none; }
@keyframes ef-flow { to { stroke-dashoffset: var(--ef-shift, -26px); } }
@media (prefers-reduced-motion: reduce) {
    .ef-dots { animation-name: none; }
    .ef-blink { animation-name: none; }
}
`;

export interface FlowViewProps {
    runtime: FlowRuntime;
    theme: FlowTheme;
    /**
     * Whether the dots move. The host decides: it knows whether the tab is hidden, whether the
     * widget scrolled out of view and whether the user asked for reduced motion. While this is
     * false, an active edge shows a static arrow instead, so the direction is still readable.
     */
    animate?: boolean;
    /** Called when a node with an action is clicked */
    onNodeClick?: (node: FlowNode, event: React.MouseEvent) => void;
    /** Drawn behind everything -- the editor puts its grid here */
    background?: React.ReactNode;
    /** Drawn on top of everything -- the editor puts its handles here */
    overlay?: React.ReactNode;
    /** Ids of nodes drawn with a selection ring */
    selectedNodes?: string[];
    /** Ids of edges drawn with a selection ring */
    selectedEdges?: string[];
    /**
     * Drop the node labels and the edge labels.
     *
     * For a small tile -- a 1x1 card in the device manager is a couple of centimetres across -- the
     * text scales down with the `viewBox` until it is a grey smudge, and the shapes and the moving
     * dots carry the information better on their own. The values inside the nodes stay.
     */
    hideLabels?: boolean;
    className?: string;
    style?: React.CSSProperties;
    /** Forwarded to the `<svg>`, so the editor can attach its pointer handling */
    svgProps?: React.SVGProps<SVGSVGElement>;
}

/** An arrowhead at `point`, pointing along `direction` */
function arrowPath(point: Point, direction: Point, size: number, reversed: boolean): string {
    const dx = reversed ? -direction.x : direction.x;
    const dy = reversed ? -direction.y : direction.y;
    // The two barbs are the direction vector rotated by +/- 140 degrees, scaled to `size`
    const angle = Math.atan2(dy, dx);
    const spread = (140 * Math.PI) / 180;
    const tipX = point.x + dx * size * 0.5;
    const tipY = point.y + dy * size * 0.5;
    const left = { x: tipX + Math.cos(angle + spread) * size, y: tipY + Math.sin(angle + spread) * size };
    const right = { x: tipX + Math.cos(angle - spread) * size, y: tipY + Math.sin(angle - spread) * size };
    const r = (value: number): number => Math.round(value * 100) / 100;
    return `M${r(left.x)} ${r(left.y)} L${r(tipX)} ${r(tipY)} L${r(right.x)} ${r(right.y)}`;
}

/** A filled arrowhead with its tip at `tip`, pointing along `dir` */
function arrowHead(tip: Point, dir: Point, size: number): string {
    const back = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
    const half = size * 0.62;
    const r = (value: number): number => Math.round(value * 100) / 100;
    return `M${r(tip.x)} ${r(tip.y)} L${r(back.x - dir.y * half)} ${r(back.y + dir.x * half)} L${r(back.x + dir.y * half)} ${r(back.y - dir.x * half)} Z`;
}

function EdgeLayer({
    edges,
    animate,
    selected,
    animationGap,
    dotSize,
    look,
    glowId,
}: {
    edges: EdgeRuntime[];
    animate: boolean;
    selected: Set<string>;
    animationGap: number;
    dotSize: number;
    look: DiagramStyle;
    glowId?: string;
}): React.ReactElement {
    return (
        <g className="ef-edges">
            {/* The glow of the active lines, as one blurred layer under them: one filter pass for all
                lines, and nothing in it moves, so it is not recomputed while the dots run */}
            {glowId ? (
                <g
                    filter={`url(#${glowId})`}
                    style={{ pointerEvents: 'none' }}
                >
                    {edges.map(edge =>
                        edge.visible && edge.active ? (
                            <path
                                key={edge.edge.id}
                                d={edge.geometry.d}
                                fill="none"
                                stroke={edge.color}
                                strokeWidth={edge.width + 2}
                                strokeLinecap="round"
                            />
                        ) : null,
                    )}
                </g>
            ) : null}
            {edges.map(edge => {
                if (!edge.visible) {
                    return null;
                }
                const isSelected = selected.has(edge.edge.id);
                const moving = animate && edge.dotDuration > 0;

                return (
                    <g key={edge.edge.id}>
                        {isSelected ? (
                            <path
                                d={edge.geometry.d}
                                fill="none"
                                stroke={edge.color}
                                strokeOpacity={0.3}
                                strokeWidth={edge.width + 8}
                                strokeLinecap="round"
                            />
                        ) : null}
                        {look.tube ? (
                            // The casing of a pipe: a wider, faint copy under the line, so the line
                            // itself reads as what runs *inside* it
                            <path
                                d={edge.geometry.d}
                                fill="none"
                                stroke={withAlpha(edge.color, 0.3)}
                                strokeWidth={edge.width * look.tube}
                                strokeLinecap="round"
                            />
                        ) : null}
                        <path
                            d={edge.geometry.d}
                            fill="none"
                            stroke={edge.color}
                            strokeWidth={edge.width}
                            strokeLinecap="round"
                        />
                        {moving ? (
                            <path
                                className="ef-dots"
                                d={edge.geometry.d}
                                fill="none"
                                // Light dots on the coloured line -- in a dark theme too, where
                                // they are the bright pulses -- or dots in the line's colour
                                stroke={look.dots === 'light' ? withAlpha('#FFFFFF', 0.9) : edge.color}
                                strokeWidth={dotSize}
                                strokeLinecap="round"
                                // A dash of (almost) zero length plus a round cap is a dot. The gap
                                // is what the animation shifts by, so dots stay evenly spaced
                                // whatever the path length.
                                strokeDasharray={`0.01 ${animationGap}`}
                                style={
                                    {
                                        '--ef-dur': `${edge.dotDuration}s`,
                                        '--ef-shift': `${edge.direction < 0 ? animationGap : -animationGap}px`,
                                    } as React.CSSProperties
                                }
                            />
                        ) : null}
                        {look.arrowAtEnd && edge.active ? (
                            // Where the energy arrives: the end the line runs to, or its start when the
                            // flow runs backwards
                            <path
                                d={
                                    edge.direction < 0
                                        ? arrowHead(
                                              edge.geometry.start,
                                              { x: -edge.geometry.startDir.x, y: -edge.geometry.startDir.y },
                                              Math.max(edge.width * 3.2, 10),
                                          )
                                        : arrowHead(
                                              edge.geometry.end,
                                              edge.geometry.endDir,
                                              Math.max(edge.width * 3.2, 10),
                                          )
                                }
                                fill={edge.color}
                                stroke="none"
                            />
                        ) : null}
                        {!look.arrowAtEnd && !moving && edge.active ? (
                            <path
                                d={arrowPath(
                                    edge.geometry.mid,
                                    edge.geometry.midDir,
                                    // Big enough to read at a glance even on a thin line: the arrow
                                    // has to carry the direction on its own here, since the dots
                                    // that normally do that are standing still
                                    Math.max(edge.width * 4, 12),
                                    edge.direction < 0,
                                )}
                                fill="none"
                                stroke={edge.color}
                                strokeWidth={edge.width}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        ) : null}
                    </g>
                );
            })}
        </g>
    );
}

function EdgeLabels({
    edges,
    theme,
    fontSize,
    look,
    chip,
}: {
    edges: EdgeRuntime[];
    theme: FlowTheme;
    fontSize: number;
    look: DiagramStyle;
    /** Draw the value in a rounded box on the line instead of beside it */
    chip?: boolean;
}): React.ReactElement {
    return (
        <g className="ef-edge-labels">
            {edges.map(edge => {
                if (!edge.visible || !edge.edge.showValue) {
                    return null;
                }
                if (chip) {
                    // Wide enough for the text plus a little air; the height makes the ends half
                    // circles, so it reads as one tag rather than a box
                    const width = textWidth(edge.valueText.text, fontSize, true) + fontSize * 1.3;
                    const height = fontSize * 1.8;
                    return (
                        <g
                            key={edge.edge.id}
                            style={{ pointerEvents: 'none', userSelect: 'none' }}
                        >
                            <rect
                                x={edge.labelPos.x - width / 2}
                                y={edge.labelPos.y - height / 2}
                                width={width}
                                height={height}
                                rx={height / 2}
                                fill={theme.surface}
                                stroke={edge.active ? withAlpha(edge.color, 0.7) : theme.border}
                                strokeWidth={1.2}
                            />
                            <text
                                x={edge.labelPos.x}
                                y={edge.labelPos.y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={fontSize}
                                fontWeight={600}
                                fill={edge.active ? theme.text : theme.textSecondary}
                            >
                                {edge.valueText.text}
                            </text>
                        </g>
                    );
                }
                return (
                    <text
                        key={edge.edge.id}
                        x={edge.labelPos.x}
                        y={edge.labelPos.y}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize={fontSize}
                        fontWeight={600}
                        fill={edge.active ? theme.text : theme.textSecondary}
                        // The label sits on top of the line it belongs to; a halo in the background
                        // colour keeps it legible without a solid box behind it
                        stroke={look.panel ? theme.background : theme.mode === 'dark' ? '#000' : '#fff'}
                        strokeWidth={fontSize * 0.28}
                        strokeOpacity={look.panel ? 0.9 : 0.55}
                        paintOrder="stroke"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                        {edge.valueText.text}
                    </text>
                );
            })}
        </g>
    );
}

/** The body of a node: the shape, its tint and its fill level -- the charge of a battery, or a value against its maximum */
function NodeShapeBody({
    node,
    theme,
    look,
    shadowId,
    glowId,
    glassId,
}: {
    node: NodeRuntime;
    theme: FlowTheme;
    look: DiagramStyle;
    shadowId?: string;
    glowId?: string;
    glassId?: string;
}): React.ReactElement {
    // Unique per rendered node, not per node id: two widgets on one page both have a "battery", and
    // a clip path found by id would clip the second one with the first one's outline
    const clipId = `ef-clip-${React.useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
    const { rect, color } = node;
    // A card style draws every body as a card, circles included
    const shape = look.cards && node.shape !== 'none' ? 'card' : node.shape;
    const chart = node.chart ? (
        <>
            <path
                d={node.chart.area}
                fill={withAlpha(color, theme.mode === 'dark' ? 0.22 : 0.14)}
                stroke="none"
            />
            <path
                d={node.chart.line}
                fill="none"
                stroke={withAlpha(color, 0.75)}
                strokeWidth={1.4}
                strokeLinejoin="round"
            />
        </>
    ) : null;
    // No body, no fill either: without a container there is nothing to fill -- a chart still has
    // somewhere to go, under the value
    if (shape === 'none') {
        return chart ?? <></>;
    }
    const tint = withAlpha(color, theme.mode === 'dark' ? look.tint.dark : look.tint.light);
    const outline = withAlpha(color, look.outline);
    const glow = glowId ? `url(#${glowId})` : undefined;
    // A circle in a gauge style shows its level along the outline; everything else fills up
    const level = node.level ?? 0;
    const ring = look.levelRing && shape === 'circle' && node.level !== null;
    const fill = !ring && level > 0;
    const radius =
        shape === 'card'
            ? Math.min(look.cardRadius, rect.h / 2, rect.w / 2)
            : shape === 'rounded'
              ? 16
              : shape === 'square'
                ? 8
                : 0;

    /** The outline of the body, drawn several times: background, tint, clip for the fill, stroke */
    const bodyShape = (props: React.SVGProps<SVGEllipseElement & SVGRectElement>): React.ReactElement =>
        shape === 'circle' ? (
            <ellipse
                cx={rect.x + rect.w / 2}
                cy={rect.y + rect.h / 2}
                rx={rect.w / 2}
                ry={rect.h / 2}
                {...props}
            />
        ) : (
            <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                rx={radius}
                {...props}
            />
        );

    return (
        <>
            {/* Glass lets the page through: the surface at less than half, and a highlight
                across the top edge, which is what makes a pane read as a pane */}
            {bodyShape({
                fill: look.glass ? withAlpha(theme.surface, theme.mode === 'dark' ? 0.5 : 0.62) : theme.surface,
                filter: shadowId ? `url(#${shadowId})` : undefined,
            })}
            {/* The base tint goes under the fill, so the empty part looks like the other nodes rather
                than like a hole */}
            {bodyShape({ fill: tint })}
            {glassId ? bodyShape({ fill: `url(#${glassId})` }) : null}
            {/* The fill is drawn inside the body, clipped to its shape, so a battery reads as a
                container that fills up rather than as a number with a bar next to it. The step from
                the tint to the fill has to be big enough to read at tile size. */}
            {fill || chart ? (
                <>
                    <clipPath id={clipId}>{bodyShape({})}</clipPath>
                    <g clipPath={`url(#${clipId})`}>
                        {fill ? (
                            <rect
                                x={rect.x}
                                y={rect.y + rect.h * (1 - level / 100)}
                                width={rect.w}
                                height={rect.h * (level / 100)}
                                fill={withAlpha(color, theme.mode === 'dark' ? 0.4 : 0.26)}
                            />
                        ) : null}
                        {chart}
                    </g>
                </>
            ) : null}
            {ring ? (
                <>
                    {/* The track, then the part of it that is reached */}
                    {bodyShape({ fill: 'none', stroke: withAlpha(color, 0.22), strokeWidth: look.outlineWidth + 2 })}
                    {level >= 99.95 ? (
                        bodyShape({ fill: 'none', stroke: color, strokeWidth: look.outlineWidth + 2, filter: glow })
                    ) : level > 0 ? (
                        <path
                            d={ringArc(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w / 2, rect.h / 2, level)}
                            fill="none"
                            stroke={color}
                            strokeWidth={look.outlineWidth + 2}
                            strokeLinecap="round"
                            filter={glow}
                        />
                    ) : null}
                </>
            ) : (
                bodyShape({ fill: 'none', stroke: outline, strokeWidth: look.outlineWidth, filter: glow })
            )}
        </>
    );
}

/**
 * The arc of a ring gauge: from the top of an ellipse, clockwise, `level` percent of the way round.
 *
 * @param cx centre x
 * @param cy centre y
 * @param rx horizontal radius
 * @param ry vertical radius
 * @param level 0..100; a full ring is drawn as an ellipse by the caller, an arc cannot close itself
 */
function ringArc(cx: number, cy: number, rx: number, ry: number, level: number): string {
    const angle = (level / 100) * 2 * Math.PI;
    const x = cx + rx * Math.sin(angle);
    const y = cy - ry * Math.cos(angle);
    return `M ${cx} ${cy - ry} A ${rx} ${ry} 0 ${angle > Math.PI ? 1 : 0} 1 ${x} ${y}`;
}

/** One line of text in a card: the value, the label, the second line */
interface CardLine {
    text: string;
    size: number;
    weight: number;
    color: string;
}

/**
 * The content of a card: icon, and a block of lines -- value, label, second line -- beside it or
 * under it. The label is part of the card here, not a caption below it.
 */
function CardContent({
    node,
    theme,
    look,
    lines,
    glowId,
}: {
    node: NodeRuntime;
    theme: FlowTheme;
    look: DiagramStyle;
    lines: CardLine[];
    glowId?: string;
}): React.ReactElement {
    const { rect } = node;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const left = !!node.icon && iconPlacement(node.node) === 'left';
    const chip = look.iconChip && node.node.kind === 'sink' && !!node.icon;

    let iconSize: number;
    let iconX: number;
    let textX: number;
    let room: number;
    let anchor: 'start' | 'middle';
    if (left) {
        const pad = Math.max(rect.h * 0.16, 8);
        iconSize = Math.min(rect.h * (chip ? 0.4 : 0.5), rect.w * 0.26);
        const box = chip ? iconSize * 1.5 : iconSize;
        iconX = rect.x + pad + box / 2;
        textX = rect.x + pad + box + pad * 0.8;
        room = rect.x + rect.w - pad * 0.8 - textX;
        anchor = 'start';
    } else {
        iconSize = node.icon ? Math.min(rect.w, rect.h) * (chip ? 0.24 : 0.3) : 0;
        iconX = cx;
        textX = cx;
        room = rect.w - 2 * Math.max(rect.w * 0.06, 6);
        anchor = 'middle';
    }
    // A line too long for the card gets smaller rather than running over its edge
    const fitted = lines.map(line => ({ ...line, size: fitFontSize(line.text, line.size, room, line.weight >= 600) }));
    const heights = fitted.map(line => line.size * 1.25);
    const block = heights.reduce((sum, height) => sum + height, 0);

    let iconY: number;
    let top: number;
    if (left) {
        iconY = cy;
        top = cy - block / 2;
    } else {
        const box = chip ? iconSize * 1.5 : iconSize;
        const gap = node.icon ? Math.max(rect.h * 0.05, 4) : 0;
        const total = box + gap + block;
        iconY = cy - total / 2 + box / 2;
        top = cy - total / 2 + box + gap;
    }

    // Each line's centre, stacked from the top of the block
    const centres = heights.map(
        (height, index) => top + heights.slice(0, index).reduce((sum, h) => sum + h, 0) + height / 2,
    );
    return (
        <>
            {chip ? (
                <rect
                    x={iconX - iconSize * 0.75}
                    y={iconY - iconSize * 0.75}
                    width={iconSize * 1.5}
                    height={iconSize * 1.5}
                    rx={iconSize * 0.34}
                    fill={withAlpha(node.color, theme.mode === 'dark' ? 0.2 : 0.13)}
                />
            ) : null}
            <g filter={glowId ? `url(#${glowId})` : undefined}>
                {renderBuiltinIcon(node.icon, {
                    x: iconX,
                    y: iconY,
                    size: iconSize,
                    color: node.color,
                    level: node.iconLevel,
                }) ??
                    (node.icon && !node.icon.startsWith('ef:') ? (
                        <image
                            x={iconX - iconSize / 2}
                            y={iconY - iconSize / 2}
                            width={iconSize}
                            height={iconSize}
                            href={node.icon}
                            preserveAspectRatio="xMidYMid meet"
                        />
                    ) : null)}
            </g>
            {fitted.map((line, index) => {
                return (
                    <text
                        key={index}
                        x={textX}
                        y={centres[index]}
                        textAnchor={anchor}
                        dominantBaseline="middle"
                        fontSize={line.size}
                        fontWeight={line.weight}
                        fill={line.color}
                        style={{ userSelect: 'none' }}
                    >
                        {line.text}
                    </text>
                );
            })}
        </>
    );
}

function NodeLayer({
    nodes,
    theme,
    selected,
    onNodeClick,
    hideLabels,
    look,
    shadowId,
    glowId,
    iconGlowId,
    glassId,
}: {
    nodes: NodeRuntime[];
    theme: FlowTheme;
    selected: Set<string>;
    onNodeClick?: (node: FlowNode, event: React.MouseEvent) => void;
    hideLabels?: boolean;
    look: DiagramStyle;
    shadowId?: string;
    glowId?: string;
    iconGlowId?: string;
    glassId?: string;
}): React.ReactElement {
    return (
        <g className="ef-nodes">
            {nodes.map(node => {
                if (!node.visible) {
                    return null;
                }

                const { rect } = node;
                const cx = rect.x + rect.w / 2;
                const cy = rect.y + rect.h / 2;
                const isSelected = selected.has(node.node.id);
                const clickable = !!node.node.action && node.node.action.type !== 'none';

                if (node.node.kind === 'label') {
                    return (
                        <text
                            key={node.node.id}
                            x={cx}
                            y={cy}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fontSize={node.fontSize}
                            fontWeight={600}
                            fill={node.node.color || theme.text}
                            style={{ userSelect: 'none' }}
                        >
                            {node.text || node.node.label || ''}
                        </text>
                    );
                }

                if (node.node.kind === 'image') {
                    return node.icon ? (
                        <image
                            key={node.node.id}
                            x={rect.x}
                            y={rect.y}
                            width={rect.w}
                            height={rect.h}
                            href={node.icon}
                            preserveAspectRatio="xMidYMid meet"
                        />
                    ) : null;
                }

                // A junction is a dot -- unless it carries a symbol, which makes it a valve or a pump,
                // and those are drawn like any other node
                if (node.node.kind === 'bus' && !node.icon) {
                    return (
                        <circle
                            key={node.node.id}
                            cx={cx}
                            cy={cy}
                            r={Math.min(rect.w, rect.h) / 2}
                            fill={node.color}
                            stroke={isSelected ? theme.text : 'none'}
                            strokeWidth={isSelected ? 2 : 0}
                        />
                    );
                }

                const hasBadges = node.badges.length > 0 || node.soc !== null || node.timeText !== null;
                // In a wide, low box the icon sits left of the value and the text is centred in the
                // room that is left; otherwise it sits above
                const left = !!node.icon && iconPlacement(node.node) === 'left';
                const pad = left ? Math.max(rect.h * 0.18, 6) : 0;
                const iconSize = left ? Math.min(rect.h * 0.56, rect.w * 0.3) : Math.min(rect.w, rect.h) * 0.34;
                const iconX = left ? rect.x + pad + iconSize / 2 : cx;
                // Nothing where the number would be (`display: 'none'`): the icon takes the middle
                // instead of keeping the lower half free for a number that is not coming -- a little
                // above it when there are extra values, which then move up into the value's place
                const hasValue = node.valueText.text !== '';
                const iconY = left ? cy : hasValue ? cy - rect.h * 0.16 : hasBadges ? cy - rect.h * 0.12 : cy;
                const textX = left ? (rect.x + pad + iconSize + rect.x + rect.w - pad / 2) / 2 : cx;
                // Room for the value: beside the icon, or across the box -- a little less in a circle,
                // which is narrower below its middle. A node without a shape has no edge to run over.
                const room =
                    node.shape === 'none'
                        ? Infinity
                        : left
                          ? rect.w - pad * 1.5 - iconSize
                          : rect.w * (node.shape === 'circle' ? 0.8 : 0.9);
                // Without an icon above there is no top half to leave free, so the value moves into the
                // middle -- a small box with nothing but a number would otherwise look bottom-heavy
                const valueY = node.icon && !left ? cy + rect.h * 0.15 : cy - (hasBadges ? node.fontSize * 0.4 : 0);

                const classes = [clickable ? 'ef-clickable' : '', node.blink ? 'ef-blink' : '']
                    .filter(Boolean)
                    .join(' ');
                const secondLine = [
                    node.soc !== null ? `${Math.round(node.soc)} %` : null,
                    ...node.badges.map(badge => (badge.label ? `${badge.label} ${badge.text}` : badge.text)),
                    node.timeText,
                ]
                    .filter(Boolean)
                    .join('  ·  ');
                const cardRadius = look.cards && node.shape !== 'none';
                const valueSize = fitFontSize(node.valueText.text, node.fontSize, room, true);
                const secondSize = fitFontSize(secondLine, node.fontSize * 0.64, room, false);
                return (
                    <g
                        key={node.node.id}
                        className={classes || undefined}
                        // A stale value is dimmed as a whole: the reader should not trust any of it
                        opacity={node.stale ? 0.4 : undefined}
                        onClick={clickable && onNodeClick ? event => onNodeClick(node.node, event) : undefined}
                    >
                        {node.node.label ? <title>{node.node.label}</title> : null}

                        {isSelected ? (
                            <rect
                                x={rect.x - 6}
                                y={rect.y - 6}
                                width={rect.w + 12}
                                height={rect.h + 12}
                                rx={node.shape === 'circle' && !cardRadius ? (rect.w + 12) / 2 : look.cardRadius + 4}
                                fill="none"
                                stroke={node.color}
                                strokeWidth={2}
                                strokeDasharray="6 4"
                                className="ef-selection"
                            />
                        ) : null}

                        <NodeShapeBody
                            node={node}
                            theme={theme}
                            look={look}
                            shadowId={shadowId}
                            glowId={glowId}
                            glassId={glassId}
                        />

                        {look.labelInside ? (
                            <CardContent
                                node={node}
                                theme={theme}
                                look={look}
                                glowId={iconGlowId}
                                lines={[
                                    ...(hasValue
                                        ? [
                                              {
                                                  text: node.valueText.text,
                                                  size: node.fontSize,
                                                  weight: 700,
                                                  color: theme.text,
                                              },
                                          ]
                                        : []),
                                    ...(node.node.label && !hideLabels
                                        ? [
                                              {
                                                  text: node.node.label,
                                                  size: Math.min(node.labelFontSize, node.fontSize * 0.8),
                                                  weight: 400,
                                                  color: theme.textSecondary,
                                              },
                                          ]
                                        : []),
                                    ...(secondLine
                                        ? [
                                              {
                                                  text: secondLine,
                                                  size: node.fontSize * 0.6,
                                                  weight: 400,
                                                  color: theme.textSecondary,
                                              },
                                          ]
                                        : []),
                                ]}
                            />
                        ) : null}

                        {look.labelInside
                            ? null
                            : (renderBuiltinIcon(node.icon, {
                                  x: iconX,
                                  y: iconY,
                                  size: iconSize,
                                  color: node.color,
                                  level: node.iconLevel,
                              }) ??
                              (node.icon && !node.icon.startsWith('ef:') ? (
                                  <image
                                      x={iconX - iconSize / 2}
                                      y={iconY - iconSize / 2}
                                      width={iconSize}
                                      height={iconSize}
                                      href={node.icon}
                                      preserveAspectRatio="xMidYMid meet"
                                  />
                              ) : null))}

                        {look.labelInside || !hasValue ? null : (
                            <text
                                x={textX}
                                y={valueY}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={valueSize}
                                fontWeight={700}
                                fill={theme.text}
                                style={{ userSelect: 'none' }}
                            >
                                {node.valueText.text}
                            </text>
                        )}

                        {hasBadges && !look.labelInside ? (
                            <text
                                x={textX}
                                y={valueY + (hasValue ? node.fontSize * 0.95 : 0)}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={secondSize}
                                fill={theme.textSecondary}
                                style={{ userSelect: 'none' }}
                            >
                                {secondLine}
                            </text>
                        ) : null}

                        {node.node.label && !hideLabels && !look.labelInside ? (
                            <text
                                x={cx}
                                y={rect.y + rect.h + node.labelFontSize + 3}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={node.labelFontSize}
                                fill={theme.textSecondary}
                                // a line can leave the node right through its label
                                stroke={look.panel ? theme.background : theme.mode === 'dark' ? '#000' : '#fff'}
                                strokeWidth={node.labelFontSize * 0.4}
                                strokeOpacity={look.panel ? 0.9 : 0.75}
                                paintOrder="stroke"
                                style={{ userSelect: 'none' }}
                            >
                                {node.node.label}
                            </text>
                        ) : null}

                        {/* A transparent shape over the whole node so a click anywhere on it counts,
                            not only on the text or the icon */}
                        {clickable ? (
                            <rect
                                className="ef-node-hit"
                                x={rect.x}
                                y={rect.y}
                                width={rect.w}
                                height={rect.h}
                                rx={node.shape === 'circle' && !cardRadius ? rect.w / 2 : look.cardRadius}
                            />
                        ) : null}
                    </g>
                );
            })}
        </g>
    );
}

/**
 * Draw a diagram.
 *
 * @param props the runtime to draw, the theme and the interaction hooks
 * @returns the SVG element
 */
export function FlowView(props: FlowViewProps): React.ReactElement {
    const { runtime, theme, animate = true, onNodeClick, background, overlay, className, style, svgProps } = props;
    const hideLabels = props.hideLabels;
    const { canvas } = runtime.config;

    const selectedNodes = React.useMemo(() => new Set(props.selectedNodes || []), [props.selectedNodes]);
    const selectedEdges = React.useMemo(() => new Set(props.selectedEdges || []), [props.selectedEdges]);
    // The style of the diagram, on top of the host theme -- the runtime computed its colours with the
    // same adjusted theme
    const look = diagramStyle(runtime.config);
    const drawTheme = React.useMemo(() => look.theme(theme), [look, theme]);
    const filterId = React.useId().replace(/[^A-Za-z0-9_-]/g, '');
    const shadowId = `ef-shadow-${filterId}`;
    const glowId = `ef-glow-${filterId}`;
    const lineGlowId = `ef-line-glow-${filterId}`;
    const iconGlowId = `ef-icon-glow-${filterId}`;
    const glassId = `ef-glass-${filterId}`;
    const dark = drawTheme.mode === 'dark';

    return (
        <svg
            {...svgProps}
            className={`ef-root${animate ? '' : ' ef-paused'}${className ? ` ${className}` : ''}`}
            viewBox={`0 0 ${canvas.w} ${canvas.h}`}
            preserveAspectRatio="xMidYMid meet"
            // Merged, not replaced: the editor passes `touch-action` this way, and a host style must not
            // silently switch dragging on a touch screen back to scrolling
            style={{ ...svgProps?.style, ...style }}
        >
            <style>{CSS}</style>
            {look.glass ? (
                <defs>
                    {/* In the bounding box of whatever uses it, so one gradient serves every body */}
                    <linearGradient
                        id={glassId}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                    >
                        <stop
                            offset="0%"
                            stopColor="#FFFFFF"
                            stopOpacity={dark ? 0.1 : 0.5}
                        />
                        <stop
                            offset="55%"
                            stopColor="#FFFFFF"
                            stopOpacity={0}
                        />
                    </linearGradient>
                </defs>
            ) : null}
            {look.shadow === 'soft' ? (
                <defs>
                    <filter
                        id={shadowId}
                        x="-20%"
                        y="-20%"
                        width="140%"
                        height="170%"
                    >
                        <feDropShadow
                            dx={0}
                            dy={3}
                            stdDeviation={5}
                            floodColor={dark ? '#000000' : '#1B2A4A'}
                            floodOpacity={dark ? 0.45 : 0.1}
                        />
                    </filter>
                </defs>
            ) : look.shadow === 'neo' ? (
                <defs>
                    {/* One blur of the shape, offset twice: a highlight up-left and a shadow down-right */}
                    <filter
                        id={shadowId}
                        x="-100%"
                        y="-100%"
                        width="300%"
                        height="300%"
                    >
                        <feGaussianBlur
                            in="SourceAlpha"
                            stdDeviation={dark ? 6 : 8}
                            result="blur"
                        />
                        <feOffset
                            in="blur"
                            dx={dark ? 5 : 8}
                            dy={dark ? 5 : 8}
                            result="down"
                        />
                        <feOffset
                            in="blur"
                            dx={dark ? -5 : -7}
                            dy={dark ? -5 : -7}
                            result="up"
                        />
                        <feFlood
                            floodColor={dark ? '#000000' : '#9AA9BF'}
                            floodOpacity={dark ? 0.45 : 0.8}
                        />
                        <feComposite
                            in2="down"
                            operator="in"
                            result="dark"
                        />
                        <feFlood
                            floodColor="#FFFFFF"
                            floodOpacity={dark ? 0.06 : 1}
                        />
                        <feComposite
                            in2="up"
                            operator="in"
                            result="light"
                        />
                        <feMerge>
                            <feMergeNode in="light" />
                            <feMergeNode in="dark" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>
            ) : null}
            {look.glow ? (
                <defs>
                    {/* The halo of an outline or an icon: the shape blurred in its own colour, under it */}
                    <filter
                        id={glowId}
                        x="-100%"
                        y="-100%"
                        width="300%"
                        height="300%"
                    >
                        <feGaussianBlur
                            in="SourceGraphic"
                            stdDeviation={dark ? 3 : 2.5}
                            result="blur"
                        />
                        <feComponentTransfer
                            in="blur"
                            result="halo"
                        >
                            <feFuncA
                                type="linear"
                                slope={dark ? 1.1 : 0.6}
                            />
                        </feComponentTransfer>
                        <feMerge>
                            <feMergeNode in="halo" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                    {/* An icon's halo is narrower: a wide one fills in the details and leaves a blob */}
                    <filter
                        id={iconGlowId}
                        x="-50%"
                        y="-50%"
                        width="200%"
                        height="200%"
                    >
                        <feGaussianBlur
                            in="SourceGraphic"
                            stdDeviation={1.6}
                            result="blur"
                        />
                        <feComponentTransfer
                            in="blur"
                            result="halo"
                        >
                            <feFuncA
                                type="linear"
                                slope={dark ? 0.7 : 0.4}
                            />
                        </feComponentTransfer>
                        <feMerge>
                            <feMergeNode in="halo" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                    {/* The lines' halo, over the whole canvas: a straight line has no height, and a
                        region relative to its box would have none either */}
                    <filter
                        id={lineGlowId}
                        filterUnits="userSpaceOnUse"
                        x={-50}
                        y={-50}
                        width={canvas.w + 100}
                        height={canvas.h + 100}
                    >
                        <feGaussianBlur stdDeviation={dark ? 5 : 4} />
                        <feComponentTransfer>
                            <feFuncA
                                type="linear"
                                slope={dark ? 1 : 0.5}
                            />
                        </feComponentTransfer>
                    </filter>
                </defs>
            ) : null}
            {/* No background means none: whatever the widget sits on shows through. A style only
                decides the shape of the one the diagram brings itself -- a card style rounds it. */}
            {canvas.background ? (
                <rect
                    x={0}
                    y={0}
                    width={canvas.w}
                    height={canvas.h}
                    rx={look.panel ? 24 : 0}
                    fill={canvas.background}
                />
            ) : null}
            {/* Marked, so an image export can leave the editor's grid and handles out */}
            {background ? <g className="ef-background">{background}</g> : null}
            <EdgeLayer
                edges={runtime.edges}
                animate={animate}
                selected={selectedEdges}
                animationGap={runtime.animation.gap}
                dotSize={runtime.animation.dotSize}
                look={look}
                glowId={look.glow ? lineGlowId : undefined}
            />
            <NodeLayer
                nodes={runtime.nodes}
                theme={drawTheme}
                selected={selectedNodes}
                onNodeClick={onNodeClick}
                hideLabels={hideLabels}
                look={look}
                shadowId={look.shadow !== 'none' ? shadowId : undefined}
                glowId={look.glow ? glowId : undefined}
                iconGlowId={look.glow ? iconGlowId : undefined}
                glassId={look.glass ? glassId : undefined}
            />
            {hideLabels ? null : (
                <EdgeLabels
                    edges={runtime.edges}
                    theme={drawTheme}
                    fontSize={runtime.labelFontSize}
                    look={look}
                    chip={runtime.config.defaults?.edgeLabel === 'chip'}
                />
            )}
            {overlay ? <g className="ef-overlay">{overlay}</g> : null}
        </svg>
    );
}

export default FlowView;
