import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Context Doctor's composer control, seated in the input tool row through
 * `conversation.input.right` — a stock DSH slot, so the control appears on an
 * unmodified harness (issue #4).
 *
 * The panel reads as a measuring instrument: a budget rail with the 10k / 30k
 * thresholds drawn in (so "how close to the warning line" is visible rather
 * than implied), then a compact table of the four non-overlapping slices, each
 * expanding into the entries behind it.
 *
 * Typography rule: text inherits the DSH shell's own UI font — the panel sets
 * no family — and monospace is applied only to figures. The previous build put
 * `ui-monospace, …, Consolas` on the whole panel, a stack with no CJK coverage
 * at all, so every mixed line rendered Latin in mono and Chinese in whatever
 * the system fell back to.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatTokens } from "../tokens.js";
const AUDIT_API = '/api/context-doctor/audit';
/** Budget the rail measures against; the audit itself is budget-agnostic. */
const FULL_SCALE = 50_000;
/** Where the rail changes colour — drawn as ticks so the rule is visible. */
const THRESHOLDS = [10_000, 30_000];
/** Entries listed before a breakdown collapses into a "+N more" line. */
const DETAIL_LIMIT = 6;
const TONE = {
    canvas: 'var(--dsw-alias-bg-layer-1, #161b24)',
    raised: 'var(--dsw-alias-bg-layer-2, #1d2430)',
    sunk: 'var(--dsw-alias-bg-layer-3, #252d3b)',
    border: 'var(--dsw-alias-border-l2, rgba(196, 211, 232, 0.16))',
    borderStrong: 'var(--dsw-alias-border-l3, rgba(196, 211, 232, 0.3))',
    text: 'var(--dsw-alias-label-primary, #e9edf4)',
    muted: 'var(--dsw-alias-label-secondary, #9ba5b5)',
    quiet: 'var(--dsw-alias-label-tertiary, #707a8b)',
    mint: 'var(--dsw-alias-state-success-primary, #4fc281)',
    amber: 'var(--dsw-alias-state-warn-primary, #e0a83a)',
    red: 'var(--dsw-alias-state-error-primary, #ef6a7d)',
    blue: 'var(--dsw-alias-brand-primary, #7c9bff)',
    violet: '#a488ea',
};
/** Figures only — never the surrounding text, which has to carry CJK. */
const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace';
/** Trailing path segment; the full path stays in the row's `title`. */
function baseName(path) {
    const parts = path.split(/[/\\]/).filter(Boolean);
    const last = parts.at(-1) ?? path;
    const parent = parts.at(-2);
    return parent === undefined ? last : `${parent}/${last}`;
}
function healthLevel(tokens) {
    if (tokens < THRESHOLDS[0])
        return 'mint';
    if (tokens < THRESHOLDS[1])
        return 'amber';
    return 'red';
}
/**
 * Build the four non-overlapping budget slices.
 *
 * MCP schema tokens are a subset of `tools.schemaTokens`, so the tool slice
 * carries `nativeTokens` only — otherwise the shares sum past 100%.
 */
