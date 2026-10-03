/**
 * Tests for the parts of the core that are pure functions: the expression language, the formatting,
 * the geometry and the runtime resolution.
 *
 * These are the parts where a mistake is invisible in a screenshot -- a diagram with a wrong sign, a
 * unit scaled by a factor of 1000 or a direction that flips on noise looks perfectly fine until
 * somebody compares it with their meter.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { compileExpr, evalExpr, ExprError, exprVariables } from '../packages/core/src/expr';
import {
    amountUnit,
    fitFontSize,
    formatTimestamp,
    formatValue,
    integralSeconds,
    scaleUnit,
} from '../packages/core/src/format';
import { collectOids, resolveSrc, toNumber, createValueGetter } from '../packages/core/src/values';
import { computeRuntime } from '../packages/core/src/runtime';
import { MEDIA, MEDIUM_IDS, mediumDefaults, mediumOf } from '../packages/core/src/media';
import { anchorOf, bendAt, edgeGeometry } from '../packages/core/src/geometry';
import {
    DEFAULT_ANIMATION,
    DEFAULT_CANVAS,
    defaultIcon,
    emptyConfig,
    iconPlacement,
    nodeLabelSize,
    normalizeConfig,
    nodeRect,
    pageLabelSize,
    edgeThreshold,
} from '../packages/core/src/defaults';
import { CLIPBOARD_FORMAT, copyNodes, parseClipboard, pasteNodes } from '../packages/core/src/clipboard';
import { cachedUnit, loadUnits, sourceUnit } from '../packages/core/src/units';
import {
    cachedEnergyToday,
    cachedHistory,
    energyRequests,
    historyRequests,
    loadEnergyToday,
    loadHistory,
    sparklinePaths,
} from '../packages/core/src/history';
import { autarky, firstMatchingRule, ruleMatches, scaleColor, selfConsumption } from '../packages/core/src/rules';
import { DIAGRAM_STYLE_IDS, diagramStyle, styledTheme } from '../packages/core/src/styles';
import {
    buildFromDevices,
    guessDevice,
    guessDeviceKind,
    isFlowState,
    isSocState,
    objectName,
} from '../packages/core/src/assistant';
import { BUILTIN_ICONS, renderBuiltinIcon } from '../packages/core/src/icons';
import FlowView from '../packages/core/src/FlowView';
import { importEnergiefluss, isEnergiefluss } from '../packages/core/src/importEnergiefluss';
import { buildPreset, PRESETS } from '../packages/core/src/presets';
import {
    paletteChange,
    paletteEntryOf,
    paletteOf,
    switchText,
    switchTextMap,
    withSwitchText,
} from '../packages/core/src/palette';
import { hasTemplate, renderTemplate, templateOids } from '../packages/core/src/template';
import { defaultRole } from '../packages/core/src/hydraulics';
import { kindLabel, mediumWord, paletteLabel } from '../packages/editor/src/labels';
import {
    BUNDLE_FORMAT,
    createBundle,
    diagramFileName,
    isBundle,
    nameFromFileName,
    readImport,
} from '../packages/core/src/exchange';
import {
    isDiagramId,
    newDiagramId,
    diagramFromNative,
    readDiagramAttribute,
    diagramNative,
    slugify,
} from '../packages/core/src/storage';
import {
    createEdge,
    createNode,
    fitCanvas,
    moveNodes,
    removeNode,
    removeNodes,
    renameNode,
    resizeNodes,
    uniqueId,
} from '../packages/core/src/model';
import {
    createTheme,
    DARK_THEME,
    LIGHT_THEME,
    muteColor,
    parseColorString,
    themeFromMui,
    withAlpha,
} from '../packages/core/src/theme';
import type { FlowConfig, FlowNode } from '../packages/core/src/types';

describe('expr', () => {
    it('evaluates arithmetic with the usual precedence', () => {
        assert.equal(evalExpr('2 + 3 * 4', {}), 14);
        assert.equal(evalExpr('(2 + 3) * 4', {}), 20);
        assert.equal(evalExpr('-3 + 1', {}), -2);
        assert.equal(evalExpr('10 / 4', {}), 2.5);
        assert.equal(evalExpr('2 * 3 - 4 / 2', {}), 4);
    });

    it('reads variables and treats an unknown name as unknown', () => {
        assert.equal(evalExpr('pv - grid', { pv: 5000, grid: 1200 }), 3800);
        assert.equal(evalExpr('pv - nothing', { pv: 5000 }), null);
    });

    it('propagates null through every operator', () => {
        assert.equal(evalExpr('a + b', { a: 1, b: null }), null);
        assert.equal(evalExpr('a * b', { a: null, b: 2 }), null);
        assert.equal(evalExpr('-a', { a: null }), null);
        assert.equal(evalExpr('a > b', { a: 1, b: null }), null);
    });

    it('never yields Infinity or NaN', () => {
        assert.equal(evalExpr('1 / 0', {}), null);
        assert.equal(evalExpr('sqrt(0 - 4)', {}), null);
    });

    it('skips unknown arguments in sum and avg', () => {
        assert.equal(evalExpr('sum(a, b, c)', { a: 100, b: null, c: 200 }), 300);
        assert.equal(evalExpr('avg(a, b)', { a: 10, b: null }), 10);
        assert.equal(evalExpr('sum(a, b)', { a: null, b: null }), null);
    });

    it('supports comparisons and if()', () => {
        assert.equal(evalExpr('if(soc > 95, 0, charge)', { soc: 98, charge: 2000 }), 0);
        assert.equal(evalExpr('if(soc > 95, 0, charge)', { soc: 40, charge: 2000 }), 2000);
        assert.equal(evalExpr('a - b > 0', { a: 5, b: 3 }), 1);
    });

    it('supports the numeric helpers', () => {
        assert.equal(evalExpr('abs(0 - 7)', {}), 7);
        assert.equal(evalExpr('min(4, 9, 2)', {}), 2);
        assert.equal(evalExpr('max(4, 9, 2)', {}), 9);
        assert.equal(evalExpr('clamp(15, 0, 10)', {}), 10);
        assert.equal(evalExpr('round(2.6)', {}), 3);
        assert.equal(evalExpr('pow(2, 10)', {}), 1024);
    });

    it('parses exponent notation', () => {
        assert.equal(evalExpr('1e3 + 5', {}), 1005);
        assert.equal(evalExpr('2.5e-2', {}), 0.025);
    });

    it('reports where a formula is broken', () => {
        assert.throws(() => compileExpr('1 +'), ExprError);
        assert.throws(() => compileExpr('foo(1)'), /Unknown function/);
        assert.throws(() => compileExpr('min()'), /argument/);
        assert.throws(() => compileExpr('1 2'), /Unexpected token/);
        // The renderer must not throw on a broken formula
        assert.equal(evalExpr('1 +', {}), null);
    });

    it('lists the variables a formula reads, without the function names', () => {
        assert.deepEqual(exprVariables('sum(pv1, pv2) - grid').sort(), ['grid', 'pv1', 'pv2']);
    });
});

describe('format', () => {
    it('scales watts to the readable multiple', () => {
        assert.deepEqual(scaleUnit(8734, 'W'), { value: 8.734, unit: 'kW', scaled: true, scalable: true });
        assert.deepEqual(scaleUnit(734, 'W'), { value: 734, unit: 'W', scaled: false, scalable: true });
        assert.deepEqual(scaleUnit(2_500_000, 'W'), { value: 2.5, unit: 'MW', scaled: true, scalable: true });
        assert.deepEqual(scaleUnit(-8734, 'W'), { value: -8.734, unit: 'kW', scaled: true, scalable: true });
    });

    it('scales a value that is already prefixed', () => {
        assert.deepEqual(scaleUnit(0.35, 'kW'), { value: 350, unit: 'W', scaled: false, scalable: true });
        assert.deepEqual(scaleUnit(2500, 'kWh'), { value: 2.5, unit: 'MWh', scaled: true, scalable: true });
    });

    it('keeps the configured unit at exactly zero, so the display does not flip', () => {
        assert.deepEqual(scaleUnit(0, 'W'), { value: 0, unit: 'W', scaled: false, scalable: true });
    });

    it('leaves units alone that have no multiples', () => {
        assert.deepEqual(scaleUnit(4000, '%'), { value: 4000, unit: '%', scaled: false, scalable: false });
        assert.deepEqual(scaleUnit(4000, 'degC'), { value: 4000, unit: 'degC', scaled: false, scalable: false });
        assert.deepEqual(scaleUnit(4000, 'W', false), { value: 4000, unit: 'W', scaled: false, scalable: false });
    });

    it('prints whole watts and two decimals once it is kilowatts', () => {
        // The prefix decides the resolution, not the magnitude: "40,0 W" and "0,00 W" are what a
        // magnitude rule produces, and neither is how a meter reads
        assert.equal(formatValue(0, { unit: 'W', locale: 'en-US' }).text, '0 W');
        assert.equal(formatValue(40, { unit: 'W', locale: 'en-US' }).text, '40 W');
        assert.equal(formatValue(196, { unit: 'W', locale: 'en-US' }).text, '196 W');
        assert.equal(formatValue(8734, { unit: 'W', locale: 'en-US' }).text, '8.73 kW');
        assert.equal(formatValue(2_500_000, { unit: 'W', locale: 'en-US' }).text, '2.50 MW');
        // A unit with no multiples still goes by the magnitude
        assert.equal(formatValue(12, { unit: 'A', locale: 'en-US' }).text, '12.0 A');
        assert.equal(formatValue(4.2, { unit: 'bar', locale: 'en-US' }).text, '4.20 bar');
        // ... except a percentage, which is a whole number, as the charge line has always shown it
        assert.equal(formatValue(98, { unit: '%', locale: 'en-US' }).text, '98 %');
        assert.equal(formatValue(62.4, { unit: '%', locale: 'en-US' }).text, '62 %');
    });

    it('formats with a unit and a placeholder for an unknown value', () => {
        assert.equal(formatValue(8734, { unit: 'W', locale: 'en-US' }).text, '8.73 kW');
        assert.equal(formatValue(734, { unit: 'W', locale: 'en-US' }).text, '734 W');
        assert.equal(formatValue(null, { unit: 'W' }).text, '--');
        assert.equal(formatValue(1234.5, { unit: 'W', decimals: 0, locale: 'en-US' }).text, '1 kW');
    });

    it('does not print a negative zero', () => {
        assert.equal(
            formatValue(-0.001, { unit: 'kW', decimals: 2, autoScale: false, locale: 'en-US' }).text,
            '0.00 kW',
        );
    });
});

describe('values', () => {
    it('coerces what a state can carry', () => {
        assert.equal(toNumber(5), 5);
        assert.equal(toNumber(true), 1);
        assert.equal(toNumber(false), 0);
        assert.equal(toNumber('3.5'), 3.5);
        assert.equal(toNumber('3,5'), 3.5);
        assert.equal(toNumber(''), null);
        assert.equal(toNumber(null), null);
        assert.equal(toNumber(undefined), null);
        assert.equal(toNumber('abc'), null);
        assert.equal(toNumber(Infinity), null);
    });

    it('applies factor, offset, sign, deadband and clamp in order', () => {
        const get = createValueGetter({ 'a.val': 2500 }, '.val');
        assert.equal(resolveSrc({ oid: 'a', factor: 0.001 }, get), 2.5);
        assert.equal(resolveSrc({ oid: 'a', factor: 0.001, offset: 1 }, get), 3.5);
        assert.equal(resolveSrc({ oid: 'a', invert: true }, get), -2500);
        assert.equal(resolveSrc({ oid: 'a', max: 1000 }, get), 1000);
        // The deadband is expressed in the unit the user sees, so after the factor
        assert.equal(resolveSrc({ oid: 'a', factor: 0.001, deadband: 5 }, get), 0);
    });

    it('keeps an unknown state unknown rather than zero', () => {
        const get = createValueGetter({}, '.val');
        assert.equal(resolveSrc({ oid: 'missing' }, get), null);
        assert.equal(resolveSrc({ oid: '' }, get), null);
    });

    it('resolves nested expressions', () => {
        const get = createValueGetter({ 'pv.val': 5000, 'feed.val': 1200 });
        const value = resolveSrc(
            { expr: 'pv - feed', vars: { pv: { oid: 'pv' }, feed: { oid: 'feed' } } },
            createValueGetter({ pv: 5000, feed: 1200 }),
        );
        assert.equal(value, 3800);
        assert.equal(get('pv.val'), 5000);
    });

    it('collects every state the document reads, once', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 100, h: 100 },
            nodes: [
                {
                    id: 'a',
                    kind: 'source',
                    x: 0,
                    y: 0,
                    value: { expr: 'x + y', vars: { x: { oid: 's1' }, y: { oid: 's2' } } },
                    badges: [{ src: { oid: 's3' } }],
                },
                { id: 'b', kind: 'storage', x: 0, y: 0, value: { oid: 's1' }, soc: { oid: 's4' } },
            ],
            edges: [{ id: 'e', from: 'a', to: 'b', value: { oid: 's5' }, reverse: { oid: 's6' }, mode: 'split' }],
        };
        assert.deepEqual(collectOids(config).sort(), ['s1', 's2', 's3', 's4', 's5', 's6']);
    });
});

describe('geometry', () => {
    it('attaches a circle radially towards the other node', () => {
        const rect = { x: 0, y: 0, w: 100, h: 100 };
        const anchor = anchorOf(rect, 'circle', 'auto', { x: 250, y: 50 });
        assert.equal(anchor.point.x, 100);
        assert.equal(anchor.point.y, 50);
        assert.equal(anchor.dir.x, 1);
    });

    it('attaches a rectangle at the side that faces the other node', () => {
        const rect = { x: 0, y: 0, w: 100, h: 40 };
        const below = anchorOf(rect, 'rounded', 'auto', { x: 50, y: 400 });
        assert.equal(below.point.y, 40);
        assert.deepEqual(below.dir, { x: 0, y: 1 });
    });

    it('honours an explicit side', () => {
        const rect = { x: 0, y: 0, w: 100, h: 100 };
        const left = anchorOf(rect, 'circle', 'left', { x: 500, y: 50 });
        assert.equal(left.point.x, 0);
    });

    it('produces a cubic for a bezier and a polyline for waypoints', () => {
        const from = { point: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
        const to = { point: { x: 200, y: 100 }, dir: { x: -1, y: 0 } };

        const bezier = edgeGeometry(from, to, 'bezier');
        assert.ok(bezier.d.startsWith('M0 0 C'), bezier.d);
        assert.ok(bezier.length > 200, `length ${bezier.length}`);
        // The midpoint of a symmetric curve sits halfway between the endpoints
        assert.equal(Math.round(bezier.mid.x), 100);
        assert.equal(Math.round(bezier.mid.y), 50);

        const routed = edgeGeometry(from, to, 'bezier', [{ x: 100, y: 0 }]);
        assert.ok(routed.d.includes('Q'), routed.d);

        const straight = edgeGeometry(from, to, 'straight');
        assert.equal(straight.d, 'M0 0 L200 100');
    });

    it('lets the middle segment of an orthogonal route move between its ends', () => {
        const from = { point: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
        const to = { point: { x: 200, y: 100 }, dir: { x: -1, y: 0 } };

        // Two horizontal ends: a vertical middle segment, halfway by default
        const centred = edgeGeometry(from, to, 'orthogonal');
        assert.deepEqual(centred.segment, {
            axis: 'x',
            start: { x: 100, y: 0 },
            end: { x: 100, y: 100 },
            fromValue: 0,
            toValue: 200,
        });
        const moved = edgeGeometry(from, to, 'orthogonal', undefined, 16, 0.25);
        assert.equal(moved.segment?.start.x, 50);
        // Dragging to x = 150 is three quarters of the way; beyond the ends it stops at them
        assert.equal(bendAt(moved.segment, 150), 0.75);
        assert.equal(bendAt(moved.segment, -40), 0);
        assert.equal(bendAt(moved.segment, 900), 1);

        // Two vertical ends: a horizontal segment that moves up and down
        const down = { point: { x: 0, y: 0 }, dir: { x: 0, y: 1 } };
        const up = { point: { x: 100, y: 200 }, dir: { x: 0, y: -1 } };
        assert.equal(edgeGeometry(down, up, 'orthogonal', undefined, 16, 0.25).segment?.start.y, 50);
        assert.equal(edgeGeometry(down, up, 'orthogonal').segment?.axis, 'y');

        // Two ends at the same height: the "segment" has length zero, nothing to grab
        const level = { point: { x: 200, y: 0 }, dir: { x: -1, y: 0 } };
        assert.equal(edgeGeometry(from, level, 'orthogonal').segment, undefined);

        // One corner has no free segment, and neither has a curve
        assert.equal(edgeGeometry(from, up, 'orthogonal').segment, undefined);
        assert.equal(edgeGeometry(from, to, 'bezier').segment, undefined);
    });

    it('does not produce NaN when two nodes sit on the same spot', () => {
        const same = { x: 10, y: 10, w: 40, h: 40 };
        const anchor = anchorOf(same, 'circle', 'auto', { x: 30, y: 30 });
        assert.ok(Number.isFinite(anchor.point.x) && Number.isFinite(anchor.point.y));
        const geometry = edgeGeometry(anchor, anchor, 'bezier');
        assert.ok(!geometry.d.includes('NaN'), geometry.d);
    });
});

describe('runtime', () => {
    const theme = LIGHT_THEME;

    function twoNodes(edgeExtra: Partial<FlowConfig['edges'][0]> = {}): FlowConfig {
        return {
            v: 1,
            canvas: { w: 400, h: 200 },
            defaults: { unit: 'W' },
            nodes: [
                { id: 'grid', kind: 'grid', x: 80, y: 100 },
                { id: 'home', kind: 'sink', x: 320, y: 100 },
            ],
            edges: [{ id: 'e', from: 'grid', to: 'home', value: { oid: 'p' }, ...edgeExtra }],
        };
    }

    it('reads a positive value as flowing from -> to and a negative one as the reverse', () => {
        const config = twoNodes({ mode: 'signed' });

        const importing = computeRuntime(config, createValueGetter({ p: 2400 }), theme).edges[0];
        assert.equal(importing.direction, 1);
        assert.equal(importing.magnitude, 2400);

        const exporting = computeRuntime(config, createValueGetter({ p: -1800 }), theme).edges[0];
        assert.equal(exporting.direction, -1);
        assert.equal(exporting.magnitude, 1800);
        // The label shows the amount; the direction is in the animation, not in a minus sign
        assert.equal(exporting.valueText.text.startsWith('-'), false);
    });

    it('takes the colour of wherever the energy comes from', () => {
        const config = twoNodes({ mode: 'signed' });
        const importing = computeRuntime(config, createValueGetter({ p: 2400 }), theme).edges[0];
        const exporting = computeRuntime(config, createValueGetter({ p: -2400 }), theme).edges[0];
        assert.equal(importing.color, theme.kinds.grid);
        assert.equal(exporting.color, theme.kinds.sink);
    });

    it('clamps a positive-only edge instead of reversing it', () => {
        const config = twoNodes({ mode: 'positive' });
        const runtime = computeRuntime(config, createValueGetter({ p: -50 }), theme);
        assert.equal(runtime.edges[0].value, 0);
        assert.equal(runtime.edges[0].direction, 0);
    });

    it('nets the two states of a split edge', () => {
        const config = twoNodes({ mode: 'split', value: { oid: 'in' }, reverse: { oid: 'out' } });
        const runtime = computeRuntime(config, createValueGetter({ in: 300, out: 1300 }), theme);
        assert.equal(runtime.edges[0].value, -1000);
        assert.equal(runtime.edges[0].direction, -1);

        const unknown = computeRuntime(config, createValueGetter({}), theme);
        assert.equal(unknown.edges[0].value, null);
    });

    it('treats a value below the threshold as idle and does not animate it', () => {
        const config = twoNodes({ threshold: 20 });
        const runtime = computeRuntime(config, createValueGetter({ p: 12 }), theme);
        assert.equal(runtime.edges[0].active, false);
        assert.equal(runtime.edges[0].dotDuration, 0);
        assert.equal(runtime.edges[0].direction, 0);
    });

    it('moves the dots faster the more power flows, within the clamp', () => {
        const config = twoNodes();
        const slow = computeRuntime(config, createValueGetter({ p: 500 }), theme).edges[0].dotDuration;
        const fast = computeRuntime(config, createValueGetter({ p: 6000 }), theme).edges[0].dotDuration;
        assert.ok(fast < slow, `${fast} should be shorter than ${slow}`);

        const enormous = computeRuntime(config, createValueGetter({ p: 900000 }), theme).edges[0].dotDuration;
        assert.ok(enormous >= 0.18, `clamped to the minimum, got ${enormous}`);
    });

    it('hides a node whose value is zero when asked, and the edges with it', () => {
        const config = twoNodes();
        config.nodes[1] = { ...config.nodes[1], hideWhenZero: true, value: { oid: 'w' } };

        const off = computeRuntime(config, createValueGetter({ p: 1000, w: 0 }), theme);
        assert.equal(off.nodeById.home.visible, false);
        assert.equal(off.edges[0].visible, false);

        const on = computeRuntime(config, createValueGetter({ p: 1000, w: 4000 }), theme);
        assert.equal(on.nodeById.home.visible, true);
        assert.equal(on.edges[0].visible, true);
    });

    it('skips an edge whose endpoint was deleted instead of throwing', () => {
        const config = twoNodes();
        config.edges.push({ id: 'dangling', from: 'grid', to: 'ghost', value: { oid: 'p' } });
        const runtime = computeRuntime(config, createValueGetter({ p: 100 }), theme);
        assert.equal(runtime.edges.length, 1);
    });

    it('derives a node value from its connections when nothing is bound to it', () => {
        const config = buildPreset('pv-battery-home', key => key);
        // The three states the template asks for: PV production, grid power, battery power
        const bind = (id: string, oid: string): void => {
            const edge = config.edges.find(item => item.id === id)!;
            edge.value = { oid };
        };
        bind('pv-home', 'pv');
        bind('grid-home', 'grid');
        bind('battery-home', 'battery');

        // 6.4 kW from the roof, 0.9 kW bought, 2.1 kW into the battery
        const runtime = computeRuntime(config, createValueGetter({ pv: 6400, grid: 900, battery: -2100 }), theme);

        // A producer shows what leaves it, so the sun is positive
        assert.equal(runtime.nodeById.pv.value, 6400);
        // The grid shows what it delivers: positive while buying
        assert.equal(runtime.nodeById.grid.value, 900);
        // The battery is charging, so it delivers a negative amount
        assert.equal(runtime.nodeById.battery.value, -2100);
        // The house shows what arrives: 6400 + 900 - 2100
        assert.equal(runtime.nodeById.home.value, 5200);
    });

    it('shows the production of a producer that is itself fed by sub-producers', () => {
        // Four MPPT strings into one "production" box, which then feeds the house: the box must show
        // what it produces, not the net of in and out -- which is zero by conservation
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 600, h: 400 },
            defaults: { unit: 'W' },
            nodes: [
                { id: 's1', kind: 'source', x: 60, y: 60 },
                { id: 's2', kind: 'source', x: 180, y: 60 },
                { id: 'pv', kind: 'source', x: 120, y: 200 },
                { id: 'home', kind: 'sink', x: 400, y: 200 },
            ],
            edges: [
                { id: 'e1', from: 's1', to: 'pv', value: { oid: 'a' }, mode: 'positive' },
                { id: 'e2', from: 's2', to: 'pv', value: { oid: 'b' }, mode: 'positive' },
                { id: 'e3', from: 'pv', to: 'home', value: { oid: 'c' }, mode: 'positive' },
            ],
        };
        const runtime = computeRuntime(config, createValueGetter({ a: 1800, b: 2200, c: 4000 }), theme);
        assert.equal(runtime.nodeById.pv.value, 4000);
        assert.equal(runtime.nodeById.home.value, 4000);
    });

    it('shows what passes through a junction', () => {
        const config = buildPreset('pv-battery-wallbox', key => key);
        const bind = (id: string, oid: string): void => {
            config.edges.find(item => item.id === id)!.value = { oid };
        };
        bind('pv-bus', 'pv');
        bind('grid-bus', 'grid');
        bind('battery-bus', 'battery');
        bind('bus-home', 'home');
        bind('bus-wallbox', 'wallbox');

        const runtime = computeRuntime(
            config,
            // 6 kW from the roof and 1 kW from the grid arrive; 4 kW house, 3 kW wallbox leave
            createValueGetter({ pv: 6000, grid: 1000, battery: 0, home: 4000, wallbox: 3000 }),
            theme,
        );
        assert.equal(runtime.nodeById.bus.value, 7000);
    });

    it('lets a node with its own source override the derived one', () => {
        const config = buildPreset('pv-home', key => key);
        config.edges[0].value = { oid: 'pv' };
        config.nodes[0] = { ...config.nodes[0], value: { oid: 'ownValue' } };

        const runtime = computeRuntime(config, createValueGetter({ pv: 6400, ownValue: 42 }), theme);
        assert.equal(runtime.nodeById.pv.value, 42);
    });

    it('keeps a node unknown when nothing connected to it has a value', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const runtime = computeRuntime(config, () => null, theme);
        assert.ok(runtime.nodes.every(node => node.value === null));
        assert.ok(runtime.nodes.every(node => node.valueText.text === '--'));
    });

    it('clamps the state of charge to 0..100', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 200, h: 200 },
            nodes: [{ id: 'b', kind: 'storage', x: 100, y: 100, soc: { oid: 'soc' } }],
            edges: [],
        };
        assert.equal(computeRuntime(config, createValueGetter({ soc: 142 }), theme).nodes[0].soc, 100);
        assert.equal(computeRuntime(config, createValueGetter({ soc: -3 }), theme).nodes[0].soc, 0);
        assert.equal(computeRuntime(config, createValueGetter({}), theme).nodes[0].soc, null);
    });
});

describe('defaults', () => {
    it('puts the icon beside the value in a wide, low box, and above it everywhere else', () => {
        const base = { id: 'n', kind: 'storage' as const, x: 100, y: 100 };
        // The small pill of a battery pack: 96 x 44
        assert.equal(iconPlacement({ ...base, shape: 'rounded', w: 96, h: 44 }), 'left');
        // The default rounded box, 124 x 84: 84 high leaves no room above the value either
        assert.equal(iconPlacement({ ...base, shape: 'rounded' }), 'left');
        // A square keeps it on top
        assert.equal(iconPlacement({ ...base, shape: 'square' }), 'top');
        // The big battery box, nearly square
        assert.equal(iconPlacement({ ...base, shape: 'rounded', w: 220, h: 205 }), 'top');
        // A circle has its room above the value
        assert.equal(iconPlacement({ ...base, shape: 'circle', w: 200 }), 'top');
        // The default "value only" box is wide
        assert.equal(iconPlacement({ ...base, shape: 'none' }), 'left');
        // And the node's own choice wins
        assert.equal(iconPlacement({ ...base, shape: 'rounded', w: 96, h: 44, iconPosition: 'top' }), 'top');
    });

    it('gives a node without a body a wide, low box and draws no shape for it', () => {
        const node = { id: 'n', kind: 'sink' as const, x: 100, y: 100, shape: 'none' as const };
        assert.deepEqual(nodeRect(node), { x: 45, y: 72, w: 110, h: 56 });
        const runtime = computeRuntime(
            { v: 1, canvas: { w: 300, h: 200 }, nodes: [node], edges: [] },
            () => null,
            LIGHT_THEME,
        );
        assert.equal(runtime.nodes[0].shape, 'none');
    });

    it('survives anything the host may have stored', () => {
        assert.deepEqual(normalizeConfig(undefined).nodes, []);
        assert.deepEqual(normalizeConfig('').nodes, []);
        assert.deepEqual(normalizeConfig('not json').nodes, []);
        assert.deepEqual(normalizeConfig(42).nodes, []);
        assert.equal(normalizeConfig('{"v":1,"canvas":{"w":300,"h":200},"nodes":[],"edges":[]}').canvas.w, 300);
        // A node without an id and an edge with a missing endpoint are dropped, the rest survives
        const partial = normalizeConfig({
            v: 1,
            canvas: { w: 0, h: -5 },
            nodes: [{ kind: 'source' }, { id: 'ok', kind: 'source', x: 1, y: 1 }],
            edges: [
                { id: 'e1', from: 'ok' },
                { id: 'e2', from: 'ok', to: 'ok' },
            ],
        });
        assert.equal(partial.nodes.length, 1);
        assert.equal(partial.edges.length, 1);
        assert.ok(partial.canvas.w > 0 && partial.canvas.h > 0);
    });

    it('puts the stored position at the centre of the node box', () => {
        const rect = nodeRect({ id: 'n', kind: 'source', x: 100, y: 200 });
        assert.equal(rect.x + rect.w / 2, 100);
        assert.equal(rect.y + rect.h / 2, 200);
    });
});

describe('theme', () => {
    it('parses the colour notations a document can contain', () => {
        assert.deepEqual(parseColorString('#abc'), [170, 187, 204]);
        assert.deepEqual(parseColorString('#AABBCC'), [170, 187, 204]);
        // The alpha channel is dropped rather than refused
        assert.deepEqual(parseColorString('#AABBCC80'), [170, 187, 204]);
        assert.deepEqual(parseColorString('rgb(1, 2, 3)'), [1, 2, 3]);
        assert.deepEqual(parseColorString('rgb(1 2 3)'), [1, 2, 3]);
        assert.deepEqual(parseColorString('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
        assert.deepEqual(parseColorString('rgb(1 2 3 / 50%)'), [1, 2, 3]);
        // hsl() comes from a colour scale, and people type it
        assert.deepEqual(parseColorString('hsl(10, 20%, 30%)'), [92, 66, 61]);
        // Not parseable, and the callers must fall back rather than draw something wrong
        assert.equal(parseColorString('red'), null);
        assert.equal(parseColorString('var(--x)'), null);
        assert.equal(parseColorString(''), null);
    });

    it('falls back instead of crashing on a colour it cannot read', () => {
        assert.equal(muteColor('var(--x)', LIGHT_THEME), LIGHT_THEME.idle);
        assert.equal(withAlpha('var(--x)', 0.5), 'var(--x)');
        assert.equal(withAlpha('#000000', 0.5), 'rgba(0, 0, 0, 0.5)');
    });

    it('mutes a colour towards the idle colour, not past it', () => {
        assert.equal(muteColor('#000000', LIGHT_THEME, 0), 'rgb(0, 0, 0)');
        assert.equal(muteColor('#000000', LIGHT_THEME, 1), 'rgb(199, 208, 217)');
    });

    it('keeps the node accents out of the host palette', () => {
        // A blue primary colour in vis-2 must not turn the photovoltaics blue
        const flattened = themeFromMui({
            palette: { mode: 'dark', primary: { main: '#0000ff' }, text: { primary: '#fafafa' } },
        });
        assert.equal(flattened.mode, 'dark');
        assert.equal(flattened.text, '#fafafa');
        assert.equal(flattened.kinds.source, DARK_THEME.kinds.source);
    });

    it('survives a host that has no theme yet', () => {
        const flattened = themeFromMui(undefined);
        assert.equal(flattened.mode, 'light');
        assert.equal(flattened.kinds.source, LIGHT_THEME.kinds.source);
    });
});

describe('model', () => {
    it('numbers a duplicate id instead of overwriting it', () => {
        assert.equal(uniqueId('pv', []), 'pv');
        assert.equal(uniqueId('pv', ['pv']), 'pv-2');
        assert.equal(uniqueId('pv', ['pv', 'pv-2']), 'pv-3');
    });

    it('removes the edges of a deleted node', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const without = removeNode(config, 'battery');
        assert.equal(without.nodes.length, 3);
        assert.ok(!without.edges.some(edge => edge.from === 'battery' || edge.to === 'battery'));
    });

    it('keeps the edges attached when a node is renamed', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const renamed = renameNode(config, 'pv', 'roof');
        assert.ok(renamed.nodes.some(node => node.id === 'roof'));
        assert.ok(renamed.edges.some(edge => edge.from === 'roof'));
        // A name that is taken changes nothing
        assert.equal(renameNode(renamed, 'roof', 'grid'), renamed);
    });

    it('snaps a moved node onto the grid', () => {
        const config = buildPreset('pv-home', key => key);
        const moved = moveNodes(config, ['pv'], 13, 7);
        const pv = moved.nodes.find(node => node.id === 'pv')!;
        assert.equal(pv.x % 10, 0);
        assert.equal(pv.y % 10, 0);
    });

    it('removes several nodes and every edge that touched one of them', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const without = removeNodes(config, ['pv', 'battery']);
        assert.deepEqual(
            without.nodes.map(node => node.id),
            ['grid', 'home'],
        );
        assert.deepEqual(
            without.edges.map(edge => edge.id),
            ['grid-home'],
        );
    });

    it('moves the route of a connection along when both of its ends move', () => {
        const base = buildPreset('pv-battery-home', key => key);
        const config: FlowConfig = {
            ...base,
            edges: base.edges.map(edge =>
                edge.id === 'pv-home' || edge.id === 'grid-home' ? { ...edge, waypoints: [{ x: 300, y: 200 }] } : edge,
            ),
        };
        const moved = moveNodes(config, ['pv', 'home'], 40, 20);
        // Both ends moved: the waypoint goes with them
        assert.deepEqual(moved.edges.find(edge => edge.id === 'pv-home')!.waypoints, [{ x: 340, y: 220 }]);
        // Only one end moved: the route is still anchored at the grid, so it stays
        assert.deepEqual(moved.edges.find(edge => edge.id === 'grid-home')!.waypoints, [{ x: 300, y: 200 }]);
    });

    it('resizes around the centre, one dimension at a time, never below the minimum', () => {
        const preset = buildPreset('pv-battery-home', key => key);
        const config: FlowConfig = {
            ...preset,
            nodes: preset.nodes.map(node => (node.id === 'home' ? { ...node, shape: 'rounded' as const } : node)),
        };
        const home = config.nodes.find(node => node.id === 'home')!;
        const before = nodeRect(home);

        const wider = resizeNodes(config, ['home'], 20, 0).nodes.find(node => node.id === 'home')!;
        assert.equal(wider.w, before.w + 20);
        assert.equal(wider.h, home.h, 'the height keeps following its default');
        assert.deepEqual([wider.x, wider.y], [home.x, home.y], 'the centre stays');

        const tiny = resizeNodes(config, ['home'], -1000, -1000).nodes.find(node => node.id === 'home')!;
        assert.deepEqual([tiny.w, tiny.h], [20, 20]);

        // A circle has one size: the vertical arrow changes its diameter as well
        const circle = { ...home, id: 'c', shape: 'circle' as const, w: 80 };
        const grown = resizeNodes({ ...config, nodes: [circle] }, ['c'], 0, 10).nodes[0];
        assert.equal(grown.w, 90);
        assert.equal(nodeRect(grown).h, 90);
    });

    it('guesses a bidirectional edge for the grid and the battery', () => {
        const config = buildPreset('pv-battery-home', key => key);
        assert.equal(createEdge(config, 'grid', 'home').mode, 'signed');
        assert.equal(createEdge(config, 'battery', 'home').mode, 'signed');
        assert.equal(createEdge(config, 'pv', 'home').mode, 'positive');
    });

    it('gives a new node an empty source so it can be bound right away', () => {
        const config = buildPreset('pv-home', key => key);
        assert.ok(createNode(config, 'sink', { x: 55, y: 55 }).value);
        assert.equal(createNode(config, 'label', { x: 55, y: 55 }).value, undefined);
        assert.ok(createNode(config, 'storage', { x: 55, y: 55 }).soc);
        // Snapped, and the id does not collide with the preset
        const second = createNode(config, 'grid', { x: 57, y: 53 });
        assert.equal(second.x, 60);
        assert.equal(second.id, 'grid-2');
    });

    it('fits the canvas around the content', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const spread = moveNodes(config, ['pv'], -400, -300);
        const fitted = fitCanvas(spread);
        assert.ok(fitted.nodes.every(node => node.x > 0 && node.y > 0));
        assert.ok(fitted.canvas.w > 0 && fitted.canvas.h > 0);
    });
});

describe('examples', () => {
    it('hybrid-12v is a valid, fully connected diagram', () => {
        const raw = readFileSync(new URL('../examples/hybrid-12v.json', import.meta.url), 'utf8');
        const config = normalizeConfig(JSON.parse(raw));

        // Nothing was dropped by the normalisation: every node has an id, every edge two real ends
        const parsed = JSON.parse(raw) as FlowConfig;
        assert.equal(config.nodes.length, parsed.nodes.length);
        assert.equal(config.edges.length, parsed.edges.length);

        const runtime = computeRuntime(config, () => null, LIGHT_THEME);
        assert.equal(runtime.edges.length, config.edges.length, 'an edge points at a node that does not exist');
        assert.ok(runtime.nodes.every(node => !node.valueText.text.includes('NaN')));

        // It ships unbound: the point of an example is the layout, not somebody else's state ids
        const oids = collectOids(config);
        assert.deepEqual(oids, [], `expected no state ids, found ${oids.join(', ')}`);

        // Every icon it names exists, including the ones added for it
        for (const node of config.nodes) {
            if (node.icon && !node.icon.startsWith('http') && !node.icon.startsWith('data:')) {
                assert.ok(BUILTIN_ICONS[node.icon], `unknown icon "${node.icon}" on node "${node.id}"`);
            }
        }
    });

    it('derives the battery power from its two lines', () => {
        const config = normalizeConfig(
            JSON.parse(readFileSync(new URL('../examples/hybrid-12v.json', import.meta.url), 'utf8')),
        );
        const bind = (id: string, oid: string): void => {
            config.edges.find(edge => edge.id === id)!.value = { oid };
        };
        bind('battery-dc', 'out');
        bind('grid-battery', 'in');

        // 196 W towards the DC branch while 156 W arrive from the charger
        const runtime = computeRuntime(config, createValueGetter({ out: 196, in: 156 }), LIGHT_THEME);
        assert.equal(runtime.nodeById.battery.value, 40);
        assert.equal(runtime.nodeById.battery.valueText.text, '40 W');
    });

    it('gives the strings no icon, rather than the one their kind implies', () => {
        const config = normalizeConfig(
            JSON.parse(readFileSync(new URL('../examples/hybrid-12v.json', import.meta.url), 'utf8')),
        );
        const runtime = computeRuntime(config, () => null, LIGHT_THEME);
        assert.equal(runtime.nodeById.mppt1.icon, '');
        // ... while a node that says nothing about its icon still gets one
        assert.equal(runtime.nodeById.pv.icon, 'solar');
    });
});

describe('templates', () => {
    it('every one is valid, unbound, and drawn with icons that exist', () => {
        for (const info of PRESETS) {
            const config = buildPreset(info.id, key => key);
            const normalized = normalizeConfig(config);
            assert.equal(normalized.nodes.length, config.nodes.length, `${info.id}: a node was dropped`);
            assert.equal(normalized.edges.length, config.edges.length, `${info.id}: an edge was dropped`);

            const ids = config.nodes.map(node => node.id);
            assert.equal(new Set(ids).size, ids.length, `${info.id}: two nodes share an id`);
            for (const edge of config.edges) {
                assert.ok(ids.includes(edge.from), `${info.id}: ${edge.id} starts nowhere`);
                assert.ok(ids.includes(edge.to), `${info.id}: ${edge.id} ends nowhere`);
            }
            for (const node of config.nodes) {
                if (node.icon) {
                    assert.ok(BUILTIN_ICONS[node.icon], `${info.id}: unknown icon "${node.icon}"`);
                }
            }

            // A template ships unbound, and says what flows through it
            assert.deepEqual(collectOids(config), [], `${info.id}: brings somebody else's state ids`);
            assert.equal(
                config.defaults?.medium ?? 'energy',
                info.medium,
                `${info.id}: the list and the document disagree about the medium`,
            );
            if (info.medium !== 'energy') {
                assert.equal(config.defaults?.unit, MEDIA[info.medium].unit, `${info.id}: wrong unit`);
            }

            const runtime = computeRuntime(config, () => null, LIGHT_THEME);
            assert.equal(runtime.edges.length, config.edges.length, `${info.id}: an edge points nowhere`);
            assert.ok(
                runtime.nodes.every(node => !node.valueText.text.includes('NaN')),
                `${info.id}: draws NaN`,
            );
        }
    });

    it('draws a junction with a symbol as a part of the line, not as a dot', () => {
        const junction: FlowNode = { id: 'j', kind: 'bus', x: 100, y: 100, value: { oid: '' } };
        assert.deepEqual(nodeRect(junction), { x: 91, y: 91, w: 18, h: 18 }, 'a bare junction is a dot');
        const valve = nodeRect({ ...junction, icon: 'valve' });
        assert.ok(valve.w > 40 && valve.w === valve.h, `a valve needs a body, got ${valve.w}`);
        // ... and the renderer draws that body instead of the dot
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [{ ...junction, icon: 'valve' }],
            edges: [],
        };
        const markup = renderToStaticMarkup(
            React.createElement(FlowView, {
                runtime: computeRuntime(config, () => null, LIGHT_THEME),
                theme: LIGHT_THEME,
                animate: false,
            }),
        );
        assert.ok(markup.includes('M4.5 10.5'), 'the valve symbol is missing');
    });

    it('falls back to the plain word when the medium has none of its own', () => {
        // The host's translator answers with the *namespaced* key when it knows no sentence for it
        const words: Record<string, string> = {
            kind_source: 'Erzeuger',
            kind_label: 'Beschriftung',
            kind_source_water: 'Quelle',
            palette_valve: 'Ventil',
            insp_soc: 'Ladezustand',
            insp_soc_water: 'Füllstand',
        };
        const t = (key: string): string => words[key] ?? `flow_${key}`;
        const water = emptyConfig('water');

        assert.equal(kindLabel('source', water, t), 'Quelle');
        assert.equal(kindLabel('source', undefined, t), 'Erzeuger', 'energy has no word of its own');
        assert.equal(kindLabel('label', water, t), 'Beschriftung');
        assert.equal(paletteLabel({ id: 'valve', kind: 'bus', label: 'palette_valve' }, water, t), 'Ventil');
        assert.equal(paletteLabel({ id: 'source', kind: 'source' }, water, t), 'Quelle');

        // Any sentence of the designer can differ, not only the names of the kinds
        assert.equal(mediumWord('insp_soc', water, t), 'Füllstand');
        assert.equal(mediumWord('insp_soc', undefined, t), 'Ladezustand');
    });

    it('offers a palette that fits what flows', () => {
        const words = {
            en: JSON.parse(
                readFileSync(new URL('../packages/translations/src/en.json', import.meta.url), 'utf8'),
            ) as Record<string, string>,
            de: JSON.parse(
                readFileSync(new URL('../packages/translations/src/de.json', import.meta.url), 'utf8'),
            ) as Record<string, string>,
        };
        for (const medium of MEDIUM_IDS) {
            const entries = paletteOf(medium);
            assert.ok(entries.length >= 5, `${medium}: hardly anything to place`);
            const ids = entries.map(entry => entry.id);
            assert.equal(new Set(ids).size, ids.length, `${medium}: two entries share an id`);
            for (const entry of entries) {
                if (entry.icon) {
                    assert.ok(BUILTIN_ICONS[entry.icon], `${medium}/${entry.id}: unknown icon "${entry.icon}"`);
                }
                // A name of its own has to exist in both dictionaries; without one it borrows the
                // kind's, which the designer already translates per medium
                if (entry.label) {
                    for (const [lang, dictionary] of Object.entries(words)) {
                        assert.ok(dictionary[entry.label], `${lang}: no name for ${medium}/${entry.id}`);
                    }
                }
            }
            // Whatever a water installation is made of, it can still be drawn and connected
            assert.ok(
                entries.some(entry => entry.kind === 'source') && entries.some(entry => entry.kind === 'sink'),
                `${medium}: nowhere for the flow to come from or go to`,
            );
        }
        // The water palette is the one that differs: a valve and a pump are both nodes it flows through
        const water = paletteOf('water');
        assert.deepEqual(
            water.filter(entry => entry.kind === 'bus').map(entry => entry.icon ?? ''),
            ['watermeter', 'flowsensor', 'waterpump', 'valve', ''],
        );
        // An energy diagram keeps the palette it always had
        assert.deepEqual(
            paletteOf('energy').map(entry => entry.kind),
            ['source', 'sink', 'storage', 'grid', 'label', 'image', 'bus'],
        );
        assert.ok(paletteOf('energy').every(entry => entry.icon === undefined && entry.label === undefined));
    });

    it('reads a node as the palette entry it was placed from', () => {
        const valve: FlowNode = { id: 'v', kind: 'bus', x: 0, y: 0, icon: 'valve' };
        assert.equal(paletteEntryOf(valve, 'water')?.id, 'valve');
        assert.equal(paletteEntryOf({ ...valve, icon: 'waterpump' }, 'water')?.id, 'pump');
        // A symbol the user picked makes it a junction with a picture again, which is what it is
        assert.equal(paletteEntryOf({ ...valve, icon: 'pond' }, 'water')?.id, 'bus');
        assert.equal(paletteEntryOf({ ...valve, kind: 'storage', icon: undefined }, 'water')?.id, 'storage');

        // Turning it into a pump brings the pump's symbol with it
        const pump = paletteOf('water').find(entry => entry.id === 'pump')!;
        assert.deepEqual(paletteChange(valve, pump, 'water'), { kind: 'bus', icon: 'waterpump' });
        // ... and turning it into a plain junction takes the valve's symbol away again
        const junction = paletteOf('water').find(entry => entry.id === 'bus')!;
        assert.deepEqual(paletteChange(valve, junction, 'water'), { kind: 'bus', icon: undefined });
        // ... while a symbol of the user's own survives the change
        const tank = paletteOf('water').find(entry => entry.id === 'storage')!;
        assert.deepEqual(paletteChange({ ...valve, icon: 'pond' }, tank, 'water'), { kind: 'storage' });
    });

    it('reads a tank without a declared unit as how full it is', () => {
        const tank = (medium: 'water' | 'energy'): string => {
            const config: FlowConfig = {
                v: 1,
                canvas: { w: 300, h: 200 },
                defaults: medium === 'water' ? { medium, unit: 'l/min' } : { unit: 'W' },
                nodes: [{ id: 't', kind: 'storage', x: 150, y: 100, value: { oid: 'level' } }],
                edges: [],
            };
            return computeRuntime(config, createValueGetter({ level: 62 }), {
                ...LIGHT_THEME,
                locale: 'en-US',
            }).nodes[0].valueText.text.replace(/\u00a0/g, ' ');
        };
        assert.equal(tank('water'), '62 %');
        // A battery is not a percentage: its number is the power it gives or takes
        assert.equal(tank('energy'), '62 W');
    });

    it('offers one for every medium', () => {
        for (const medium of MEDIUM_IDS) {
            assert.ok(
                PRESETS.some(info => info.medium === medium),
                `no template for ${medium}`,
            );
        }
    });
});

describe('import from energiefluss-erweitert', () => {
    /** The layout that adapter ships as its default -- the one document of that format everybody has */
    const DEFAULT_DOC = JSON.parse(
        readFileSync(new URL('./fixtures/energiefluss-default.json', import.meta.url), 'utf8'),
    ) as unknown;

    it('recognises the format, and does not claim anything else', () => {
        assert.equal(isEnergiefluss(DEFAULT_DOC), true);
        // Our own documents must not be mistaken for it, or a paste would convert into nothing
        assert.equal(isEnergiefluss(buildPreset('pv-battery-home', key => key)), false);
        assert.equal(isEnergiefluss({ elements: {} }), false, 'elements alone is too generic to claim');
        assert.equal(isEnergiefluss(null), false);
        assert.equal(isEnergiefluss('{}'), false);
        assert.equal(isEnergiefluss([]), false);
    });

    it('rebuilds the nodes from the connection keys and the boxes', () => {
        const { config, stats } = importEnergiefluss(DEFAULT_DOC);

        // Production, consumption, battery, grid, car -- and the 17 texts and icons folded into them
        assert.equal(stats.nodes, 5);
        assert.equal(stats.edges, 5);
        assert.equal(stats.merged, 17);

        const byId = Object.fromEntries(config.nodes.map(node => [node.id, node]));
        assert.equal(byId.n5.label, 'Produktion');
        assert.equal(byId.n7.label, 'Verbrauch');
        assert.equal(byId.n13.label, 'Batterie');
        assert.equal(byId.n14.label, 'Netz');
        assert.equal(byId.n22.label, 'Auto');
    });

    it('guesses the kind from the icon and the label', () => {
        const byId = Object.fromEntries(importEnergiefluss(DEFAULT_DOC).config.nodes.map(n => [n.id, n]));
        assert.equal(byId.n5.kind, 'source');
        assert.equal(byId.n13.kind, 'storage');
        assert.equal(byId.n14.kind, 'grid');
        assert.equal(byId.n7.kind, 'sink');
    });

    it('matches icons by keyword, not by exact name', () => {
        const byId = Object.fromEntries(importEnergiefluss(DEFAULT_DOC).config.nodes.map(n => [n.id, n]));
        // mdi:solar-panel, mdi:house-city, mdi:battery-high, mdi:electricity-from-grid and
        // material-symbols:electric-car -- not one of which is a name this set knows
        assert.equal(byId.n5.icon, 'solar');
        assert.equal(byId.n7.icon, 'house');
        assert.equal(byId.n13.icon, 'battery');
        assert.equal(byId.n14.icon, 'grid');
        assert.equal(byId.n22.icon, 'car');
    });

    it('matches a bare icon name, not only a compound one', () => {
        // A regression guard: the patterns used word boundaries once, and a mangled escape turned
        // them into control characters, so `mdi:car` matched nothing while `electric-car` still did
        const iconOf = (icon: string): string | undefined => {
            const document = {
                elements: {
                    1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 },
                    2: { type: 'icon', pos_x: 50, pos_y: 50, icon },
                },
                defs: {},
            };
            return importEnergiefluss(document).config.nodes[0].icon;
        };

        assert.equal(iconOf('mdi:car'), 'car');
        assert.equal(iconOf('mdi:car-electric'), 'car');
        assert.equal(iconOf('material-symbols:electric-car'), 'car');
        assert.equal(iconOf('mdi:gas'), 'flame');
        assert.equal(iconOf('mdi:nas'), 'server');
        // And something that merely contains the letters must not match
        assert.equal(iconOf('mdi:carpet'), undefined);
    });

    it('keeps the geometry, converting the corner to a centre', () => {
        const byId = Object.fromEntries(importEnergiefluss(DEFAULT_DOC).config.nodes.map(n => [n.id, n]));
        // The source stores the top-left corner (167, 2) with a size of 100 x 100
        assert.equal(byId.n5.x, 217);
        assert.equal(byId.n5.y, 52);
        assert.equal(byId.n5.w, 100);
        assert.equal(byId.n5.h, 100);
        assert.equal(byId.n5.shape, 'rounded');
    });

    it('reads the direction of a connection out of its key', () => {
        const { config } = importEnergiefluss(DEFAULT_DOC);
        const edge = config.edges.find(item => item.id === 'e5_7')!;
        assert.equal(edge.from, 'n5');
        assert.equal(edge.to, 'n7');
        assert.equal(edge.fromSide, 'bottom', 'bottom_right keeps only the axis');
        assert.equal(edge.toSide, 'top');
        assert.equal(edge.curve, 'orthogonal');
    });

    it('produces a diagram that renders', () => {
        const { config } = importEnergiefluss(DEFAULT_DOC);
        const runtime = computeRuntime(config, () => null, LIGHT_THEME);
        assert.equal(runtime.edges.length, config.edges.length);
        assert.ok(runtime.nodes.every(node => !node.valueText.text.includes('NaN')));
        for (const node of config.nodes) {
            if (node.icon) {
                assert.ok(BUILTIN_ICONS[node.icon], `unknown icon "${node.icon}"`);
            }
        }
    });

    it('turns the datasource indices into state ids', () => {
        const document = {
            basic: { width: 400, height: 300 },
            datasources: { 0: { source: 'pv.0.power' }, 1: { source: 'grid.0.power' } },
            elements: {
                1: { type: 'rect', pos_x: 10, pos_y: 10, width: 100, height: 100, rx: 10, color: 'rgb(1,2,3)' },
                2: { type: 'rect', pos_x: 250, pos_y: 10, width: 100, height: 100, rx: 10 },
                3: {
                    type: 'text',
                    subType: 'datasource',
                    pos_x: 60,
                    pos_y: 60,
                    source: 0,
                    unit: 'W',
                    decimal_places: 1,
                    calculate_kw: 'auto',
                },
            },
            defs: { path_1_2: { id: 'path_1_2', startSlot: 'right', endSlot: 'left' } },
            animations: { anim_path_1_2: { source: 1, threshold: 5, animation_properties: 'positive' } },
            lines: { line_path_1_2: { color: '#abcdef' } },
        };

        const { config, stats } = importEnergiefluss(document);
        assert.equal(stats.bindings, 2);

        const node = config.nodes.find(item => item.id === 'n1')!;
        assert.deepEqual(node.value, { oid: 'pv.0.power' });
        // calculate_kw 'auto' is exactly this widget's automatic scaling. The unit is left to the state
        // object (the original assumed watts; the imported diagram's default is W for objects without one)
        assert.equal(node.unit, undefined);
        assert.equal(node.autoScale, undefined);
        assert.equal(config.defaults?.unit, 'W');
        assert.equal(node.decimals, 1);
        assert.equal(node.color, 'rgb(1,2,3)');

        const edge = config.edges[0];
        assert.deepEqual(edge.value, { oid: 'grid.0.power' });
        assert.equal(edge.threshold, 5);
        assert.equal(config.canvas.w, 400);
        assert.equal(config.canvas.h, 300);
    });

    it('turns add, subtract and convert into one formula', () => {
        const document = {
            datasources: { 0: { source: 'a' }, 1: { source: 'b' }, 2: { source: 'c' } },
            elements: {
                1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 },
                2: {
                    type: 'text',
                    subType: 'datasource',
                    pos_x: 50,
                    pos_y: 50,
                    source: 0,
                    add: [1],
                    subtract: [2],
                    convert: true,
                    calculate_kw: 'auto',
                },
            },
            defs: {},
        };
        const node = importEnergiefluss(document).config.nodes[0];
        const value = node.value as { expr: string; vars: Record<string, { oid: string }> };
        assert.equal(value.expr, 'abs(a + b0 - c1)');
        assert.deepEqual(
            Object.values(value.vars).map(item => item.oid),
            ['a', 'b', 'c'],
        );

        // And the formula has to be one this widget can actually evaluate
        const runtime = computeRuntime(
            importEnergiefluss(document).config,
            createValueGetter({ a: 100, b: 50, c: 400 }),
            LIGHT_THEME,
        );
        assert.equal(runtime.nodes[0].value, 250);
    });

    it('divides by 1000 where the original does, instead of auto-scaling', () => {
        const document = {
            datasources: { 0: { source: 'a' } },
            elements: {
                1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 },
                2: { type: 'text', subType: 'datasource', pos_x: 50, pos_y: 50, source: 0, calculate_kw: 'calc' },
            },
            defs: {},
        };
        const config = importEnergiefluss(document).config;
        assert.deepEqual(config.nodes[0].value, { oid: 'a', factor: 0.001 });
        assert.equal(config.nodes[0].unit, 'kW');
        assert.equal(config.nodes[0].autoScale, false);

        // 8734 W stays 8.73 kW rather than being scaled again
        const runtime = computeRuntime(
            config,
            createValueGetter({ a: 8734 }),
            createTheme('light', { locale: 'en-US' }),
        );
        assert.equal(runtime.nodes[0].valueText.text, '8.73 kW');
    });

    it('inverts a connection that animates on negative values', () => {
        const document = {
            datasources: { 0: { source: 'a' } },
            elements: {
                1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 },
                2: { type: 'rect', pos_x: 200, pos_y: 0, width: 100, height: 100 },
            },
            defs: { path_1_2: { id: 'path_1_2' } },
            animations: { anim_path_1_2: { source: 0, animation_properties: 'negative' } },
        };
        const edge = importEnergiefluss(document).config.edges[0];
        assert.deepEqual(edge.value, { oid: 'a', invert: true });

        const runtime = computeRuntime(
            importEnergiefluss(document).config,
            createValueGetter({ a: -500 }),
            LIGHT_THEME,
        );
        // A reading of -500 flows from the first element to the second, as it did before
        assert.equal(runtime.edges[0].direction, 1);
        assert.equal(runtime.edges[0].magnitude, 500);
    });

    it('reports what it could not carry over instead of dropping it silently', () => {
        const { warnings } = importEnergiefluss(DEFAULT_DOC);
        // Every value element of the default has calculate_kw 'none', which blanks its unit over there
        assert.ok(warnings.some(item => item.code === 'unit-blanked'));
        // ...but not here: an empty unit would hide the unit of the state object
        const { config } = importEnergiefluss(DEFAULT_DOC);
        assert.ok(config.nodes.every(node => node.unit !== ''));
        assert.ok(
            warnings.every(item => item.detail.length > 10),
            'a warning has to say something actionable',
        );
    });

    it('has a sentence in the dictionary for every kind of warning', () => {
        const dictionaries = {
            en: JSON.parse(readFileSync(new URL('../packages/translations/src/en.json', import.meta.url), 'utf8')),
            de: JSON.parse(readFileSync(new URL('../packages/translations/src/de.json', import.meta.url), 'utf8')),
        } as Record<string, Record<string, string>>;
        // The codes are a type, so they are read from the source: a new code without a sentence
        // would otherwise show up in the designer as its bare dictionary key
        const source = readFileSync(new URL('../packages/core/src/importEnergiefluss.ts', import.meta.url), 'utf8');
        const union = source.slice(source.indexOf('export type ImportWarningCode ='));
        const codes = [...union.slice(0, union.indexOf(';')).matchAll(/\| '([a-z-]+)'/g)].map(match => match[1]);
        assert.ok(codes.length >= 8, `found only ${codes.length} codes`);

        const broken = importEnergiefluss({
            elements: { 1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 } },
            defs: { path_1_9: { id: 'path_1_9' }, broken: { id: 'broken' } },
        });
        const produced = [...importEnergiefluss(DEFAULT_DOC).warnings, ...broken.warnings];

        for (const [lang, words] of Object.entries(dictionaries)) {
            for (const code of codes) {
                const sentence = words[`json_ef_warn_${code.replace(/-/g, '_')}`];
                assert.ok(sentence, `${lang}: no sentence for ${code}`);
            }
            // Each placeholder of the sentence is filled by one of the warning's values
            for (const warning of produced) {
                const sentence = words[`json_ef_warn_${warning.code.replace(/-/g, '_')}`];
                assert.equal(sentence.split('%s').length - 1, warning.args.length, `${lang}: ${warning.code}`);
            }
        }
    });

    it('takes over "show timestamp of last change / update"', () => {
        const document = {
            elements: {
                1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 },
                2: {
                    type: 'text',
                    subType: 'datasource',
                    pos_x: 50,
                    pos_y: 50,
                    source: 0,
                    source_option_lc: 'relative',
                },
                3: { type: 'rect', pos_x: 300, pos_y: 0, width: 100, height: 100 },
                4: {
                    type: 'text',
                    subType: 'datasource',
                    pos_x: 350,
                    pos_y: 50,
                    source: 1,
                    source_option: 'timestamp_de_short',
                },
            },
            datasources: { 0: { source: 'a.b' }, 1: { source: 'c.d' } },
            defs: { path_1_3: { id: 'path_1_3' } },
        };
        const byId = Object.fromEntries(importEnergiefluss(document).config.nodes.map(node => [node.id, node]));
        assert.equal(byId.n1.timestamp, 'lc');
        assert.equal(byId.n1.timestampFormat, undefined, 'relative is the default');
        assert.equal(byId.n3.timestamp, 'ts');
        assert.equal(byId.n3.timestampFormat, 'datetime');
    });

    it('drops a connection to an element that no longer exists, and says so', () => {
        const document = {
            elements: { 1: { type: 'rect', pos_x: 0, pos_y: 0, width: 100, height: 100 } },
            defs: { path_1_9: { id: 'path_1_9' }, broken: { id: 'broken' } },
        };
        const { config, warnings } = importEnergiefluss(document);
        assert.equal(config.edges.length, 0);
        assert.equal(warnings.filter(item => item.code === 'edge-dropped').length, 2);
    });

    it('survives an empty or nonsensical document', () => {
        for (const input of [undefined, null, {}, { elements: {} }, 42, 'nope']) {
            const { config } = importEnergiefluss(input);
            assert.deepEqual(config.nodes, []);
            assert.deepEqual(config.edges, []);
            assert.ok(config.canvas.w > 0 && config.canvas.h > 0);
        }
    });
});

