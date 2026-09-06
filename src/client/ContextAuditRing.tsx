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

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AuditReport } from '../audit.ts'
import type { AuditUiState } from './store.ts'
import type { createAuditStore } from './store.ts'
import { NS } from './locales.ts'

export type ContextAuditRingProps =
  PropsRuntime<'conversation.input.right'>
  & PropsStore<ReturnType<typeof createAuditStore>>
  & PropsLocale<typeof NS>

const AUDIT_API = '/api/context-doctor/audit'
/** Budget the rail measures against; the audit itself is budget-agnostic. */
const FULL_SCALE = 50_000
/** Where the rail changes colour — drawn as ticks so the rule is visible. */
const THRESHOLDS = [10_000, 30_000] as const
/** Entries listed before a breakdown collapses into a "+N more" line. */
const DETAIL_LIMIT = 6

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
} as const

/** Figures only — never the surrounding text, which has to carry CJK. */
const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace'

/** One non-overlapping slice of the resident budget. */
interface Segment {
  key: 'instructions' | 'skills' | 'tools' | 'mcp'
  label: string
  sub: string
  tokens: number
  color: string
  detail: { title: string; rows: { name: string; tokens: number }[]; note?: string } | null
}

function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const value = tokens / 1000
  if (value >= 100 || Number.isInteger(value)) return `${Math.round(value)}k`
  return `${value.toFixed(1)}k`
}

/** Trailing path segment; the full path stays in the row's `title`. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  const last = parts.at(-1) ?? path
  const parent = parts.at(-2)
  return parent === undefined ? last : `${parent}/${last}`
}

function healthLevel(tokens: number): 'mint' | 'amber' | 'red' {
  if (tokens < THRESHOLDS[0]) return 'mint'
  if (tokens < THRESHOLDS[1]) return 'amber'
  return 'red'
}

/**
 * Build the four non-overlapping budget slices.
 *
 * MCP schema tokens are a subset of `tools.schemaTokens`, so the tool slice
 * carries `nativeTokens` only — otherwise the shares sum past 100%.
 */
function buildSegments(report: AuditReport, t: ContextAuditRingProps['t']): Segment[] {
  const { instructions, skills, tools } = report.injected
  const items = report.receipt?.toolSchemas.items ?? []

  const nativeSchemas = items.filter(item => item.server === undefined)
    .sort((a, b) => b.tokens - a.tokens)
    .map(item => ({ name: item.name, tokens: item.tokens }))
  const mcpSchemas = items.filter(item => item.server !== undefined)
    .sort((a, b) => b.tokens - a.tokens)
    .map(item => ({ name: item.name, tokens: item.tokens }))

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
  }]
}

function PulseIcon({ size = 15 }: { size?: number }): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 12h4l2.05-5 3.62 10L15.2 12H21" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function RefreshIcon(): ReactElement {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M20 11a8 8 0 0 0-14.98-3.8M4 5v4h4M4 13a8 8 0 0 0 14.98 3.8M20 19v-4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