function buildSegments(report, t) {
    const { instructions, skills, tools } = report.injected;
    const items = report.receipt?.toolSchemas.items ?? [];
    const nativeSchemas = items.filter(item => item.server === undefined)
        .sort((a, b) => b.tokens - a.tokens)
        .map(item => ({ name: item.name, tokens: item.tokens }));
    const mcpSchemas = items.filter(item => item.server !== undefined)
        .sort((a, b) => b.tokens - a.tokens)
        .map(item => ({ name: item.name, tokens: item.tokens }));
    return [{
            key: 'instructions',
            label: t('cd.instructions'),
            sub: instructions.files.length === 0 ? t('cd.emptyCategory') : t('cd.instructions.sub', { n: instructions.files.length }),
            tokens: instructions.totalTokens,
            color: TONE.blue,
            detail: instructions.files.length === 0 ? null : {
                title: t('cd.byFile'),
                rows: [...instructions.files]
                    .sort((a, b) => b.tokens - a.tokens)
                    .map(file => ({ name: baseName(file.path), tokens: file.tokens })),
                ...instructions.duplicateBlocks.length > 0 ? {
                    note: t('cd.duplicateBlocks', {
                        n: instructions.duplicateBlocks.length,
                        tokens: instructions.duplicateBlocks.reduce((sum, block) => sum + block.tokens, 0),
                    }),
                } : {},
            },
        }, {
            key: 'skills',
            label: t('cd.skills'),
            sub: skills.catalogCount === 0 ? t('cd.emptyCategory') : t('cd.skills.sub', { n: skills.catalogCount }),
            tokens: skills.catalogDescriptionTokens,
            color: TONE.violet,
            detail: skills.bySource.length === 0 ? null : {
                title: t('cd.bySource'),
                rows: [...skills.bySource]
                    .sort((a, b) => b.descriptionTokens - a.descriptionTokens)
                    .map(source => ({ name: `${source.source} · ${source.count}`, tokens: source.descriptionTokens })),
                ...skills.duplicateDescriptions.length > 0
                    ? { note: t('cd.duplicateSkills', { n: skills.duplicateDescriptions.length }) }
                    : report.conflicts.length > 0 ? { note: t('cd.shadowed', { n: report.conflicts.length }) } : {},
            },
        }, {
            key: 'tools',
            label: t('cd.tools'),
            sub: tools.nativeCount === 0 ? t('cd.emptyCategory') : t('cd.tools.sub', { n: tools.nativeCount }),
            tokens: tools.nativeTokens,
            color: TONE.amber,
            detail: nativeSchemas.length === 0 ? null : { title: t('cd.topSchemas'), rows: nativeSchemas },
        }, {
            key: 'mcp',
            label: t('cd.mcp'),
            sub: tools.mcp.totalTools === 0
                ? t('cd.emptyCategory')
                : t('cd.mcp.sub', { n: tools.mcp.totalTools, servers: tools.mcp.servers.length }),
            tokens: tools.mcp.totalTokens,
            color: TONE.mint,
            detail: tools.mcp.servers.length === 0 ? null : {
                title: mcpSchemas.length > 0 ? t('cd.topSchemas') : t('cd.byServer'),
                rows: mcpSchemas.length > 0
                    ? mcpSchemas
                    : [...tools.mcp.servers]
                        .sort((a, b) => b.schemaTokens - a.schemaTokens)
                        .map(server => ({ name: `${server.server} · ${server.tools}`, tokens: server.schemaTokens })),
            },
        }];
}
function PulseIcon({ size = 15 }) {
    return _jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M3 12h4l2.05-5 3.62 10L15.2 12H21", stroke: "currentColor", strokeWidth: "1.9", strokeLinecap: "round", strokeLinejoin: "round" }) });
}
function RefreshIcon() {
    return _jsx("svg", { width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M20 11a8 8 0 0 0-14.98-3.8M4 5v4h4M4 13a8 8 0 0 0 14.98 3.8M20 19v-4h-4", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }) });
}
/** Resident control in the tool row, just before Send. */
export function ContextAuditRing(props) {
    const { useStore, actions, sessionId, t } = props;
    const state = useStore(snapshot => snapshot);
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState(null);
    const panelId = useId();
    const dockRef = useRef(null);
    const controllerRef = useRef(null);
    const refresh = useCallback(() => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        actions.setState('loading', null);
        // `detail=developer` carries the per-entry receipt the breakdown lists.
        // `lang` is sent explicitly because the host cannot resolve the panel's
        // language on its own: the stored preference is optional and its absence
        // means "follow the browser" (issue #11). The locale plugin keeps
        // `<html lang>` on the active locale, so that is the reading to forward.
        const lang = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
        const url = `${AUDIT_API}?session=${encodeURIComponent(sessionId)}&detail=developer&lang=${lang}`;
        void fetch(url, { signal: controller.signal }).then(response => {
            if (!response.ok)
                throw new Error(`audit ${response.status}`);
            return response.json();
        }).then(data => {
            if (controller.signal.aborted)
                return;
            if (data.ok && data.report !== null && data.report !== undefined)
                actions.setReport(data.report);
            else
                actions.setState('error', 'empty audit response');
        }, () => {
            if (!controller.signal.aborted)
                actions.setState('error', 'audit transport error');
        });
    }, [actions, sessionId]);
    useEffect(() => {
        refresh();
        return () => controllerRef.current?.abort();
    }, [refresh]);
    // Dismiss on Escape or on any pointer landing outside the control.
    useEffect(() => {
        if (!open)
            return undefined;
        const onKeyDown = (event) => { if (event.key === 'Escape')
            setOpen(false); };
        const onPointerDown = (event) => {
            const dock = dockRef.current;
            if (dock !== null && event.target instanceof Node && !dock.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        // Capture phase: a click handled (and stopped) by page content still closes.
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [open]);
    const report = state.report;
    const segments = useMemo(() => report === null ? [] : buildSegments(report, t), [report, t]);
    const resident = segments.reduce((sum, segment) => sum + segment.tokens, 0);
    const percent = Math.min(resident / FULL_SCALE, 1);
    const level = state.state === 'error' ? 'red' : healthLevel(resident);
    const accent = TONE[level];
    const suggestions = report?.suggestions ?? [];
    const status = state.state === 'error'
        ? t('cd.error')
        : level === 'red' ? t('cd.heavy') : suggestions.length > 0 ? t('cd.review') : t('cd.healthy');
    const statusHint = level === 'red'
        ? t('cd.heavyHint')
        : suggestions.length > 0 ? t('cd.reviewHint') : t('cd.healthyHint');
    // A healthy, suggestion-free audit says everything it needs to in the header.
    const showHealth = level !== 'mint' || suggestions.length > 0;
    const updated = state.refreshedAt === null ? '—' : (() => {
        const seconds = Math.max(0, Math.round((Date.now() - state.refreshedAt) / 1000));
        if (seconds < 10)
            return t('cd.justNow');
        if (seconds < 60)
            return t('cd.secondsAgo', { n: seconds });
        return t('cd.minutesAgo', { n: Math.round(seconds / 60) });
    })();
    return _jsxs("span", { ref: dockRef, "data-context-doctor": true, style: dockStyle, children: [_jsx("button", { type: "button", onClick: () => setOpen(value => !value), title: `${t('cd.title')} · ${status}`, "aria-label": `${t('cd.title')} · ${status}`, "aria-expanded": open, "aria-controls": panelId, style: { ...triggerStyle, color: accent }, children: _jsx(PulseIcon, { size: 16 }) }), open && _jsxs("section", { id: panelId, role: "dialog", "aria-label": t('cd.title'), style: panelStyle, children: [_jsxs("header", { style: headStyle, children: [_jsx("span", { style: eyebrowStyle, children: t('cd.title') }), _jsxs("span", { style: { ...statusStyle, color: accent }, children: [_jsx("span", { "aria-hidden": "true", style: { ...statusDotStyle, background: accent } }), status] })] }), state.state === 'error' && _jsxs("p", { style: errorStyle, children: [t('cd.error'), ": ", state.error] }), report === null && state.state !== 'error'
                        ? _jsx("p", { style: emptyStyle, children: state.state === 'loading' ? t('cd.loading') : t('cd.emptyState') })
                        : report !== null && _jsxs(_Fragment, { children: [_jsxs("div", { style: gaugeStyle, children: [_jsxs("div", { style: readStyle, children: [_jsx("strong", { style: readValueStyle, children: formatTokens(resident) }), _jsx("span", { style: readUnitStyle, children: t('cd.residentUnit') }), _jsxs("span", { style: readPercentStyle, children: [Math.round(percent * 100), "% / ", formatTokens(FULL_SCALE)] })] }), _jsxs("div", { style: railStyle, role: "img", "aria-label": `${formatTokens(resident)} / ${formatTokens(FULL_SCALE)}`, children: [_jsx("span", { style: railTrackStyle, children: segments.filter(segment => segment.tokens > 0).map(segment => _jsx("span", { style: {
                                                            width: `${(segment.tokens / FULL_SCALE) * 100}%`,
                                                            background: segment.color,
                                                            height: '100%',
                                                        } }, segment.key)) }), THRESHOLDS.map(threshold => _jsx("span", { "aria-hidden": "true", style: { ...tickStyle, left: `${(threshold / FULL_SCALE) * 100}%` }, children: _jsx("span", { style: tickLabelStyle, children: formatTokens(threshold) }) }, threshold))] })] }), _jsx("ul", { style: tableStyle, children: segments.map(segment => {
                                        const share = resident === 0 ? 0 : segment.tokens / resident;
                                        const isOpen = expanded === segment.key;
                                        const canExpand = segment.detail !== null;
                                        return _jsxs("li", { style: { listStyle: 'none' }, children: [_jsxs("button", { type: "button", disabled: !canExpand, onClick: () => setExpanded(current => current === segment.key ? null : segment.key), "aria-expanded": isOpen, title: canExpand ? (isOpen ? t('cd.collapse') : t('cd.expand')) : t('cd.noDetail'), style: { ...rowStyle, cursor: canExpand ? 'pointer' : 'default' }, children: [_jsx("span", { "aria-hidden": "true", style: {
                                                                ...keyStyle,
                                                                background: canExpand ? segment.color : TONE.border,
                                                            } }), _jsxs("span", { style: { minWidth: 0 }, children: [_jsx("span", { style: { ...rowLabelStyle, color: canExpand ? TONE.text : TONE.muted }, children: segment.label }), _jsx("span", { style: rowSubStyle, children: segment.sub })] }), _jsx("span", { style: rowValueStyle, children: formatTokens(segment.tokens) }), _jsxs("span", { style: rowShareStyle, children: [Math.round(share * 100), "%"] })] }), isOpen && segment.detail !== null && _jsxs("div", { style: detailStyle, children: [_jsx("span", { style: detailTitleStyle, children: segment.detail.title }), segment.detail.rows.slice(0, DETAIL_LIMIT).map(row => _jsxs("span", { style: detailRowStyle, title: row.name, children: [_jsx("span", { style: detailNameStyle, children: row.name }), _jsx("span", { style: detailValueStyle, children: formatTokens(row.tokens) })] }, row.name)), segment.detail.rows.length > DETAIL_LIMIT
                                                            && _jsx("span", { style: detailMoreStyle, children: t('cd.more', { n: segment.detail.rows.length - DETAIL_LIMIT }) }), segment.detail.note !== undefined && _jsx("span", { style: detailNoteStyle, children: segment.detail.note })] })] }, segment.key);
                                    }) }), showHealth && _jsxs("div", { style: healthStyle, children: [_jsx("p", { style: healthCopyStyle, children: statusHint }), suggestions.length > 0 && _jsx("ol", { style: suggestionListStyle, children: suggestions.slice(0, 3).map(suggestion => {
                                                const tone = suggestion.severity === 'high' ? TONE.red : suggestion.severity === 'medium' ? TONE.amber : TONE.mint;
                                                return _jsxs("li", { style: suggestionStyle, children: [_jsx("span", { "aria-hidden": "true", style: { ...suggestionDotStyle, background: tone } }), _jsx("span", { style: suggestionCopyStyle, children: suggestion.text })] }, suggestion.text);
                                            }) })] })] }), _jsxs("footer", { style: footerStyle, children: [_jsx("span", { style: updatedStyle, children: t('cd.updated', { when: updated }) }), _jsxs("button", { type: "button", onClick: refresh, disabled: state.state === 'loading', style: refreshStyle, children: [_jsx(RefreshIcon, {}), t('cd.refresh')] })] })] })] });
}
/* Text inherits the shell's UI font on purpose; only figures set MONO. */
const dockStyle = { display: 'inline-flex', alignItems: 'center', position: 'relative' };
const triggerStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: `1px solid ${TONE.border}`, borderRadius: 7, cursor: 'pointer', font: 'inherit' };
const panelStyle = { position: 'absolute', zIndex: 1000, right: 0, bottom: 'calc(100% + 12px)', width: 424, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(70vh, 620px)', overflowX: 'hidden', overflowY: 'auto', color: TONE.text, background: TONE.canvas, border: `1px solid ${TONE.borderStrong}`, borderRadius: 12, boxShadow: '0 2px 6px rgba(0, 0, 0, .18), 0 20px 46px rgba(0, 0, 0, .3)', textAlign: 'left' };
const headStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 16px 0' };
const eyebrowStyle = { color: TONE.quiet, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.14em' };
const statusStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500 };
const statusDotStyle = { width: 6, height: 6, borderRadius: 99 };
const errorStyle = { margin: '12px 16px 0', color: TONE.red, fontSize: 12, lineHeight: 1.45 };
const emptyStyle = { margin: 0, padding: '34px 16px', color: TONE.muted, fontSize: 12.5, textAlign: 'center' };
const gaugeStyle = { padding: '12px 16px 0' };
const readStyle = { display: 'flex', alignItems: 'baseline', gap: 7 };
const readValueStyle = { fontFamily: MONO, fontSize: 29, fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' };
const readUnitStyle = { color: TONE.muted, fontSize: 12 };
const readPercentStyle = { marginLeft: 'auto', color: TONE.muted, fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums' };
const railStyle = { position: 'relative', height: 23, marginTop: 11 };
const railTrackStyle = { position: 'absolute', inset: '0 0 auto', display: 'flex', height: 8, overflow: 'hidden', background: TONE.sunk, borderRadius: 3 };
const tickStyle = { position: 'absolute', top: 0, width: 1, height: 12, background: TONE.borderStrong };
const tickLabelStyle = { position: 'absolute', top: 13, left: '50%', transform: 'translateX(-50%)', color: TONE.quiet, fontFamily: MONO, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' };
const tableStyle = { margin: '16px 0 0', padding: 0, listStyle: 'none', borderTop: `1px solid ${TONE.border}` };
const rowStyle = { display: 'grid', width: '100%', gridTemplateColumns: '3px minmax(0, 1fr) 62px 40px', alignItems: 'center', columnGap: 11, padding: '10px 16px', color: TONE.text, background: 'transparent', border: 0, borderBottom: `1px solid ${TONE.border}`, textAlign: 'left', font: 'inherit' };
const keyStyle = { width: 3, height: 22, borderRadius: 2 };
const rowLabelStyle = { display: 'block', overflow: 'hidden', fontSize: 12.5, fontWeight: 500, textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowSubStyle = { display: 'block', marginTop: 2, overflow: 'hidden', color: TONE.quiet, fontSize: 11, textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const rowValueStyle = { fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const rowShareStyle = { color: TONE.muted, fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const detailStyle = { display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 16px 11px 30px', background: TONE.raised, borderBottom: `1px solid ${TONE.border}` };
const detailTitleStyle = { marginBottom: 2, color: TONE.quiet, fontSize: 10.5, fontWeight: 500 };
const detailRowStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 58px', alignItems: 'baseline', columnGap: 10 };
const detailNameStyle = { overflow: 'hidden', color: TONE.muted, fontSize: 11.5, textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const detailValueStyle = { color: TONE.text, fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const detailMoreStyle = { marginTop: 2, color: TONE.quiet, fontSize: 11 };
const detailNoteStyle = { marginTop: 4, color: TONE.amber, fontSize: 11, lineHeight: 1.4 };
const healthStyle = { padding: '12px 16px 13px', borderBottom: `1px solid ${TONE.border}` };
const healthCopyStyle = { margin: 0, color: TONE.muted, fontSize: 11.5, lineHeight: 1.5 };
const suggestionListStyle = { display: 'flex', flexDirection: 'column', gap: 6, margin: '10px 0 0', padding: 0, listStyle: 'none' };
const suggestionStyle = { display: 'grid', gridTemplateColumns: '6px minmax(0, 1fr)', alignItems: 'start', columnGap: 9 };
const suggestionDotStyle = { width: 6, height: 6, marginTop: 5, borderRadius: 99 };
const suggestionCopyStyle = { color: TONE.muted, fontSize: 11.5, lineHeight: 1.45 };
const footerStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 16px 12px' };
const updatedStyle = { color: TONE.quiet, fontSize: 11, fontVariantNumeric: 'tabular-nums' };
const refreshStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, color: TONE.blue, background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500 };