describe('stored diagrams', () => {
    it('makes a readable id out of a name', () => {
        assert.equal(slugify('Meine Anlage (Süd)'), 'meine_anlage_sued');
        assert.equal(slugify('Größe & Maß'), 'groesse_mass');
        assert.equal(slugify('  PV -- Dach  '), 'pv_dach');
        // Accents other than the German umlauts go through the decomposition: é is e plus a
        // combining mark, and the mark is what gets stripped
        assert.equal(slugify('Café Élan'), 'cafe_elan');
        // Something has to come out even when nothing usable goes in
        assert.equal(slugify('???'), 'diagram');
        assert.equal(slugify(''), 'diagram');
    });

    it('numbers an id that is taken instead of overwriting it', () => {
        assert.equal(newDiagramId('PV', []), 'flow.0.diagrams.pv');
        assert.equal(newDiagramId('PV', ['flow.0.diagrams.pv']), 'flow.0.diagrams.pv_2');
        assert.equal(newDiagramId('PV', ['flow.0.diagrams.pv', 'flow.0.diagrams.pv_2']), 'flow.0.diagrams.pv_3');
        assert.equal(newDiagramId('PV', [], 1), 'flow.1.diagrams.pv');
    });

    it('only follows references into its own namespace', () => {
        assert.equal(isDiagramId('flow.0.diagrams.pv'), true);
        // A reference must not be able to point at an arbitrary state and have it parsed as a diagram
        assert.equal(isDiagramId('javascript.0.secret'), false);
        assert.equal(isDiagramId('flow.0.diagrams'), false);
        assert.equal(isDiagramId('flow.0.diagrams.pv.extra'), false);
    });

    it('tells a reference from an inline diagram before normalising', () => {
        assert.deepEqual(readDiagramAttribute({ $ref: 'flow.0.diagrams.pv' }), {
            ref: 'flow.0.diagrams.pv',
        });
        // vis-2 may hand the attribute over as text
        assert.deepEqual(readDiagramAttribute('{"$ref":"flow.0.diagrams.pv"}'), {
            ref: 'flow.0.diagrams.pv',
        });

        const inline = readDiagramAttribute(buildPreset('pv-home', key => key));
        assert.ok('config' in inline && inline.config.nodes.length === 3);

        // A reference outside the namespace is not followed; the widget shows an empty diagram
        const foreign = readDiagramAttribute({ $ref: 'javascript.0.secret' });
        assert.ok('config' in foreign && foreign.config.nodes.length === 0);

        const nothing = readDiagramAttribute(undefined);
        assert.ok('config' in nothing && nothing.config.nodes.length === 0);
    });

    it('round-trips a diagram through the native of its object', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const native = diagramNative(config);
        assert.deepEqual(Object.keys(native), ['flow'], 'the document lives under native.flow');
        const parsed = diagramFromNative(native);
        assert.ok(parsed);
        assert.equal(parsed.nodes.length, config.nodes.length);
        assert.equal(parsed.edges.length, config.edges.length);
    });

    it('reads an object that holds nothing usable as no diagram', () => {
        assert.equal(diagramFromNative(null), null);
        assert.equal(diagramFromNative(undefined), null);
        assert.equal(diagramFromNative({}), null, 'an object without our key is not ours');
        assert.equal(diagramFromNative({ flow: '' }), null);
        assert.equal(diagramFromNative({ flow: 'not a document' }), null);
        // A stored diagram that points somewhere else would be a chain; it is refused, not followed
        assert.equal(diagramFromNative({ flow: { $ref: 'flow.0.diagrams.other' } }), null);
    });
});