/** Resident control in the tool row, just before Send. */
export function ContextAuditRing(props: ContextAuditRingProps): ReactElement {
  const { useStore, actions, sessionId, t } = props
  const state: AuditUiState = useStore(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Segment['key'] | null>(null)
  const panelId = useId()
  const dockRef = useRef<HTMLSpanElement | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    actions.setState('loading', null)
    // `detail=developer` carries the per-entry receipt the breakdown lists.
    // `lang` is sent explicitly because the host cannot resolve the panel's
    // language on its own: the stored preference is optional and its absence
    // means "follow the browser" (issue #11). The locale plugin keeps
    // `<html lang>` on the active locale, so that is the reading to forward.
    const lang = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    const url = `${AUDIT_API}?session=${encodeURIComponent(sessionId)}&detail=developer&lang=${lang}`
    void fetch(url, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(`audit ${response.status}`)
      return response.json() as Promise<{ ok: boolean; report: AuditUiState['report'] }>
    }).then(data => {
      if (controller.signal.aborted) return
      if (data.ok && data.report !== null && data.report !== undefined) actions.setReport(data.report)
      else actions.setState('error', 'empty audit response')
    }, () => {
      if (!controller.signal.aborted) actions.setState('error', 'audit transport error')
    })
  }, [actions, sessionId])

  useEffect(() => {
    refresh()
    return () => controllerRef.current?.abort()
  }, [refresh])

  // Dismiss on Escape or on any pointer landing outside the control.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    const onPointerDown = (event: PointerEvent): void => {
      const dock = dockRef.current
      if (dock !== null && event.target instanceof Node && !dock.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    // Capture phase: a click handled (and stopped) by page content still closes.
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  const report = state.report
  const segments = useMemo(() => report === null ? [] : buildSegments(report, t), [report, t])
  const resident = segments.reduce((sum, segment) => sum + segment.tokens, 0)
  const percent = Math.min(resident / FULL_SCALE, 1)
  const level = state.state === 'error' ? 'red' : healthLevel(resident)
  const accent = TONE[level]
  const suggestions = report?.suggestions ?? []
  const status = state.state === 'error'
    ? t('cd.error')
    : level === 'red' ? t('cd.heavy') : suggestions.length > 0 ? t('cd.review') : t('cd.healthy')
  const statusHint = level === 'red'
    ? t('cd.heavyHint')
    : suggestions.length > 0 ? t('cd.reviewHint') : t('cd.healthyHint')
  // A healthy, suggestion-free audit says everything it needs to in the header.
  const showHealth = level !== 'mint' || suggestions.length > 0

  const updated = state.refreshedAt === null ? '—' : (() => {
    const seconds = Math.max(0, Math.round((Date.now() - state.refreshedAt) / 1000))
    if (seconds < 10) return t('cd.justNow')
    if (seconds < 60) return t('cd.secondsAgo', { n: seconds })
    return t('cd.minutesAgo', { n: Math.round(seconds / 60) })
  })()

  return <span ref={dockRef} data-context-doctor style={dockStyle}>
    {/*
      Icon-only on purpose. A labelled pill cost ~150px of the composer tool
      row, and stacked with other plugins' buttons plus a long model name it
      pushed the row onto a second line (issues #6 / #7). The icon carries the
      status in its colour, so a separate status dot would only repeat it; the
      name lives in the tooltip and the accessible label.
    */}
    <button type="button" onClick={() => setOpen(value => !value)}
      title={`${t('cd.title')} · ${status}`} aria-label={`${t('cd.title')} · ${status}`}
      aria-expanded={open} aria-controls={panelId}
      style={{ ...triggerStyle, color: accent }}>
      <PulseIcon size={16} />
    </button>

    {open && <section id={panelId} role="dialog" aria-label={t('cd.title')} style={panelStyle}>
      <header style={headStyle}>
        <span style={eyebrowStyle}>{t('cd.title')}</span>
        <span style={{ ...statusStyle, color: accent }}>
          <span aria-hidden="true" style={{ ...statusDotStyle, background: accent }} />{status}
        </span>
      </header>

      {state.state === 'error' && <p style={errorStyle}>{t('cd.error')}: {state.error}</p>}

      {report === null && state.state !== 'error'
        ? <p style={emptyStyle}>{state.state === 'loading' ? t('cd.loading') : t('cd.emptyState')}</p>
        : report !== null && <>
          <div style={gaugeStyle}>
            <div style={readStyle}>
              <strong style={readValueStyle}>{formatK(resident)}</strong>
              <span style={readUnitStyle}>{t('cd.residentUnit')}</span>
              <span style={readPercentStyle}>{Math.round(percent * 100)}% / {formatK(FULL_SCALE)}</span>
            </div>
            <div style={railStyle} role="img"
              aria-label={`${formatK(resident)} / ${formatK(FULL_SCALE)}`}>
              <span style={railTrackStyle}>
                {segments.filter(segment => segment.tokens > 0).map(segment =>
                  <span key={segment.key} style={{
                    width: `${(segment.tokens / FULL_SCALE) * 100}%`,
                    background: segment.color,
                    height: '100%',
                  }} />)}
              </span>
              {THRESHOLDS.map(threshold => <span key={threshold} aria-hidden="true"
                style={{ ...tickStyle, left: `${(threshold / FULL_SCALE) * 100}%` }}>
                <span style={tickLabelStyle}>{formatK(threshold)}</span>
              </span>)}
            </div>
          </div>

          <ul style={tableStyle}>
            {segments.map(segment => {
              const share = resident === 0 ? 0 : segment.tokens / resident
              const isOpen = expanded === segment.key
              const canExpand = segment.detail !== null
              return <li key={segment.key} style={{ listStyle: 'none' }}>
                <button type="button" disabled={!canExpand}
                  onClick={() => setExpanded(current => current === segment.key ? null : segment.key)}
                  aria-expanded={isOpen}
                  title={canExpand ? (isOpen ? t('cd.collapse') : t('cd.expand')) : t('cd.noDetail')}
                  style={{ ...rowStyle, cursor: canExpand ? 'pointer' : 'default' }}>
                  <span aria-hidden="true" style={{
                    ...keyStyle,
                    background: canExpand ? segment.color : TONE.border,
                  }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ ...rowLabelStyle, color: canExpand ? TONE.text : TONE.muted }}>{segment.label}</span>
                    <span style={rowSubStyle}>{segment.sub}</span>
                  </span>
                  <span style={rowValueStyle}>{formatK(segment.tokens)}</span>
                  <span style={rowShareStyle}>{Math.round(share * 100)}%</span>
                </button>

                {isOpen && segment.detail !== null && <div style={detailStyle}>
                  <span style={detailTitleStyle}>{segment.detail.title}</span>
                  {segment.detail.rows.slice(0, DETAIL_LIMIT).map(row =>
                    <span key={row.name} style={detailRowStyle} title={row.name}>
                      <span style={detailNameStyle}>{row.name}</span>
                      <span style={detailValueStyle}>{formatK(row.tokens)}</span>
                    </span>)}
                  {segment.detail.rows.length > DETAIL_LIMIT
                    && <span style={detailMoreStyle}>{t('cd.more', { n: segment.detail.rows.length - DETAIL_LIMIT })}</span>}
                  {segment.detail.note !== undefined && <span style={detailNoteStyle}>{segment.detail.note}</span>}
                </div>}
              </li>
            })}
          </ul>

          {showHealth && <div style={healthStyle}>
            <p style={healthCopyStyle}>{statusHint}</p>
            {suggestions.length > 0 && <ol style={suggestionListStyle}>
              {suggestions.slice(0, 3).map(suggestion => {
                const tone = suggestion.severity === 'high' ? TONE.red : suggestion.severity === 'medium' ? TONE.amber : TONE.mint
                return <li key={suggestion.text} style={suggestionStyle}>
                  <span aria-hidden="true" style={{ ...suggestionDotStyle, background: tone }} />
                  <span style={suggestionCopyStyle}>{suggestion.text}</span>
                </li>
              })}
            </ol>}
          </div>}
        </>}

      <footer style={footerStyle}>
        <span style={updatedStyle}>{t('cd.updated', { when: updated })}</span>
        <button type="button" onClick={refresh} disabled={state.state === 'loading'} style={refreshStyle}>
          <RefreshIcon />{t('cd.refresh')}
        </button>
      </footer>
    </section>}
  </span>
}