describe('working the flow out', () => {
    /**
     * The installation this was built for: two tanks, each behind a valve, both on one pump, and a
     * tap behind it. Nothing but the elements is metered -- no state on a single pipe.
     */
    const plant = (): FlowConfig => ({
        v: 1,
        canvas: { w: 900, h: 560 },
        defaults: { medium: 'water', unit: 'l/min', hydraulics: true },
        nodes: [
            { id: 'rear', kind: 'storage', x: 180, y: 80, label: 'Hinten', soc: { oid: 'rear.level' } },
            { id: 'front', kind: 'storage', x: 410, y: 80, label: 'Vorne', soc: { oid: 'front.level' } },
            { id: 'v1', kind: 'bus', icon: 'valve', x: 210, y: 190, value: { oid: 'v1' } },
            { id: 'v2', kind: 'bus', icon: 'valve', x: 380, y: 190, value: { oid: 'v2' } },
            { id: 'pump', kind: 'bus', icon: 'waterpump', x: 300, y: 290, value: { oid: 'pump' } },
            { id: 'tap', kind: 'sink', icon: 'tap', x: 300, y: 430 },
        ],
        edges: [
            { id: 'rear-v1', from: 'rear', to: 'v1', value: { oid: '' } },
            { id: 'front-v2', from: 'front', to: 'v2', value: { oid: '' } },
            { id: 'v1-pump', from: 'v1', to: 'pump', value: { oid: '' } },
            { id: 'v2-pump', from: 'v2', to: 'pump', value: { oid: '' } },
            { id: 'pump-tap', from: 'pump', to: 'tap', value: { oid: '' } },
        ],
    });

    const flowing = (values: Record<string, number>, config = plant()): string[] => {
        const runtime = computeRuntime(config, createValueGetter(values), LIGHT_THEME);
        return runtime.edges
            .filter(edge => edge.active)
            .map(edge => edge.edge.id)
            .sort();
    };

    it('lets nothing flow while the valves are shut and the pump stands', () => {
        assert.deepEqual(flowing({ 'rear.level': 73, 'front.level': 0, v1: 0, v2: 0, pump: 0 }), []);
    });

    it('opens exactly the branch whose valve is open and whose tank has something', () => {
        // The rear tank is full, its valve open, the pump runs: that strand carries, the other does not
        assert.deepEqual(flowing({ 'rear.level': 73, 'front.level': 0, v1: 1, v2: 0, pump: 0.4 }), [
            'pump-tap',
            'rear-v1',
            'v1-pump',
        ]);
        // Both valves open, but the front tank is empty: it still gives nothing
        assert.deepEqual(flowing({ 'rear.level': 73, 'front.level': 0, v1: 1, v2: 1, pump: 0.4 }), [
            'pump-tap',
            'rear-v1',
            'v1-pump',
        ]);
        // ... and with something in it, both feed the pump
        assert.deepEqual(flowing({ 'rear.level': 73, 'front.level': 20, v1: 1, v2: 1, pump: 0.4 }), [
            'front-v2',
            'pump-tap',
            'rear-v1',
            'v1-pump',
            'v2-pump',
        ]);
    });

    it('stops everything when the pump stands, even with the valves open', () => {
        const values = { 'rear.level': 73, 'front.level': 20, v1: 1, v2: 1, pump: 0 };
        assert.deepEqual(flowing(values), []);
        // And it says so: a line the model worked out as still carries zero, not a placeholder --
        // the same answer a dead pipe in a ring gives
        const runtime = computeRuntime(plant(), createValueGetter(values), { ...LIGHT_THEME, locale: 'en-US' });
        const line = runtime.edges.find(edge => edge.edge.id === 'pump-tap')!;
        assert.equal(line.value, 0);
        assert.equal(line.valueText.text.replace(/\u00a0/g, ' '), '0.00 l/min');
    });

    it('takes the amount from what measures it, and flows without one', () => {
        const values = { 'rear.level': 73, 'front.level': 0, v1: 1, v2: 0, pump: 0.4 };
        const runtime = computeRuntime(plant(), createValueGetter(values), { ...LIGHT_THEME, locale: 'en-US' });
        const line = runtime.edges.find(edge => edge.edge.id === 'pump-tap')!;
        // A pump that reports amperes says "it runs", not "how much": the line flows without a number
        assert.equal(line.active, true);
        assert.equal(line.value, null);
        assert.equal(line.valueText.text, '--');
        // ... and it still moves, at the reference speed: without a number there is none to derive,
        // and a line that is alive but stands still is the one thing this must not look like
        assert.equal(line.dotDuration, DEFAULT_ANIMATION.refDuration);

        // With a flow sensor in the strand every line of it carries what the sensor reads
        const metered = plant();
        metered.nodes.push({ id: 'fs', kind: 'bus', icon: 'flowsensor', x: 300, y: 360, value: { oid: 'fs' } });
        metered.edges = [
            ...metered.edges.filter(edge => edge.id !== 'pump-tap'),
            { id: 'pump-fs', from: 'pump', to: 'fs', value: { oid: '' } },
            { id: 'fs-tap', from: 'fs', to: 'tap', value: { oid: '' } },
        ];
        const withSensor = computeRuntime(metered, createValueGetter({ ...values, fs: 8 }), {
            ...LIGHT_THEME,
            locale: 'en-US',
        });
        const measured = withSensor.edges.find(edge => edge.edge.id === 'fs-tap')!;
        assert.equal(measured.value, 8);
        assert.equal(measured.valueText.text.replace(/\u00a0/g, ' '), '8.00 l/min');
        // ... including the one before the sensor: a chain carries the same everywhere
        assert.equal(withSensor.edges.find(edge => edge.edge.id === 'rear-v1')?.value, 8);
    });

    it('leaves a line that has a reading of its own alone, and every other diagram untouched', () => {
        const metered = plant();
        metered.edges = metered.edges.map(edge => (edge.id === 'pump-tap' ? { ...edge, value: { oid: 'own' } } : edge));
        const runtime = computeRuntime(
            metered,
            createValueGetter({ 'rear.level': 73, 'front.level': 0, v1: 1, v2: 0, pump: 0.4, own: 3 }),
            LIGHT_THEME,
        );
        assert.equal(runtime.edges.find(edge => edge.edge.id === 'pump-tap')?.value, 3);

        // Without the switch nothing is worked out: every diagram written so far draws as it did
        const off = plant();
        off.defaults = { ...off.defaults, hydraulics: false };
        assert.deepEqual(flowing({ 'rear.level': 73, 'front.level': 0, v1: 1, v2: 0, pump: 0.4 }, off), []);
    });

    it('divides what runs at a branch', () => {
        /** One tank, a pump, and two taps behind it */
        const forked = (a?: string, b?: string): FlowConfig => ({
            v: 1,
            canvas: { w: 900, h: 560 },
            defaults: { medium: 'water', unit: 'l/min', hydraulics: true },
            nodes: [
                { id: 'tank', kind: 'storage', x: 300, y: 80, soc: { oid: 'level' } },
                { id: 'pump', kind: 'bus', icon: 'waterpump', x: 300, y: 200, value: { oid: 'pump' } },
                { id: 'bath', kind: 'sink', x: 180, y: 380, value: a ? { oid: a } : undefined },
                { id: 'garden', kind: 'sink', x: 420, y: 380, value: b ? { oid: b } : undefined },
            ],
            edges: [
                { id: 'tank-pump', from: 'tank', to: 'pump', value: { oid: '' } },
                { id: 'pump-bath', from: 'pump', to: 'bath', value: { oid: '' } },
                { id: 'pump-garden', from: 'pump', to: 'garden', value: { oid: '' } },
            ],
        });

        const amounts = (config: FlowConfig, values: Record<string, number>): Record<string, number | null> => {
            const runtime = computeRuntime(config, createValueGetter(values), LIGHT_THEME);
            return Object.fromEntries(runtime.edges.map(edge => [edge.edge.id, edge.value]));
        };

        // Every taker reads its own use: the branches carry those, the trunk their sum
        assert.deepEqual(amounts(forked('bath', 'garden'), { level: 70, pump: 1, bath: 3, garden: 5 }), {
            'tank-pump': 8,
            'pump-bath': 3,
            'pump-garden': 5,
        });

        // Nobody reads anything, but a flow sensor sits in the trunk: equal parts behind it
        const metered = forked();
        metered.nodes.push({ id: 'fs', kind: 'bus', icon: 'flowsensor', x: 300, y: 140, value: { oid: 'fs' } });
        metered.edges = [
            { id: 'tank-fs', from: 'tank', to: 'fs', value: { oid: '' } },
            { id: 'fs-pump', from: 'fs', to: 'pump', value: { oid: '' } },
            ...metered.edges.filter(edge => edge.id !== 'tank-pump'),
        ];
        assert.deepEqual(amounts(metered, { level: 70, pump: 1, fs: 8 }), {
            'tank-fs': 8,
            'fs-pump': 8,
            'pump-bath': 4,
            'pump-garden': 4,
        });

        // A sensor in one branch measures that branch, and the rest follows from it
        const branchMetered = forked();
        branchMetered.nodes.push({ id: 'fs', kind: 'bus', icon: 'flowsensor', x: 180, y: 300, value: { oid: 'fs' } });
        branchMetered.edges = [
            ...branchMetered.edges.filter(edge => edge.id !== 'pump-bath'),
            { id: 'pump-fs', from: 'pump', to: 'fs', value: { oid: '' } },
            { id: 'fs-bath', from: 'fs', to: 'bath', value: { oid: '' } },
        ];
        assert.deepEqual(amounts(branchMetered, { level: 70, pump: 1, fs: 3 }), {
            'tank-pump': 6,
            'pump-garden': 3,
            'pump-fs': 3,
            'fs-bath': 3,
        });
    });

    it('divides what two tanks send to one tap', () => {
        const config = plant();
        // The tap reads its own use; both tanks are open and full
        config.nodes = config.nodes.map(node => (node.id === 'tap' ? { ...node, value: { oid: 'tap' } } : node));
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'rear.level': 73, 'front.level': 40, v1: 1, v2: 1, pump: 0.4, tap: 8 }),
            LIGHT_THEME,
        );
        const amount = (id: string): number | null => runtime.edges.find(edge => edge.edge.id === id)?.value ?? null;
        // Half through each tank's strand, the whole of it after the pump
        assert.equal(amount('rear-v1'), 4);
        assert.equal(amount('v1-pump'), 4);
        assert.equal(amount('front-v2'), 4);
        assert.equal(amount('v2-pump'), 4);
        assert.equal(amount('pump-tap'), 8);
    });

    it('gives a half open valve half as much as the open one beside it', () => {
        const config = plant();
        // The valves report a percentage, as a valve with a position does
        config.nodes = config.nodes.map(node =>
            node.id === 'v1' || node.id === 'v2'
                ? { ...node, unit: '%' }
                : node.id === 'tap'
                  ? { ...node, value: { oid: 'tap' } }
                  : node,
        );
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'rear.level': 73, 'front.level': 40, v1: 50, v2: 100, pump: 0.4, tap: 9 }),
            LIGHT_THEME,
        );
        const amount = (id: string): number | null => runtime.edges.find(edge => edge.edge.id === id)?.value ?? null;
        // Half a turn against a whole one: one part against two
        assert.equal(amount('rear-v1'), 3);
        assert.equal(amount('v1-pump'), 3);
        assert.equal(amount('front-v2'), 6);
        assert.equal(amount('v2-pump'), 6);
        assert.equal(amount('pump-tap'), 9);
    });

    it('divides between two consumers by how far their valves are open', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 900, h: 560 },
            defaults: { medium: 'water', unit: 'l/min', hydraulics: true },
            nodes: [
                { id: 'mains', kind: 'grid', x: 300, y: 60 },
                { id: 'fs', kind: 'bus', icon: 'flowsensor', x: 300, y: 160, value: { oid: 'fs' } },
                { id: 'vb', kind: 'bus', icon: 'valve', x: 180, y: 280, value: { oid: 'vb' }, unit: '%' },
                { id: 'vg', kind: 'bus', icon: 'valve', x: 420, y: 280, value: { oid: 'vg' }, unit: '%' },
                { id: 'bath', kind: 'sink', x: 180, y: 420 },
                { id: 'garden', kind: 'sink', x: 420, y: 420 },
            ],
            edges: [
                { id: 'mains-fs', from: 'mains', to: 'fs', value: { oid: '' } },
                { id: 'fs-vb', from: 'fs', to: 'vb', value: { oid: '' } },
                { id: 'fs-vg', from: 'fs', to: 'vg', value: { oid: '' } },
                { id: 'vb-bath', from: 'vb', to: 'bath', value: { oid: '' } },
                { id: 'vg-garden', from: 'vg', to: 'garden', value: { oid: '' } },
            ],
        };
        const runtime = computeRuntime(config, createValueGetter({ fs: 9, vb: 50, vg: 100 }), LIGHT_THEME);
        const amount = (id: string): number | null => runtime.edges.find(edge => edge.edge.id === id)?.value ?? null;
        assert.equal(amount('mains-fs'), 9);
        assert.equal(amount('vb-bath'), 3);
        assert.equal(amount('vg-garden'), 6);
        // Shut is shut, and then the other one takes everything the sensor reads
        const closed = computeRuntime(config, createValueGetter({ fs: 9, vb: 0, vg: 100 }), LIGHT_THEME);
        const shut = (id: string): number | null => closed.edges.find(edge => edge.edge.id === id)?.value ?? null;
        assert.equal(closed.edges.find(edge => edge.edge.id === 'vb-bath')?.active, false);
        assert.equal(shut('vg-garden'), 9);
    });

    it('sends half of a ring each way, and lets the two halves of a ring with two givers meet', () => {
        const amounts = (config: FlowConfig, values: Record<string, number>): Record<string, number | null> => {
            const runtime = computeRuntime(config, createValueGetter(values), LIGHT_THEME);
            return Object.fromEntries(runtime.edges.map(edge => [edge.edge.id, edge.value]));
        };

        // A ring off one house connection, with the tap on the far side: both ways carry half
        const ring: FlowConfig = {
            v: 1,
            canvas: { w: 900, h: 560 },
            defaults: { medium: 'water', unit: 'l/min', hydraulics: true },
            nodes: [
                { id: 'mains', kind: 'grid', x: 300, y: 60 },
                { id: 'west', kind: 'bus', x: 120, y: 260 },
                { id: 'east', kind: 'bus', x: 480, y: 260 },
                { id: 'tap', kind: 'sink', x: 300, y: 460, value: { oid: 'tap' } },
            ],
            edges: [
                { id: 'mains-west', from: 'mains', to: 'west', value: { oid: '' } },
                { id: 'west-tap', from: 'west', to: 'tap', value: { oid: '' } },
                { id: 'mains-east', from: 'mains', to: 'east', value: { oid: '' } },
                { id: 'east-tap', from: 'east', to: 'tap', value: { oid: '' } },
            ],
        };
        assert.deepEqual(amounts(ring, { tap: 10 }), {
            'mains-west': 5,
            'west-tap': 5,
            'mains-east': 5,
            'east-tap': 5,
        });

        // Two house connections on one ring, the tap between them: each feeds its own side, and the
        // pipe on the far side carries nothing -- that is where the two flows meet
        const twoEnds: FlowConfig = {
            v: 1,
            canvas: { w: 900, h: 560 },
            defaults: { medium: 'water', unit: 'l/min', hydraulics: true },
            nodes: [
                { id: 'westMains', kind: 'grid', x: 120, y: 120 },
                { id: 'eastMains', kind: 'grid', x: 480, y: 120 },
                { id: 'far', kind: 'bus', x: 300, y: 60 },
                { id: 'tap', kind: 'sink', x: 300, y: 420, value: { oid: 'tap' } },
            ],
            edges: [
                { id: 'west-tap', from: 'westMains', to: 'tap', value: { oid: '' } },
                { id: 'east-tap', from: 'eastMains', to: 'tap', value: { oid: '' } },
                { id: 'west-far', from: 'westMains', to: 'far', value: { oid: '' } },
                { id: 'far-east', from: 'far', to: 'eastMains', value: { oid: '' } },
            ],
        };
        const flows = amounts(twoEnds, { tap: 12 });
        assert.equal(flows['west-tap'], 6);
        assert.equal(flows['east-tap'], 6);
        // What cancels out carries nothing, and says so: zero rather than a placeholder
        assert.equal(flows['west-far'], 0);
        assert.equal(flows['far-east'], 0);
        const runtime = computeRuntime(twoEnds, createValueGetter({ tap: 12 }), LIGHT_THEME);
        assert.equal(runtime.edges.find(edge => edge.edge.id === 'west-far')?.active, false);
    });

    it('reads the role of an element from what it is, and lets it be overruled', () => {
        assert.equal(defaultRole({ id: 'a', kind: 'grid', x: 0, y: 0 }), 'supply');
        assert.equal(defaultRole({ id: 'a', kind: 'storage', x: 0, y: 0 }), 'store');
        assert.equal(defaultRole({ id: 'a', kind: 'sink', x: 0, y: 0 }), 'demand');
        assert.equal(defaultRole({ id: 'a', kind: 'bus', x: 0, y: 0 }), 'pass');
        assert.equal(defaultRole({ id: 'a', kind: 'bus', icon: 'valve', x: 0, y: 0 }), 'gate');
        assert.equal(defaultRole({ id: 'a', kind: 'bus', icon: 'waterpump', x: 0, y: 0 }), 'driver');
        assert.equal(defaultRole({ id: 'a', kind: 'bus', icon: 'flowsensor', x: 0, y: 0 }), 'meter');
        // A node may say what it is, whatever it looks like
        assert.equal(defaultRole({ id: 'a', kind: 'bus', icon: 'valve', hydraulic: 'pass', x: 0, y: 0 }), 'pass');
    });
});