/* Text inherits the shell's UI font on purpose; only figures set MONO. */
const dockStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', position: 'relative' }
const triggerStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: `1px solid ${TONE.border}`, borderRadius: 7, cursor: 'pointer', font: 'inherit' }

const panelStyle: CSSProperties = { position: 'absolute', zIndex: 1000, right: 0, bottom: 'calc(100% + 12px)', width: 424, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(70vh, 620px)', overflowX: 'hidden', overflowY: 'auto', color: TONE.text, background: TONE.canvas, border: `1px solid ${TONE.borderStrong}`, borderRadius: 12, boxShadow: '0 2px 6px rgba(0, 0, 0, .18), 0 20px 46px rgba(0, 0, 0, .3)', textAlign: 'left' }

const headStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '14px 16px 0' }
const eyebrowStyle: CSSProperties = { color: TONE.quiet, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.14em' }
const statusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500 }
const statusDotStyle: CSSProperties = { width: 6, height: 6, borderRadius: 99 }

const errorStyle: CSSProperties = { margin: '12px 16px 0', color: TONE.red, fontSize: 12, lineHeight: 1.45 }
const emptyStyle: CSSProperties = { margin: 0, padding: '34px 16px', color: TONE.muted, fontSize: 12.5, textAlign: 'center' }