describe('caption templates', () => {
    const raw: Record<string, unknown> = {
        'userdata.0.hallo': 'Welt',
        'meter.0.total': 4711.5,
        'switch.0.on': true,
    };
    const times: Record<string, { ts?: number; lc?: number }> = {
        'userdata.0.hallo': { ts: 1_700_000_000_000, lc: 1_699_999_000_000 },
    };
    const context = {
        own: 'meter.0.total',
        raw: (oid: string) => raw[oid],
        times: (oid: string) => times[oid],
        units: (oid: string) => (oid === 'meter.0.total' ? 'kWh' : undefined),
        locale: 'en-US',
        now: 1_700_000_600_000,
    };

    it('reads its own state without naming it, and any other one by name', () => {
        assert.equal(renderTemplate('{{ val }} {{ unit }}', context), '4,711.5 kWh');
        assert.equal(renderTemplate('Gruss: {{ userdata.0.hallo.val }}', context), 'Gruss: Welt');
        // Without a field the whole placeholder is a state, and what is wanted is its value
        assert.equal(renderTemplate('{{ userdata.0.hallo }}', context), 'Welt');
        assert.equal(renderTemplate('{{switch.0.on}}', context), 'true');
    });

    it('shows a time as how long ago it was, and as a date when asked', () => {
        assert.equal(renderTemplate('{{ userdata.0.hallo.ts }}', context), '10 minutes ago');
        assert.equal(renderTemplate('{{ userdata.0.hallo.lc }}', context), '27 minutes ago');
        // A short date and time, not "10 minutes ago"
        const absolute = renderTemplate('{{ userdata.0.hallo.ts_abs }}', context);
        assert.match(absolute, /\d+\/\d+\/\d+/);
        assert.ok(absolute.includes(':'));
        // A state nobody has written leaves the text around it alone
        assert.equal(renderTemplate('[{{ meter.0.total.ts }}]', context), '[]');
        assert.equal(renderTemplate('[{{ nothing.0.here.val }}]', context), '[]');
    });

    it('computes, when the placeholder is a calculation', () => {
        assert.equal(renderTemplate('{{ val * 2 }}', context), '9,423');
        assert.equal(renderTemplate('{{ val + 100 }}', context), '4,811.5');
        // A state of its own, named in the middle of the calculation
        const withOffset = { ...context, raw: (oid: string) => (oid === 'meter.0.offset' ? 10 : raw[oid]) };
        assert.equal(renderTemplate('{{ val + meter.0.offset.val * 10 }}', withOffset), '4,811.5');
        // An id may start with a digit, as `0_userdata` does
        const userdata = { ...context, raw: (oid: string) => (oid === '0_userdata.0.x' ? 7 : undefined) };
        assert.equal(renderTemplate('{{ 0_userdata.0.x.val * 3 }}', userdata), '21');
        // A minus in an id is not a subtraction: without spaces it stays one name
        assert.equal(renderTemplate('{{ hm-rpc.0.thing.val }}', { raw: () => 5 }), '5');
        // A state nobody has written makes the whole calculation empty, as it does in a value source
        assert.equal(renderTemplate('[{{ nothing.0.here.val + 1 }}]', context), '[]');
    });

    it('says which states a caption reads, so they get subscribed', () => {
        assert.deepEqual(templateOids('{{ val }} of {{ userdata.0.hallo.val }}', 'meter.0.total'), [
            'meter.0.total',
            'userdata.0.hallo',
        ]);
        // Every state of a calculation as well, or the widget would not subscribe to it
        assert.deepEqual(templateOids('{{ val + 0_userdata.0.x.val * 10 }}', 'meter.0.total'), [
            'meter.0.total',
            '0_userdata.0.x',
        ]);
        assert.deepEqual(templateOids('nothing here'), []);
        assert.equal(hasTemplate('nothing here'), false);
        assert.equal(hasTemplate('{{ val }}'), true);

        // ... and the widget subscribes to them with everything else the document reads
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                {
                    id: 'caption',
                    kind: 'label',
                    x: 100,
                    y: 100,
                    text: '{{ val }} at {{ userdata.0.hallo.ts }}',
                    value: { oid: 'meter.0.total' },
                },
            ],
            edges: [],
        };
        assert.deepEqual(collectOids(config).sort(), ['meter.0.total', 'userdata.0.hallo']);
    });

    it('draws the filled-in caption, not the template', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                {
                    id: 'caption',
                    kind: 'label',
                    x: 100,
                    y: 100,
                    text: 'Zaehler: {{ val }} {{ unit }}',
                    value: { oid: 'meter.0.total' },
                },
            ],
            edges: [],
        };
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'meter.0.total': 4711.5 }),
            {
                ...LIGHT_THEME,
                locale: 'en-US',
            },
            { raw: (oid: string) => raw[oid], units: (oid: string) => (oid === 'meter.0.total' ? 'kWh' : undefined) },
        );
        assert.equal(runtime.nodes[0].text, 'Zaehler: 4,711.5 kWh');
        // A caption without placeholders is drawn as it was written
        const plain = computeRuntime(
            { ...config, nodes: [{ ...config.nodes[0], text: 'Nur Text' }] },
            () => null,
            LIGHT_THEME,
        );
        assert.equal(plain.nodes[0].text, 'Nur Text');
    });
});

describe('clipboard', () => {
    const t = (key: string): string => key;

    it('copies the nodes and only the connections between them', () => {
        const config = buildPreset('pv-battery-home', t);
        const clipboard = copyNodes(config, ['pv', 'home', 'nope']);
        assert.ok(clipboard);
        assert.equal(clipboard.format, CLIPBOARD_FORMAT);
        assert.deepEqual(
            clipboard.nodes.map(node => node.id),
            ['pv', 'home'],
        );
        // grid-home and battery-home lead out of the set and would dangle in another diagram
        assert.deepEqual(
            clipboard.edges.map(edge => edge.id),
            ['pv-home'],
        );
        // A copy, not the same objects: editing the diagram afterwards must not change the clipboard
        assert.notEqual(clipboard.nodes[0], config.nodes[0]);
        assert.equal(copyNodes(config, ['nope']), null);
    });

    it('pastes next to the original under a new id, and further away each time', () => {
        const config = buildPreset('pv-battery-home', t);
        const clipboard = copyNodes(config, ['pv'])!;

        const once = pasteNodes(config, clipboard);
        assert.deepEqual(once.ids, ['pv-2']);
        const first = once.config.nodes.find(node => node.id === 'pv-2')!;
        // One step of at least 20 units, on the grid of 10
        assert.deepEqual([first.x, first.y], [470, 120]);

        const twice = pasteNodes(once.config, clipboard);
        const second = twice.config.nodes.find(node => node.id === twice.ids[0])!;
        assert.equal(twice.ids[0], 'pv-3');
        assert.deepEqual([second.x, second.y], [490, 140]);
    });

    it('renames the connections along with the nodes they join', () => {
        const config = buildPreset('pv-battery-home', t);
        const { config: pasted, ids } = pasteNodes(config, copyNodes(config, ['pv', 'home'])!);
        assert.deepEqual(ids, ['pv-2', 'home-2']);
        const edge = pasted.edges[pasted.edges.length - 1];
        assert.deepEqual([edge.id, edge.from, edge.to], ['pv-2-home-2', 'pv-2', 'home-2']);
        assert.equal(pasted.edges.length, config.edges.length + 1);
    });

    it('keeps ids that are free in the target diagram, and keeps the group inside its canvas', () => {
        const source = buildPreset('pv-battery-home', t);
        const clipboard = copyNodes(source, ['battery'])!;
        // An empty, smaller diagram: the battery at x 760 would land outside a 400 wide canvas
        const target: FlowConfig = { v: 1, canvas: { w: 400, h: 300, grid: 10 }, nodes: [], edges: [] };
        const { config, ids } = pasteNodes(target, clipboard);
        assert.deepEqual(ids, ['battery']);
        const node = config.nodes[0];
        assert.ok(node.x <= 400 && node.y <= 300, `${node.x},${node.y} is outside the canvas`);
    });

    it('reads only its own format from the clipboard', () => {
        const config = buildPreset('pv-battery-home', t);
        const text = JSON.stringify(copyNodes(config, ['pv', 'home']));
        const read = parseClipboard(text);
        assert.ok(read);
        assert.equal(read.nodes.length, 2);
        assert.equal(read.edges.length, 1);

        assert.equal(parseClipboard('hello'), null);
        assert.equal(parseClipboard(JSON.stringify(config)), null, 'a whole diagram is not a set of nodes');
        assert.equal(parseClipboard(JSON.stringify({ format: CLIPBOARD_FORMAT, nodes: [{ label: 'x' }] })), null);
        // A node without a position cannot be placed; the edge to it goes with it
        const partial = parseClipboard(
            JSON.stringify({
                format: CLIPBOARD_FORMAT,
                nodes: [
                    { id: 'a', kind: 'sink', x: 10, y: 10 },
                    { id: 'b', kind: 'sink' },
                ],
                edges: [{ id: 'a-b', from: 'a', to: 'b' }],
            }),
        );
        assert.ok(partial);
        assert.deepEqual(
            partial.nodes.map(node => node.id),
            ['a'],
        );
        assert.equal(partial.edges.length, 0);
    });
});

describe('units from the state objects', () => {
    const units = (map: Record<string, string>) => (oid: string) => map[oid];
    // A fixed locale, so the expected texts do not depend on the machine the tests run on
    const theme = { ...LIGHT_THEME, locale: 'en-US' };

    it('takes the unit of a state, but not through a factor or a product', () => {
        const get = units({ a: 'kW', b: 'kW', c: 'W' });
        assert.equal(sourceUnit({ oid: 'a' }, get), 'kW');
        assert.equal(sourceUnit({ oid: 'a', invert: true, offset: 1 }, get), 'kW');
        // 0.001 turns W into kW -- the object's unit no longer describes the number
        assert.equal(sourceUnit({ oid: 'c', factor: 0.001 }, get), undefined);
        assert.equal(sourceUnit({ expr: 'a - b', vars: { a: { oid: 'a' }, b: { oid: 'b' } } }, get), 'kW');
        assert.equal(sourceUnit({ expr: 'a - c', vars: { a: { oid: 'a' }, c: { oid: 'c' } } }, get), undefined);
        assert.equal(sourceUnit({ expr: 'a * b', vars: { a: { oid: 'a' }, b: { oid: 'b' } } }, get), undefined);
        assert.equal(sourceUnit({ const: 5 }, get), undefined);
        assert.equal(sourceUnit({ oid: 'a' }, undefined), undefined);
    });

    it('reads each object once and remembers objects without a unit', async () => {
        const asked: string[] = [];
        const read = (id: string): Promise<unknown> => {
            asked.push(id);
            return Promise.resolve(id === 'u.power' ? { common: { unit: ' kW ' } } : { common: {} });
        };
        await loadUnits(['u.power', 'u.none'], read);
        await loadUnits(['u.power', 'u.none'], read);
        assert.deepEqual(asked, ['u.power', 'u.none']);
        assert.equal(cachedUnit('u.power'), 'kW');
        assert.equal(cachedUnit('u.none'), undefined);
    });

    it('shows a state in its own unit and lets an explicit unit win', () => {
        const base = buildPreset('pv-home', key => key);
        const config: FlowConfig = {
            ...base,
            nodes: base.nodes.map(node => (node.id === 'pv' ? { ...node, value: { oid: 'pv' } } : node)),
        };
        const get = createValueGetter({ pv: 2.5 });
        const shown = (runtime: ReturnType<typeof computeRuntime>): string =>
            runtime.nodeById.pv.valueText.text.replace(/\u00a0/g, ' ');

        // The diagram says W, the object says kW: the object describes the number
        assert.equal(shown(computeRuntime(config, get, theme, { units: units({ pv: 'kW' }) })), '2.50 kW');
        // Without objects it is the diagram's default, as before
        assert.equal(shown(computeRuntime(config, get, theme)), '3 W');
        // The node's own unit wins over the object
        const explicit = {
            ...config,
            nodes: config.nodes.map(node => (node.id === 'pv' ? { ...node, unit: 'W' } : node)),
        };
        assert.equal(shown(computeRuntime(explicit, get, theme, { units: units({ pv: 'kW' }) })), '3 W');
    });

    it('treats an empty unit as unset, so the object still decides', () => {
        const base = buildPreset('pv-home', key => key);
        // What earlier imports of energiefluss-erweitert wrote for calculate_kw 'none'
        const config: FlowConfig = {
            ...base,
            nodes: base.nodes.map(node => (node.id === 'pv' ? { ...node, value: { oid: 'pv' }, unit: '' } : node)),
        };
        const runtime = computeRuntime(config, createValueGetter({ pv: 124.73 }), theme, { units: units({ pv: 'W' }) });
        assert.equal(runtime.nodeById.pv.valueText.unit, 'W');
    });

    it('compares, animates and sums edges in the base unit', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 600, h: 400 },
            nodes: [
                { id: 'bat', kind: 'storage', x: 100, y: 100 },
                { id: 'pv', kind: 'source', x: 100, y: 300 },
                { id: 'home', kind: 'sink', x: 400, y: 200 },
            ],
            edges: [
                { id: 'b', from: 'bat', to: 'home', value: { oid: 'bat' }, mode: 'positive' },
                { id: 'p', from: 'pv', to: 'home', value: { oid: 'pv' }, mode: 'positive' },
            ],
        };
        const runtime = computeRuntime(config, createValueGetter({ bat: 1.5, pv: 500 }), theme, {
            units: units({ bat: 'kW', pv: 'W' }),
        });
        const battery = runtime.edges.find(edge => edge.edge.id === 'b')!;
        // 1.5 kW is well above the 1 W threshold and animates like 1500 W, not like 1.5 W
        assert.equal(battery.magnitude, 1500);
        assert.equal(battery.baseUnit, 'W');
        assert.equal(battery.active, true);
        assert.equal(battery.valueText.text.replace(/\u00a0/g, ' '), '1.50 kW');
        // The house adds 1500 W and 500 W -- not 1.5 and 500
        assert.equal(runtime.nodeById.home.value, 2000);
        assert.equal(runtime.nodeById.home.valueText.text.replace(/\u00a0/g, ' '), '2.00 kW');
    });
});