const gaugeStyle: CSSProperties = { padding: '12px 16px 0' }
const readStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 7 }
const readValueStyle: CSSProperties = { fontFamily: MONO, fontSize: 29, fontWeight: 500, letterSpacing: '-0.035em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }
const readUnitStyle: CSSProperties = { color: TONE.muted, fontSize: 12 }
const readPercentStyle: CSSProperties = { marginLeft: 'auto', color: TONE.muted, fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums' }
const railStyle: CSSProperties = { position: 'relative', height: 23, marginTop: 11 }
const railTrackStyle: CSSProperties = { position: 'absolute', inset: '0 0 auto', display: 'flex', height: 8, overflow: 'hidden', background: TONE.sunk, borderRadius: 3 }
const tickStyle: CSSProperties = { position: 'absolute', top: 0, width: 1, height: 12, background: TONE.borderStrong }
const tickLabelStyle: CSSProperties = { position: 'absolute', top: 13, left: '50%', transform: 'translateX(-50%)', color: TONE.quiet, fontFamily: MONO, fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }

const tableStyle: CSSProperties = { margin: '16px 0 0', padding: 0, listStyle: 'none', borderTop: `1px solid ${TONE.border}` }
const rowStyle: CSSProperties = { display: 'grid', width: '100%', gridTemplateColumns: '3px minmax(0, 1fr) 62px 40px', alignItems: 'center', columnGap: 11, padding: '10px 16px', color: TONE.text, background: 'transparent', border: 0, borderBottom: `1px solid ${TONE.border}`, textAlign: 'left', font: 'inherit' }
const keyStyle: CSSProperties = { width: 3, height: 22, borderRadius: 2 }
const rowLabelStyle: CSSProperties = { display: 'block', overflow: 'hidden', fontSize: 12.5, fontWeight: 500, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowSubStyle: CSSProperties = { display: 'block', marginTop: 2, overflow: 'hidden', color: TONE.quiet, fontSize: 11, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowValueStyle: CSSProperties = { fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
const rowShareStyle: CSSProperties = { color: TONE.muted, fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }

const detailStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 16px 11px 30px', background: TONE.raised, borderBottom: `1px solid ${TONE.border}` }
const detailTitleStyle: CSSProperties = { marginBottom: 2, color: TONE.quiet, fontSize: 10.5, fontWeight: 500 }
const detailRowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 58px', alignItems: 'baseline', columnGap: 10 }
const detailNameStyle: CSSProperties = { overflow: 'hidden', color: TONE.muted, fontSize: 11.5, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const detailValueStyle: CSSProperties = { color: TONE.text, fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
const detailMoreStyle: CSSProperties = { marginTop: 2, color: TONE.quiet, fontSize: 11 }
const detailNoteStyle: CSSProperties = { marginTop: 4, color: TONE.amber, fontSize: 11, lineHeight: 1.4 }

const healthStyle: CSSProperties = { padding: '12px 16px 13px', borderBottom: `1px solid ${TONE.border}` }
const healthCopyStyle: CSSProperties = { margin: 0, color: TONE.muted, fontSize: 11.5, lineHeight: 1.5 }
const suggestionListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, margin: '10px 0 0', padding: 0, listStyle: 'none' }
const suggestionStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '6px minmax(0, 1fr)', alignItems: 'start', columnGap: 9 }
const suggestionDotStyle: CSSProperties = { width: 6, height: 6, marginTop: 5, borderRadius: 99 }
const suggestionCopyStyle: CSSProperties = { color: TONE.muted, fontSize: 11.5, lineHeight: 1.45 }

const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 16px 12px' }
const updatedStyle: CSSProperties = { color: TONE.quiet, fontSize: 11, fontVariantNumeric: 'tabular-nums' }
const refreshStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, color: TONE.blue, background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 500 }