describe('last change and last update', () => {
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    const minutes = (count: number): number => now - count * 60000;

    it('writes a time relative to now, in the language of the locale', () => {
        assert.equal(formatTimestamp(minutes(12), 'relative', now, 'de'), 'vor 12 Minuten');
        assert.equal(formatTimestamp(minutes(12), 'relative', now, 'en'), '12 minutes ago');
        assert.equal(formatTimestamp(minutes(180), 'relative', now, 'en'), '3 hours ago');
        assert.equal(formatTimestamp(minutes(2 * 1440), 'relative', now, 'en'), '2 days ago');
        // A client clock a little behind the server must not say "in 3 seconds"
        assert.equal(formatTimestamp(now + 3000, 'relative', now, 'en'), 'now');
    });

    it('writes a clock time or a date in the order of the locale', () => {
        const time = formatTimestamp(minutes(0), 'time', now, 'de');
        assert.match(time, /^\d\d:\d\d$/);
        const date = formatTimestamp(minutes(0), 'datetime', now, 'de');
        assert.match(date, /22\.09\.26/);
    });

    it('shows the most recent change of the states behind a value', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                {
                    id: 'n',
                    kind: 'sink',
                    x: 100,
                    y: 100,
                    value: { expr: 'a + b', vars: { a: { oid: 'a' }, b: { oid: 'b' } } },
                    timestamp: 'lc',
                },
                { id: 'm', kind: 'sink', x: 200, y: 100, value: { oid: 'a' } },
            ],
            edges: [],
        };
        const times = (oid: string): { ts: number; lc: number } =>
            oid === 'a' ? { ts: minutes(1), lc: minutes(30) } : { ts: minutes(2), lc: minutes(12) };
        const theme = { ...LIGHT_THEME, locale: 'de' };
        const runtime = computeRuntime(config, createValueGetter({ a: 1, b: 2 }), theme, { times, now });
        assert.equal(runtime.nodeById.n.timeText, 'vor 12 Minuten');
        // Not asked for: nothing
        assert.equal(runtime.nodeById.m.timeText, null);

        const updated = { ...config, nodes: [{ ...config.nodes[0], timestamp: 'ts' as const }] };
        assert.equal(
            computeRuntime(updated, createValueGetter({}), theme, { times, now }).nodeById.n.timeText,
            'vor 1 Minute',
        );
        // No times delivered yet: no text rather than "56 years ago"
        assert.equal(computeRuntime(config, createValueGetter({}), theme, { now }).nodeById.n.timeText, null);
    });
});

describe('fill levels', () => {
    const t = (key: string): string => key;

    it('takes a charge level from the value, converted on its own', () => {
        // wattcycle's soc_min: the value is the percentage, the charge level is the same number
        assert.equal(
            resolveSrc(
                { same: 'value' },
                () => null,
                () => 98,
            ),
            98,
        );
        assert.equal(
            resolveSrc(
                { same: 'value', factor: 100 },
                () => null,
                () => 0.98,
            ),
            98,
        );
        // Without a value to refer to -- the value itself, or a connection -- it is unknown
        assert.equal(
            resolveSrc({ same: 'value' }, () => null),
            null,
        );

        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                {
                    id: 'bat',
                    kind: 'storage',
                    x: 100,
                    y: 100,
                    unit: '%',
                    value: { oid: 'soc' },
                    soc: { same: 'value' },
                },
            ],
            edges: [],
        };
        const runtime = computeRuntime(config, createValueGetter({ soc: 98 }), LIGHT_THEME);
        assert.equal(runtime.nodes[0].soc, 98);
        assert.equal(runtime.nodes[0].level, 98);
    });

    it('fills any other node against its maximum, by amount', () => {
        const base = buildPreset('pv-battery-home', t);
        const config: FlowConfig = {
            ...base,
            nodes: base.nodes.map(node =>
                node.id === 'pv'
                    ? { ...node, value: { oid: 'pv' }, levelMax: 1400 }
                    : node.id === 'grid'
                      ? { ...node, value: { oid: 'grid' }, levelMax: 1000 }
                      : node,
            ),
        };
        const runtime = computeRuntime(config, createValueGetter({ pv: 75, grid: -2500 }), LIGHT_THEME);
        assert.equal(Math.round(runtime.nodeById.pv.level! * 10) / 10, 5.4);
        // Exporting 2500 W against 1000: full, not negative
        assert.equal(runtime.nodeById.grid.level, 100);
        // No maximum, no charge level: no fill
        assert.equal(runtime.nodeById.home.level, null);
    });

    it('fills against the maximum the state object declares', () => {
        const config = (extra: Partial<FlowNode>): FlowConfig => ({
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [{ id: 'pv', kind: 'source', x: 100, y: 100, value: { oid: 'pv' }, ...extra }],
            edges: [],
        });
        const get = createValueGetter({ pv: 350 });
        const options = { units: () => 'W', maxima: () => 1400 };
        assert.equal(computeRuntime(config({}), get, LIGHT_THEME, options).nodes[0].level, 25);
        // A maximum in the diagram wins; an explicit 0 says "no fill" and is not filled in again
        assert.equal(computeRuntime(config({ levelMax: 700 }), get, LIGHT_THEME, options).nodes[0].level, 50);
        assert.equal(computeRuntime(config({ levelMax: 0 }), get, LIGHT_THEME, options).nodes[0].level, null);
        // A meter in kW declares its maximum in kW, and the value is shown in kW as well
        const inKw = { units: () => 'kW', maxima: () => 14 };
        assert.equal(computeRuntime(config({}), createValueGetter({ pv: 3.5 }), LIGHT_THEME, inKw).nodes[0].level, 25);
        // A factor makes the object's range describe something else
        assert.equal(
            computeRuntime(config({ value: { oid: 'pv', factor: 2 } }), get, LIGHT_THEME, options).nodes[0].level,
            null,
        );
        // A storage fills with its charge, not with what its meter can do
        assert.equal(computeRuntime(config({ kind: 'storage' }), get, LIGHT_THEME, options).nodes[0].level, null);
    });

    it('takes a value in percent as the level of the icon', () => {
        const node = (extra: Partial<FlowNode>): FlowConfig => ({
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [{ id: 'bat', kind: 'storage', x: 100, y: 100, value: { oid: 'soc' }, ...extra }],
            edges: [],
        });
        const get = createValueGetter({ soc: 98, power: -2100 });
        // The charge as the value, with no separate state of charge: the icon must not look empty
        let runtime = computeRuntime(node({ unit: '%' }), get, LIGHT_THEME);
        assert.equal(runtime.nodes[0].iconLevel, 98);
        assert.equal(runtime.nodes[0].level, 98, 'a storage fills its body with it, as with a charge state');
        assert.equal(runtime.nodes[0].soc, null, 'and does not repeat it in the second line');
        // The unit of the state object counts as well
        runtime = computeRuntime(node({}), get, LIGHT_THEME, { units: () => '%' });
        assert.equal(runtime.nodes[0].iconLevel, 98);
        // A power value is no level; a separate state of charge is
        runtime = computeRuntime(node({ value: { oid: 'power' }, unit: 'W' }), get, LIGHT_THEME);
        assert.equal(runtime.nodes[0].iconLevel, null);
        runtime = computeRuntime(node({ value: { oid: 'power' }, unit: 'W', soc: { oid: 'soc' } }), get, LIGHT_THEME);
        assert.equal(runtime.nodes[0].iconLevel, 98);
        // Any other kind: the icon follows, the body only with a maximum
        runtime = computeRuntime(node({ kind: 'sink', unit: '%' }), get, LIGHT_THEME);
        assert.equal(runtime.nodes[0].iconLevel, 98);
        assert.equal(runtime.nodes[0].level, null);
    });

    it('shrinks a value that does not fit its box, and only then', () => {
        // Measured on system-ui: "-1.800,00 W" in bold is about 5.7 font sizes wide
        assert.equal(fitFontSize('900 W', 24, 120, true), 24);
        const size = fitFontSize('-1.800,00 W', 24, 110, true);
        assert.ok(size < 24 && size > 18, `${size}`);
        // Never below half: past that it is unreadable anyway
        assert.equal(fitFontSize('a very long text that cannot possibly fit', 20, 30, false), 10);
        assert.equal(fitFontSize('anything', 20, Infinity, true), 20);
    });

    it('gives every icon a name in both dictionaries', () => {
        const words = {
            en: JSON.parse(
                readFileSync(new URL('../packages/translations/src/en.json', import.meta.url), 'utf8'),
            ) as Record<string, string>,
            de: JSON.parse(
                readFileSync(new URL('../packages/translations/src/de.json', import.meta.url), 'utf8'),
            ) as Record<string, string>,
        };
        for (const [name, icon] of Object.entries(BUILTIN_ICONS)) {
            for (const [lang, dictionary] of Object.entries(words)) {
                assert.ok(dictionary[icon.label], `${lang}: no name for the icon "${name}" (${icon.label})`);
            }
        }
    });

    it('fills the tank icon to its level and leaves the scale where the water is not', () => {
        const markup = (level?: number | null): string =>
            renderToStaticMarkup(
                React.createElement(
                    'svg',
                    null,
                    renderBuiltinIcon('tank', { x: 12, y: 12, size: 24, color: '#000', level }),
                ),
            );
        // Without a level the vessel is empty -- and it is the same vessel, not a second drawing
        assert.equal((markup(undefined).match(/<rect/g) || []).length, 1);
        assert.equal((markup(0).match(/<rect/g) || []).length, 1);
        assert.equal((markup(40).match(/<rect/g) || []).length, 2, 'the vessel and what is in it');
        // The scale is there whatever the level: it belongs to the vessel
        assert.equal((markup(40).match(/<path/g) || []).length, 3);
        // It fills from the bottom: more water starts higher up
        const top = (level: number): number =>
            Number(/<rect x="6.9" y="([\d.]+)"/.exec(markup(level))?.[1] ?? Number.NaN);
        assert.ok(top(25) > top(75), 'a quarter full starts below three quarters full');
    });

    it('fills the heat buffer to its level and keeps its heat lines while it has none', () => {
        const markup = (level?: number | null): string =>
            renderToStaticMarkup(
                React.createElement(
                    'svg',
                    null,
                    renderBuiltinIcon('heatstorage', { x: 12, y: 12, size: 24, color: '#000', level }),
                ),
            );
        // Nothing known: the vessel with the two heat lines, as it always looked
        assert.ok(markup(undefined).includes('q1.6 2 0 4'));
        assert.ok(!markup(60).includes('q1.6 2 0 4'), 'the heat lines give way to what is in it');
        assert.equal((markup(60).match(/<rect/g) || []).length, 2);
        assert.equal((markup(0).match(/<rect/g) || []).length, 1);
    });

    it('draws the battery icon with its charge instead of the fixed bar', () => {
        const markup = (level?: number | null): string =>
            renderToStaticMarkup(
                React.createElement(
                    'svg',
                    null,
                    renderBuiltinIcon('battery', { x: 12, y: 12, size: 24, color: '#000', level }),
                ),
            );
        // Unknown charge: the icon as it always looked
        assert.ok(markup(undefined).includes('M9.5 16.5'));
        const full = markup(98);
        assert.ok(!full.includes('M9.5 16.5'), 'the bar that reads as "almost empty" is gone');
        assert.equal((full.match(/<rect/g) || []).length, 3, 'two outlines and the fill');
        // Empty: the outline only
        assert.equal((markup(0).match(/<rect/g) || []).length, 2);
    });
});

describe('history charts', () => {
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);

    it('asks only for plain states, once per state and period', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                { id: 'a', kind: 'source', x: 0, y: 0, value: { oid: 'pv' }, history: '1h' },
                { id: 'b', kind: 'source', x: 0, y: 0, value: { oid: 'pv' }, history: '1h' },
                { id: 'c', kind: 'source', x: 0, y: 0, value: { oid: 'pv' }, history: '24h' },
                { id: 'd', kind: 'sink', x: 0, y: 0, value: { expr: 'a', vars: { a: { oid: 'x' } } }, history: '1h' },
                { id: 'e', kind: 'sink', x: 0, y: 0, value: { oid: 'y' } },
            ],
            edges: [],
        };
        assert.deepEqual(historyRequests(config), [
            { oid: 'pv', period: '1h' },
            { oid: 'pv', period: '24h' },
        ]);
    });

    it('reads once, keeps it for a while, and ignores what is not a number', async () => {
        const asked: string[] = [];
        const read = (oid: string, options: { start: number; end: number; step: number }): Promise<unknown> => {
            asked.push(`${oid} ${options.end - options.start} ${options.step}`);
            return Promise.resolve([
                { ts: now - 1000, val: '7' },
                { ts: now - 3000, val: 5 },
                { ts: now - 2000, val: null },
            ]);
        };
        assert.equal(await loadHistory([{ oid: 'h.one', period: '1h' }], read, now), true);
        assert.equal(await loadHistory([{ oid: 'h.one', period: '1h' }], read, now + 30000), false);
        assert.deepEqual(asked, ['h.one 3600000 60000']);
        // Sorted, strings read as numbers, nulls left out
        assert.deepEqual(cachedHistory('h.one', '1h'), [
            { ts: now - 3000, val: 5 },
            { ts: now - 1000, val: 7 },
        ]);
    });

    it('draws a line and the area down to zero', () => {
        const box = { x: 0, y: 50, w: 100, h: 50 };
        const paths = sparklinePaths(
            [
                { ts: 0, val: 0 },
                { ts: 50, val: 100 },
                { ts: 100, val: 50 },
            ],
            box,
            0,
            100,
        );
        assert.ok(paths);
        assert.equal(paths.line, 'M0 100 L50 50 L100 75');
        assert.equal(paths.area, 'M0 100 L50 50 L100 75 L100 100 L0 100 Z');
        assert.equal(sparklinePaths([{ ts: 0, val: 1 }], box, 0, 100), null, 'one point is no line');

        // 52..54 V: its own range, not a flat line against zero
        const voltage = sparklinePaths(
            [
                { ts: 0, val: 52 },
                { ts: 100, val: 54 },
            ],
            box,
            0,
            100,
        );
        assert.equal(voltage?.line, 'M0 100 L100 50');
        assert.equal(voltage?.area, 'M0 100 L100 50 L100 100 L0 100 Z');
    });

    it('charts the value as the node shows it, through its rescaling', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [{ id: 'pv', kind: 'source', x: 100, y: 100, value: { oid: 'pv', invert: true }, history: '15m' }],
            edges: [],
        };
        const history = (): { ts: number; val: number }[] => [
            { ts: now - 600000, val: 100 },
            { ts: now - 60000, val: 300 },
        ];
        const runtime = computeRuntime(config, createValueGetter({ pv: 300 }), LIGHT_THEME, { history, now });
        const chart = runtime.nodes[0].chart;
        assert.ok(chart);
        // Inverted values lie below zero, so the line runs in the lower part of the box
        const box = nodeRect(config.nodes[0]);
        const lineYs = [...chart.line.matchAll(/ (-?[\d.]+)(?= |$)/g)].map(match => Number(match[1]));
        assert.ok(
            lineYs.every(y => y >= box.y + box.h * 0.55 && y <= box.y + box.h + 0.1),
            chart.line,
        );
        // Without recorded values there is nothing to draw
        assert.equal(computeRuntime(config, createValueGetter({}), LIGHT_THEME, { now }).nodes[0].chart, null);
    });
});

describe('rules, status texts and stale values', () => {
    const one = (extra: Partial<FlowConfig['nodes'][0]>): FlowConfig => ({
        v: 1,
        canvas: { w: 300, h: 200 },
        nodes: [{ id: 'n', kind: 'storage', x: 100, y: 100, value: { oid: 'v' }, unit: '%', ...extra }],
        edges: [],
    });

    it('compares numbers as numbers and anything else as text', () => {
        assert.equal(ruleMatches({ op: '<', value: 20 }, 15), true);
        assert.equal(ruleMatches({ op: '<', value: '20' }, 25), false);
        assert.equal(ruleMatches({ op: '==', value: 'Charging' }, 'Charging'), true);
        assert.equal(ruleMatches({ op: '!=', value: 'Charging' }, 'Idle'), true);
        assert.equal(ruleMatches({ op: '==', value: 'true' }, true), true);
        assert.equal(ruleMatches({ op: '>', value: 'x' }, 5), false, 'no order between a number and a text');
        assert.equal(ruleMatches({ op: '<', value: 5 }, null), false, 'unknown matches nothing');
        // The first that matches, in the order they are listed
        const rules = [
            { op: '<' as const, value: 10, color: 'red' },
            { op: '<' as const, value: 30, color: 'orange' },
        ];
        assert.equal(firstMatchingRule(rules, 5)?.color, 'red');
        assert.equal(firstMatchingRule(rules, 25)?.color, 'orange');
        assert.equal(firstMatchingRule(rules, 50), undefined);
    });

    it('recolours, swaps the icon and blinks by rule -- and the lines follow the colour', () => {
        const config: FlowConfig = {
            ...one({ rules: [{ op: '<', value: 20, color: '#ff0000', icon: 'plug', blink: true }] }),
            nodes: [
                {
                    id: 'n',
                    kind: 'storage',
                    x: 100,
                    y: 100,
                    value: { oid: 'v' },
                    unit: '%',
                    rules: [{ op: '<', value: 20, color: '#ff0000', icon: 'plug', blink: true }],
                },
                { id: 'h', kind: 'sink', x: 250, y: 100 },
            ],
            edges: [{ id: 'e', from: 'n', to: 'h', value: { oid: 'p' } }],
        };
        const low = computeRuntime(config, createValueGetter({ v: 12, p: 500 }), LIGHT_THEME);
        assert.equal(low.nodeById.n.color, '#ff0000');
        assert.equal(low.nodeById.n.icon, 'plug');
        assert.equal(low.nodeById.n.blink, true);
        assert.equal(low.edges[0].color, '#ff0000', 'the line out of the battery takes its colour');
        const fine = computeRuntime(config, createValueGetter({ v: 80, p: 500 }), LIGHT_THEME);
        assert.notEqual(fine.nodeById.n.color, '#ff0000');
        assert.equal(fine.nodeById.n.blink, false);
    });

    it('shows a status as text, translated where the node says how', () => {
        const config = one({
            display: 'text',
            textMap: { 1: 'Laden', 2: 'Entladen' },
            rules: [{ op: '==', value: 'Fehler', color: 'red' }],
        });
        const raw = (values: Record<string, unknown>) => (oid: string) => values[oid];
        const mapped = computeRuntime(config, createValueGetter({ v: 1 }), LIGHT_THEME, { raw: raw({ v: 1 }) });
        assert.equal(mapped.nodes[0].valueText.text, 'Laden');
        const plain = computeRuntime(config, createValueGetter({}), LIGHT_THEME, { raw: raw({ v: 'Fehler' }) });
        assert.equal(plain.nodes[0].valueText.text, 'Fehler');
        // Rules of a text node compare the raw value
        assert.equal(plain.nodes[0].color, 'red');
    });

    it('shows the word for a switch without being told to, and nothing at all when asked', () => {
        const raw = (values: Record<string, unknown>) => (oid: string) => values[oid];
        // No `display`, only the two words: a valve says "offen", not "1,00 %"
        const valve = one({ textMap: switchTextMap('offen', 'zu'), unit: '%' });
        const open = computeRuntime(valve, createValueGetter({ v: 1 }), LIGHT_THEME, { raw: raw({ v: true }) });
        assert.equal(open.nodes[0].valueText.text, 'offen');
        const shut = computeRuntime(valve, createValueGetter({ v: 0 }), LIGHT_THEME, { raw: raw({ v: 0 }) });
        assert.equal(shut.nodes[0].valueText.text, 'zu');
        // A value the map does not name is a number again, with its unit
        const other = computeRuntime(valve, createValueGetter({ v: 50 }), LIGHT_THEME, { raw: raw({ v: 50 }) });
        assert.equal(other.nodes[0].valueText.text.replace(/\u00a0/g, ' '), '50 %');

        // "No value": the node is its symbol and its label -- but the number is still read, because
        // rules, the fill level and the flow all use it
        const bare = one({
            kind: 'sink',
            display: 'none',
            levelMax: 100,
            rules: [{ op: '>', value: 40, color: 'red' }],
        });
        const runtime = computeRuntime(bare, createValueGetter({ v: 60 }), LIGHT_THEME);
        assert.equal(runtime.nodes[0].valueText.text, '');
        assert.equal(runtime.nodes[0].value, 60);
        assert.equal(runtime.nodes[0].level, 60);
        assert.equal(runtime.nodes[0].color, 'red');
        // ... and the renderer draws no number for it
        const drawn = renderToStaticMarkup(
            React.createElement(FlowView, { runtime, theme: LIGHT_THEME, animate: false }),
        );
        assert.equal(/<text[^>]*>[^<]*60[^<]*<\/text>/.test(drawn), false, 'no text of the value is drawn');
    });

    it('gives a connection the same words, without taking the number out of service', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 400, h: 200 },
            defaults: { medium: 'water', unit: 'l/min' },
            nodes: [
                { id: 'a', kind: 'grid', x: 80, y: 100 },
                { id: 'b', kind: 'sink', x: 320, y: 100 },
            ],
            edges: [
                {
                    id: 'e',
                    from: 'a',
                    to: 'b',
                    value: { oid: 'e' },
                    showValue: true,
                    textMap: switchTextMap('läuft', 'aus'),
                },
            ],
        };
        const raw = (values: Record<string, unknown>) => (oid: string) => values[oid];
        const theme = { ...LIGHT_THEME, locale: 'en-US' };
        const running = computeRuntime(config, createValueGetter({ e: 1 }), theme, { raw: raw({ e: true }) });
        assert.equal(running.edges[0].valueText.text, 'läuft');
        // The number keeps its work: the line flows, the way it was drawn
        assert.equal(running.edges[0].active, true);
        assert.equal(running.edges[0].direction, 1);
        assert.ok(running.edges[0].dotDuration > 0);

        const off = computeRuntime(config, createValueGetter({ e: 0 }), theme, { raw: raw({ e: false }) });
        assert.equal(off.edges[0].valueText.text, 'aus');
        assert.equal(off.edges[0].active, false);

        // A value the map does not name is the amount again, with its unit
        const other = computeRuntime(config, createValueGetter({ e: 7 }), theme, { raw: raw({ e: 7 }) });
        assert.equal(other.edges[0].valueText.text.replace(/\u00a0/g, ' '), '7.00 l/min');
    });

    it('dims a value that was not updated for too long', () => {
        const now = Date.UTC(2026, 8, 22, 12, 0, 0);
        const config: FlowConfig = { ...one({}), defaults: { staleAfter: 10 } };
        const times = (ts: number) => () => ({ ts, lc: ts });
        assert.equal(
            computeRuntime(config, createValueGetter({ v: 50 }), LIGHT_THEME, { times: times(now - 11 * 60000), now })
                .nodes[0].stale,
            true,
        );
        assert.equal(
            computeRuntime(config, createValueGetter({ v: 50 }), LIGHT_THEME, { times: times(now - 60000), now })
                .nodes[0].stale,
            false,
        );
        // The node's own setting wins over the diagram's
        const patient = { ...config, nodes: [{ ...config.nodes[0], staleAfter: 60 }] };
        assert.equal(
            computeRuntime(patient, createValueGetter({ v: 50 }), LIGHT_THEME, { times: times(now - 11 * 60000), now })
                .nodes[0].stale,
            false,
        );
    });

    it('colours green to red along a scale', () => {
        assert.equal(scaleColor(0.1, 0.1, 0.4), 'hsl(120, 72%, 46%)');
        assert.equal(scaleColor(0.4, 0.1, 0.4), 'hsl(0, 72%, 46%)');
        assert.equal(scaleColor(0.25, 0.1, 0.4), 'hsl(60, 72%, 46%)');
        assert.equal(scaleColor(null, 0, 1), undefined);
        // The node tints and mutes it like any other colour
        assert.deepEqual(parseColorString('hsl(120, 72%, 46%)'), [33, 202, 33]);
        assert.equal(withAlpha('hsl(0, 100%, 50%)', 0.5), 'rgba(255, 0, 0, 0.5)');
        const config = one({ colorScale: { src: { oid: 'price' }, min: 0.1, max: 0.4 } });
        assert.equal(
            computeRuntime(config, createValueGetter({ v: 1, price: 0.5 }), LIGHT_THEME).nodes[0].color,
            'hsl(0, 72%, 46%)',
        );
    });
});

describe('key figures and energy of today', () => {
    it('computes autarky and self-consumption from the power balance', () => {
        // 3 kW PV, 1 kW from the grid, battery idle: 4 kW consumption, 75 % from the own roof
        assert.equal(autarky({ production: 3000, grid: 1000, storage: 0 }), 75);
        // 3 kW PV, 1 kW fed in: 2 of 3 kW used on site
        assert.equal(Math.round(selfConsumption({ production: 3000, grid: -1000, storage: 0 })!), 67);
        assert.equal(autarky({ production: 0, grid: 0, storage: 0 }), null);
        assert.equal(selfConsumption({ production: 0, grid: 500, storage: 0 }), null);
    });

    it('counts each producer once, even when producers feed a producer', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 600, h: 400 },
            nodes: [
                { id: 'm1', kind: 'source', x: 50, y: 50, value: { oid: 'm1' } },
                { id: 'm2', kind: 'source', x: 150, y: 50, value: { oid: 'm2' } },
                { id: 'pv', kind: 'source', x: 100, y: 150 },
                { id: 'grid', kind: 'grid', x: 300, y: 150, value: { oid: 'g' } },
                { id: 'home', kind: 'sink', x: 200, y: 300 },
                { id: 'aut', kind: 'label', x: 500, y: 50, kpi: 'autarky' },
            ],
            edges: [
                { id: 'a', from: 'm1', to: 'pv', value: { oid: 'm1' } },
                { id: 'b', from: 'm2', to: 'pv', value: { oid: 'm2' } },
            ],
        };
        const runtime = computeRuntime(config, createValueGetter({ m1: 1000, m2: 2000, g: 1000 }), {
            ...LIGHT_THEME,
            locale: 'en-US',
        });
        // Production 3000 (not 6000), grid 1000 -> 75 %
        assert.equal(runtime.nodeById.aut.value, 75);
        assert.equal(runtime.nodeById.aut.valueText.text.replace(/\u00a0/g, ' '), '75 %');
    });

    it('shows an extra value that is a switch as a word, and everything else as a number', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            defaults: { medium: 'water', unit: 'l/min' },
            nodes: [
                {
                    id: 'tap',
                    kind: 'sink',
                    x: 100,
                    y: 100,
                    value: { oid: 'tap' },
                    badges: [
                        { src: { oid: 'valve' }, label: 'Ventil', textMap: switchTextMap('offen', 'zu') },
                        { src: { oid: 'pressure' }, unit: 'bar' },
                    ],
                },
            ],
            edges: [],
        };
        const words = (values: Record<string, unknown>): string[] =>
            computeRuntime(
                config,
                createValueGetter(values as Record<string, number>),
                { ...LIGHT_THEME, locale: 'en-US' },
                {
                    raw: oid => values[oid],
                },
            ).nodes[0].badges.map(badge => badge.text.replace(/\u00a0/g, ' '));

        // A boolean reaches the widget as true or false, a switch of an older adapter as 1 or 0
        assert.deepEqual(words({ tap: 8, valve: true, pressure: 3.2 }), ['offen', '3.20 bar']);
        assert.deepEqual(words({ tap: 8, valve: 0, pressure: 3.2 }), ['zu', '3.20 bar']);
        // A value the map does not name stays a number: half a map must not swallow anything
        assert.deepEqual(words({ tap: 8, valve: 7, pressure: 3.2 }), ['7.00 l/min', '3.20 bar']);

        // The two words are written and taken back one at a time, and the last one removed leaves nothing
        const map = switchTextMap('offen', 'zu');
        assert.equal(switchText(map, true), 'offen');
        assert.equal(switchText(map, false), 'zu');
        assert.equal(switchText(withSwitchText(map, true, undefined), true), '');
        assert.equal(switchText(withSwitchText(map, true, 'auf'), true), 'auf');
        assert.equal(withSwitchText(withSwitchText(map, true, ''), false, ''), undefined);
        assert.equal(switchText(undefined, true), '');
    });

    it('integrates today once, and shows it in kWh under the value', async () => {
        const now = Date.now();
        const asked: string[] = [];
        const read = (oid: string, options: { aggregate?: string; integralUnit?: number }): Promise<unknown> => {
            asked.push(`${oid} ${options.aggregate} ${options.integralUnit}`);
            return Promise.resolve([{ ts: now, val: 3200 }]);
        };
        const request = [{ oid: 'e.pv', seconds: 3600 }];
        assert.equal(await loadEnergyToday(request, read, now), true);
        assert.equal(await loadEnergyToday(request, read, now + 1000), false);
        assert.deepEqual(asked, ['e.pv integral 3600']);
        assert.equal(cachedEnergyToday('e.pv'), 3200);

        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                { id: 'pv', kind: 'source', x: 100, y: 100, value: { oid: 'e.pv' }, energyToday: { label: 'Heute' } },
            ],
            edges: [],
        };
        assert.deepEqual(energyRequests(config), [{ oid: 'e.pv', seconds: 3600 }]);
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'e.pv': 500 }),
            { ...LIGHT_THEME, locale: 'en-US' },
            {
                energy: cachedEnergyToday,
            },
        );
        assert.deepEqual(
            runtime.nodes[0].badges.map(badge => [badge.label, badge.text.replace(/\u00a0/g, ' ')]),
            [['Heute', '3.20 kWh']],
        );
    });

    it('takes the energy of the day from a counter of its own when it has one', () => {
        const counted: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            nodes: [
                {
                    id: 'pv',
                    kind: 'source',
                    x: 100,
                    y: 100,
                    value: { oid: 'e.pv' },
                    energyToday: { label: 'Heute', src: { oid: 'e.day' } },
                },
            ],
            edges: [],
        };
        // The history adapter is not asked for a node that counts the day itself
        assert.deepEqual(energyRequests(counted), []);
        // A flow per minute is integrated over minutes, or the litres would be sixty times too many
        assert.deepEqual(
            energyRequests({
                ...counted,
                nodes: counted.nodes.map(node => ({ ...node, unit: 'l/min', energyToday: { label: 'Heute' } })),
            }),
            [{ oid: 'e.pv', seconds: 60 }],
        );
        // ... and the state it reads is subscribed
        assert.ok(collectOids(counted).includes('e.day'));

        const badges = (options: Parameters<typeof computeRuntime>[3]): (string | undefined)[][] =>
            computeRuntime(
                counted,
                createValueGetter({ 'e.pv': 500, 'e.day': 2.81 }),
                { ...LIGHT_THEME, locale: 'en-US' },
                options,
            ).nodes[0].badges.map(badge => [badge.label, badge.text.replace(/\u00a0/g, ' ')]);

        // No unit on the object: a counter of the day is in kWh
        assert.deepEqual(badges({}), [['Heute', '2.81 kWh']]);
        // Its own unit wins: the same number in Wh, and whole watt hours print without decimals
        assert.deepEqual(badges({ units: () => 'Wh' }), [['Heute', '3 Wh']]);
        // The counter wins over what the history adapter would have integrated
        assert.deepEqual(badges({ energy: () => 9999 }), [['Heute', '2.81 kWh']]);
    });
});

describe('what flows', () => {
    it('reads the time base of a flow out of its unit', () => {
        // A power is counted in hours, which is what Wh means
        assert.equal(integralSeconds('W'), 3600);
        assert.equal(integralSeconds('kW'), 3600);
        assert.equal(integralSeconds(undefined), 3600);
        // A flow says its own: litres per minute are litres after sixty seconds
        assert.equal(integralSeconds('l/min'), 60);
        assert.equal(integralSeconds('l/s'), 1);
        assert.equal(integralSeconds('m\u00B3/h'), 3600);
    });

    it('names the amount a flow adds up to', () => {
        assert.equal(amountUnit('W'), 'Wh');
        assert.equal(amountUnit('l/min'), 'l');
        assert.equal(amountUnit('m\u00B3/h'), 'm\u00B3');
        assert.equal(amountUnit(''), '');
    });

    it('takes "nothing is flowing" from the medium, not from one watt', () => {
        const of = (medium: string | undefined, value: number): boolean => {
            const config: FlowConfig = {
                v: 1,
                canvas: { w: 300, h: 200 },
                defaults: medium ? { medium: medium as 'gas', unit: MEDIA[medium as 'gas'].unit } : {},
                nodes: [
                    { id: 'a', kind: 'grid', x: 60, y: 100 },
                    { id: 'b', kind: 'sink', x: 240, y: 100 },
                ],
                edges: [{ id: 'a-b', from: 'a', to: 'b', value: { oid: 'v' }, mode: 'positive' }],
            };
            return computeRuntime(config, createValueGetter({ v: value }), LIGHT_THEME).edges[0].active;
        };
        // A stove on the smallest flame: nothing in watts, everything in cubic metres an hour
        assert.equal(of('gas', 0.4), true);
        assert.equal(of(undefined, 0.4), false, '0.4 W is standby');
        assert.equal(of('gas', 0.01), false, 'and a gas meter creeps, too');
        assert.equal(of('water', 0.5), true);
        assert.equal(of('water', 0.05), false);
        // The line's own number still wins over the medium's
        assert.equal(edgeThreshold({ id: 'e', from: 'a', to: 'b', value: { oid: 'v' }, threshold: 7 }), 7);
    });

    it('starts a new diagram in the medium it was asked for', () => {
        // Nothing chosen: the document stays as empty as it has always been
        assert.deepEqual(emptyConfig(), { v: 1, canvas: { ...DEFAULT_CANVAS }, nodes: [], edges: [] });
        assert.equal(emptyConfig('energy').defaults, undefined, 'energy is the absence of a medium');

        const water = emptyConfig('water');
        assert.deepEqual(water.defaults, { medium: 'water', unit: 'l/min', animation: { refPower: 12 } });
        assert.deepEqual(water.nodes, []);
        // ... and the first node it gets is drawn as that medium draws it
        assert.equal(defaultIcon('storage', water), 'tank');
        assert.deepEqual(mediumDefaults('energy'), { unit: 'W' });
    });

    it('presets the unit, the dot speed and the icons of a medium', () => {
        assert.equal(mediumOf(undefined).id, 'energy');
        assert.equal(mediumOf({ ...buildPreset('pv-home', key => key), defaults: {} }).id, 'energy');
        const water = buildPreset('water-cistern', key => key);
        assert.equal(mediumOf(water).id, 'water');
        assert.equal(water.defaults?.unit, 'l/min');
        assert.equal(water.defaults?.animation?.refPower, 12);
        // A node that names no icon gets the one of its kind *in that medium*
        assert.equal(defaultIcon('source', water), 'well');
        // The tank shows its level, which is what a store of water is looked at for
        assert.equal(defaultIcon('storage', water), 'tank');
        assert.equal(defaultIcon('source', undefined), 'solar');
    });

    it('counts the day of a water flow in litres, not in watt hours', () => {
        const config: FlowConfig = {
            v: 1,
            canvas: { w: 300, h: 200 },
            defaults: { medium: 'water', unit: 'l/min' },
            nodes: [
                {
                    id: 'tap',
                    kind: 'sink',
                    x: 100,
                    y: 100,
                    value: { oid: 'w.flow' },
                    energyToday: { label: 'Heute' },
                },
            ],
            edges: [],
        };
        // Integrated over minutes, so the history adapter is asked for exactly that
        assert.deepEqual(energyRequests(config), [{ oid: 'w.flow', seconds: 60 }]);
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'w.flow': 9 }),
            { ...LIGHT_THEME, locale: 'en-US' },
            { energy: () => 118 },
        );
        assert.deepEqual(
            runtime.nodes[0].badges.map(badge => badge.text.replace(/\u00a0/g, ' ')),
            ['118 l'],
        );
    });
});

describe('assistant', () => {
    it('guesses what a power state is from its id and name', () => {
        assert.equal(guessDeviceKind('modbus.0.inputRegisters.pv_power', ''), 'source');
        assert.equal(guessDeviceKind('shelly.0.em3.power', 'Netzbezug'), 'grid');
        assert.equal(guessDeviceKind('victron.0.battery.power', 'Battery grid charge'), 'storage');
        assert.equal(guessDeviceKind('evcc.0.loadpoint.1.chargePower', ''), 'sink');
        assert.equal(guessDeviceKind('alias.0.wallbox.power', ''), 'sink');
        assert.equal(guessDeviceKind('mqtt.0.plug7.power', 'Kaffeemaschine'), null);
        // Whole words only for the short ones: "automatic" is no car, "lastUpdate" no load
        assert.equal(guessDeviceKind('javascript.0.automatic.power', ''), null);
        assert.equal(guessDeviceKind('x.0.lastUpdatePower', ''), null);
    });

    it('believes the name over the folder', () => {
        // A consumption summary that a script keeps in a folder called PV is a consumer
        assert.deepEqual(guessDevice('javascript.0.Powertrust.States.PV.Summary', 'Zusammenfassung Verbrauch'), {
            kind: 'sink',
            confidence: 3,
        });
        assert.deepEqual(guessDevice('modbus.0.holding.pv_power', ''), { kind: 'source', confidence: 2 });
        assert.deepEqual(guessDevice('javascript.0.PV.States.Something', 'Irgendwas'), {
            kind: 'source',
            confidence: 1,
        });
        assert.deepEqual(guessDevice('mqtt.0.plug7.power', 'Kaffeemaschine'), { kind: null, confidence: 0 });
    });

    it('recognises power and charge states by unit and role', () => {
        assert.equal(isFlowState({ unit: 'W', type: 'number' }), true);
        assert.equal(isFlowState({ unit: 'kW' }), true);
        assert.equal(isFlowState({ role: 'value.power.consumption' }), true);
        assert.equal(isFlowState({ unit: 'W', type: 'string' }), false);
        assert.equal(isFlowState({ unit: 'kWh' }), false, 'energy is not power');
        // ioBroker's power role is used for energy meters too; the unit decides
        assert.equal(isFlowState({ unit: 'Wh', role: 'value.power.consumption' }), false);
        assert.equal(isFlowState({ role: 'value.power.consumption' }), true);
        assert.equal(isSocState('bms.0.soc', '', { unit: '%' }), true);
        assert.equal(isSocState('x.0.humidity', 'Feuchte', { unit: '%' }), false);
        assert.equal(isSocState('x.0.level', '', { role: 'value.battery' }), true);
        assert.equal(objectName({ en: 'Grid', de: 'Netz' }, 'de'), 'Netz');
        assert.equal(objectName('Plain'), 'Plain');
    });

    it('looks for the units and the words of the diagram it is building', () => {
        // A water meter reports litres per minute, in whichever way its adapter spells it
        assert.equal(isFlowState({ unit: 'l/min' }, 'water'), true);
        assert.equal(isFlowState({ unit: 'm\u00B3/h' }, 'water'), true);
        assert.equal(isFlowState({ unit: 'm3 / h' }, 'gas'), true);
        assert.equal(isFlowState({ unit: 'W' }, 'water'), false, 'watts are not a water flow');
        assert.equal(isFlowState({ unit: 'l/min' }, 'energy'), false);
        // Without a unit only energy may be guessed: ioBroker has a role for power and for nothing else
        assert.equal(isFlowState({ role: 'value.power' }, 'water'), false);

        // ... and the words: a cistern is a storage, the water meter the "grid"
        assert.equal(guessDeviceKind('mqtt.0.zisterne.fuellstand', 'Zisterne', 'water'), 'storage');
        assert.equal(guessDeviceKind('x.0.wasserzaehler.flow', 'Wasserz\u00e4hler', 'water'), 'grid');
        assert.equal(guessDeviceKind('x.0.garten.bewaesserung', 'Bew\u00e4sserung', 'water'), 'sink');
        assert.equal(guessDeviceKind('x.0.brunnen.pumpe', 'Brunnen', 'water'), 'source');
        assert.equal(guessDeviceKind('x.0.puffer.oben', 'Pufferspeicher', 'heat'), 'storage');
        assert.equal(guessDeviceKind('x.0.wp.leistung', 'W\u00e4rmepumpe', 'heat'), 'source');
        // The same id reads differently in another medium, which is the whole point
        assert.equal(guessDeviceKind('x.0.brunnen.pumpe', 'Brunnen', 'energy'), null);
    });

    it('builds the diagram in the medium it was asked for', () => {
        const config = buildFromDevices(
            [
                { oid: 'w.meter', kind: 'grid', label: 'Wasserz\u00e4hler' },
                { oid: 'w.garden', kind: 'sink', label: 'Gartenbew\u00e4sserung' },
            ],
            { home: 'Haus', medium: 'water' },
        );
        assert.equal(config.defaults?.medium, 'water');
        assert.equal(config.defaults?.unit, 'l/min');
        assert.equal(config.defaults?.animation?.refPower, MEDIA.water.refValue);
        // The consumer keeps its own icon; the rest comes from the kind in that medium
        assert.equal(config.nodes.find(node => node.label === 'Gartenbew\u00e4sserung')?.icon, 'sprinkler');
        const runtime = computeRuntime(config, () => null, LIGHT_THEME);
        assert.equal(runtime.nodes.find(node => node.node.kind === 'grid')?.icon, 'pipe');

        // An energy diagram keeps the shape it always had -- no medium, no reference value
        const energy = buildFromDevices([{ oid: 'p', kind: 'source', label: 'PV' }], { home: 'Haus' });
        assert.deepEqual(energy.defaults, { unit: 'W' });
    });

    it('lays out producers on top, grid left, storage right, consumers below, bound on the lines', () => {
        const config = buildFromDevices(
            [
                { oid: 'pv.a', kind: 'source', label: 'Dach' },
                { oid: 'pv.b', kind: 'source', label: 'Garage' },
                { oid: 'meter.p', kind: 'grid', label: 'Netz' },
                { oid: 'bat.p', kind: 'storage', label: 'Akku' },
                { oid: 'evcc.p', kind: 'sink', label: 'Wallbox' },
            ],
            { home: 'Haus', soc: 'bat.soc' },
        );
        const byId = Object.fromEntries(config.nodes.map(node => [node.id, node]));
        assert.deepEqual(
            config.nodes.map(node => node.id),
            ['home', 'pv', 'pv-2', 'grid', 'battery', 'load'],
        );
        assert.ok(byId.pv.y < byId.home.y && byId.load.y > byId.home.y);
        assert.ok(byId.grid.x < byId.home.x && byId.battery.x > byId.home.x);
        assert.deepEqual(byId.battery.soc, { oid: 'bat.soc' });
        assert.equal(byId.load.icon, 'wallbox');
        const edge = (from: string, to: string): FlowEdgeLike | undefined =>
            config.edges.find(item => item.from === from && item.to === to);
        assert.deepEqual(edge('pv', 'home')?.value, { oid: 'pv.a' });
        assert.equal(edge('grid', 'home')?.mode, 'signed');
        assert.equal(edge('home', 'load')?.mode, 'positive');
        // The house works out its own consumption from the lines
        const runtime = computeRuntime(
            config,
            createValueGetter({ 'pv.a': 2000, 'pv.b': 1000, 'meter.p': 500, 'bat.p': 0, 'evcc.p': 1200 }),
            LIGHT_THEME,
        );
        assert.equal(runtime.nodeById.home.value, 2300);
    });

    it('puts the house consumption on the house instead of beside it', () => {
        const config = buildFromDevices(
            [
                { oid: 'docs.housePower', kind: 'sink', label: 'House' },
                { oid: 'docs.wallboxPower', kind: 'sink', label: 'Wallbox' },
            ],
            { home: 'Haus' },
        );
        assert.deepEqual(
            config.nodes.map(node => node.id),
            ['home', 'load'],
        );
        assert.deepEqual(config.nodes[0].value, { oid: 'docs.housePower' });
    });
});

type FlowEdgeLike = FlowConfig['edges'][0];

describe('diagram styles', () => {
    it('falls back to normal and keeps the host theme there', () => {
        assert.equal(diagramStyle(undefined).id, 'normal');
        assert.equal(diagramStyle({ ...buildPreset('pv-home', key => key), defaults: { style: 'clean' } }).id, 'clean');
        assert.equal(
            styledTheme(
                LIGHT_THEME,
                buildPreset('pv-home', key => key),
            ),
            LIGHT_THEME,
        );
        assert.deepEqual(DIAGRAM_STYLE_IDS, ['normal', 'clean', 'neo', 'neon', 'glass']);
    });

    it('follows the light or dark mode of the host', () => {
        const config: FlowConfig = { ...buildPreset('pv-home', key => key), defaults: { style: 'clean' } };
        const light = styledTheme(LIGHT_THEME, config);
        const dark = styledTheme(DARK_THEME, config);
        assert.equal(light.mode, 'light');
        assert.equal(dark.mode, 'dark');
        assert.notEqual(light.background, dark.background);
        // The runtime colours its nodes with the styled theme, the one they are drawn with
        const runtime = computeRuntime(config, () => null, LIGHT_THEME);
        assert.equal(runtime.nodeById.pv.color, light.kinds.source);
    });

    it('shows the level of a circle as a ring in neon, as a fill elsewhere', () => {
        const markup = (style: 'normal' | 'neon'): string => {
            const config: FlowConfig = {
                v: 1,
                canvas: { w: 200, h: 200 },
                defaults: { style },
                nodes: [
                    {
                        id: 'pv',
                        kind: 'source',
                        shape: 'circle',
                        x: 100,
                        y: 100,
                        w: 100,
                        h: 100,
                        value: { oid: 'pv' },
                        unit: 'W',
                        levelMax: 1000,
                    },
                ],
                edges: [],
            };
            const runtime = computeRuntime(config, createValueGetter({ pv: 250 }), DARK_THEME);
            return renderToStaticMarkup(React.createElement(FlowView, { runtime, theme: DARK_THEME }));
        };
        const neon = markup('neon');
        // A quarter of the way round, clockwise from the top (100, 50): ends at the right (150, 100)
        const arc = /M 100 50 A 50 50 0 0 1 ([0-9.]+) ([0-9.]+)/.exec(neon);
        assert.ok(arc, neon);
        assert.equal(Math.round(Number(arc[1])), 150);
        assert.equal(Math.round(Number(arc[2])), 100);
        assert.ok(!neon.includes('<clipPath'), 'no fill to clip');
        assert.ok(neon.includes('<filter'), 'the glow');
        const normal = markup('normal');
        assert.ok(normal.includes('<clipPath'), 'the fill from the bottom');
        assert.ok(!normal.includes('<filter'));
    });

    it('puts the value of a connection on the line when it is drawn as a chip', () => {
        const base: FlowConfig = {
            v: 1,
            canvas: { w: 400, h: 200 },
            nodes: [
                { id: 'a', kind: 'source', x: 80, y: 100 },
                { id: 'b', kind: 'sink', x: 320, y: 100 },
            ],
            edges: [{ id: 'a-b', from: 'a', to: 'b', value: { oid: 'p' }, showValue: true }],
        };
        const get = createValueGetter({ p: 1200 });
        const beside = computeRuntime(base, get, LIGHT_THEME).edges[0];
        const chip = computeRuntime({ ...base, defaults: { edgeLabel: 'chip' } }, get, LIGHT_THEME).edges[0];
        // Beside: above the line, by more than the text is high
        assert.equal(beside.labelPos.x, beside.geometry.mid.x);
        assert.ok(Math.abs(beside.labelPos.y - beside.geometry.mid.y) > 10);
        // As a chip: on the line, because it brings its own background
        assert.deepEqual(chip.labelPos, chip.geometry.mid);
    });

    it('knows where a line starts and ends, and which way it runs there', () => {
        const from = { point: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };
        const to = { point: { x: 200, y: 100 }, dir: { x: -1, y: 0 } };
        for (const curve of ['bezier', 'orthogonal', 'straight'] as const) {
            const geometry = edgeGeometry(from, to, curve);
            assert.deepEqual(geometry.start, { x: 0, y: 0 }, curve);
            assert.deepEqual(geometry.end, { x: 200, y: 100 }, curve);
            // Arriving from the left, moving right
            assert.ok(geometry.endDir.x > 0, `${curve}: ${JSON.stringify(geometry.endDir)}`);
            assert.ok(geometry.startDir.x > 0, curve);
        }
    });
});

describe('label sizes', () => {
    it('derives the diagram label size from the font size unless it is set', () => {
        const config = buildPreset('pv-home', key => key);
        assert.equal(pageLabelSize(config), 13, 'three quarters of the default 17');
        assert.equal(pageLabelSize({ ...config, defaults: { fontSize: 24 } }), 18);
        assert.equal(pageLabelSize({ ...config, defaults: { fontSize: 24, labelSize: 30 } }), 30);
    });

    it('scales a node label relative to the diagram label size', () => {
        const config: FlowConfig = { ...buildPreset('pv-home', key => key), defaults: { labelSize: 20 } };
        const node = { ...config.nodes[0], labelScale: 1.5 };
        assert.equal(nodeLabelSize(node, config), 30);
        assert.equal(nodeLabelSize({ ...node, labelScale: undefined }, config), 20);
        // Nonsense falls back to the diagram's size rather than drawing nothing
        assert.equal(nodeLabelSize({ ...node, labelScale: 0 }, config), 20);

        const runtime = computeRuntime({ ...config, nodes: [node, ...config.nodes.slice(1)] }, () => null, LIGHT_THEME);
        assert.equal(runtime.nodes[0].labelFontSize, 30);
        assert.equal(runtime.nodes[1].labelFontSize, 20);
        // The values on the connections follow the diagram's size, not a node's
        assert.equal(runtime.labelFontSize, 20);
    });
});

describe('import and export files', () => {
    const t = (key: string): string => key;
    const ENERGIEFLUSS = readFileSync(new URL('./fixtures/energiefluss-default.json', import.meta.url), 'utf8');

    it('reads an exported diagram under the name of its file', () => {
        const config = buildPreset('pv-battery-home', t);
        const result = readImport(JSON.stringify(config), 'Dach');
        assert.ok('items' in result);
        assert.equal(result.items.length, 1);
        const [item] = result.items;
        assert.equal(item.name, 'Dach');
        assert.equal(item.source, 'diagram');
        assert.equal(item.config.nodes.length, config.nodes.length);
        assert.equal(item.config.edges.length, config.edges.length);
    });

    it('round-trips a set of diagrams through a bundle', () => {
        const bundle = createBundle(
            [
                { name: 'Haus', config: buildPreset('pv-home', t) },
                { name: 'Garage', config: buildPreset('pv-battery-home', t) },
            ],
            new Date('2026-09-21T10:00:00Z'),
        );
        assert.equal(bundle.format, BUNDLE_FORMAT);
        assert.equal(bundle.exported, '2026-09-21T10:00:00.000Z');
        assert.equal(isBundle(bundle), true);

        const result = readImport(JSON.stringify(bundle), 'backup');
        assert.ok('items' in result);
        assert.deepEqual(
            result.items.map(item => [item.name, item.source, item.config.nodes.length]),
            [
                ['Haus', 'bundle', 3],
                ['Garage', 'bundle', bundle.diagrams[1].config.nodes.length],
            ],
        );
    });

    it('skips broken entries of a bundle, and refuses one with nothing usable', () => {
        const good = { name: '  PV  ', config: buildPreset('pv-home', t) };
        const text = JSON.stringify({
            format: BUNDLE_FORMAT,
            v: 1,
            exported: '',
            diagrams: [null, { name: 'no config' }, { name: 'no nodes', config: {} }, good, { config: good.config }],
        });
        const result = readImport(text, 'file');
        assert.ok('items' in result);
        // The name is trimmed, and an entry without one gets the file's
        assert.deepEqual(
            result.items.map(item => item.name),
            ['PV', 'file'],
        );

        const empty = JSON.stringify({ format: BUNDLE_FORMAT, v: 1, exported: '', diagrams: [{ name: 'x' }] });
        assert.deepEqual(readImport(empty, 'file'), { error: 'bundle-empty' });
    });

    it('converts an energiefluss-erweitert configuration on the way in', () => {
        const result = readImport(ENERGIEFLUSS, 'alt');
        assert.ok('items' in result);
        assert.equal(result.items.length, 1);
        const [item] = result.items;
        assert.equal(item.source, 'energiefluss');
        assert.equal(item.name, 'alt');
        assert.equal(item.config.nodes.length, 5);
        assert.equal(item.stats?.merged, 17);
    });

    it('says why a file is not a diagram, instead of importing it as an empty one', () => {
        const json = readImport('{ nodes: [', 'x');
        assert.ok('error' in json && json.error === 'json' && !!json.detail);
        assert.deepEqual(readImport('[]', 'x'), { error: 'not-object' });
        assert.deepEqual(readImport('42', 'x'), { error: 'not-object' });
        assert.deepEqual(readImport('null', 'x'), { error: 'not-object' });
        // Valid JSON of some other program: no `nodes` array, so no diagram
        assert.deepEqual(readImport('{"name":"package","version":"1.0.0"}', 'x'), { error: 'unknown-format' });
        assert.deepEqual(readImport('{"nodes":{}}', 'x'), { error: 'unknown-format' });
        // Nodes that all lack an id would vanish in normalisation
        assert.deepEqual(readImport('{"nodes":[{"label":"a"},{"label":"b"}]}', 'x'), { error: 'no-valid-nodes' });
        // An empty diagram, on the other hand, is a diagram
        const empty = readImport('{"nodes":[],"edges":[]}', 'x');
        assert.ok('items' in empty && empty.items[0].config.nodes.length === 0);
    });

    it('turns names into file names and back', () => {
        assert.equal(diagramFileName(slugify('Meine Anlage')), 'meine_anlage.json');
        assert.equal(nameFromFileName('meine_anlage.json'), 'meine anlage');
        assert.equal(nameFromFileName('backup.2026-09-21.json'), 'backup.2026-09-21');
        assert.equal(nameFromFileName('ohne-endung'), 'ohne-endung');
        assert.equal(nameFromFileName('.json'), 'diagram');
    });
});

describe('presets', () => {
    it('every preset renders without an unresolved reference', () => {
        for (const id of [
            'pv-home',
            'pv-battery-home',
            'pv-battery-wallbox',
            'pv-battery-heating',
            'grid-home',
        ] as const) {
            const config = buildPreset(id, key => key);
            const runtime = computeRuntime(config, () => null, LIGHT_THEME);
            assert.equal(
                runtime.edges.length,
                config.edges.length,
                `${id}: an edge points at a node that does not exist`,
            );
            // Nothing is configured yet, so everything must render its placeholder rather than "NaN"
            assert.ok(
                runtime.nodes.every(node => !node.valueText.text.includes('NaN')),
                id,
            );
            assert.ok(
                runtime.edges.every(edge => edge.direction === 0),
                id,
            );
        }
    });

    it('asks for one state per direction pair, not two', () => {
        const config = buildPreset('pv-battery-home', key => key);
        const grid = config.edges.find(edge => edge.from === 'grid')!;
        assert.equal(grid.mode, 'signed');
        assert.equal(grid.reverse, undefined);
    });
});
