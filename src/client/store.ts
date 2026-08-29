/**
 * Browser-side audit store: the audit report snapshot plus fetch lifecycle,
 * written only through the store's actions. Components only read snapshots.
 * @module dsh-context-doctor/client/store
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { AuditReport } from '../audit.ts'

/** Audit UI state as consumers see it. */
export interface AuditUiState {
  /** Fetch lifecycle. */
  state: 'idle' | 'loading' | 'ready' | 'error'
  /** Latest audit report; null before the first successful fetch. */
  report: AuditReport | null
  /** Transport error message, when any. */
  error: string | null
  /** Epoch ms of the last successful refresh. */
  refreshedAt: number | null
}

/** Store write set. */
export type AuditUiActions = {
  /** Mark the fetch lifecycle. */
  setState: (draft: AuditUiState, state: AuditUiState['state'], error: string | null) => void
  /** Store a fetched report. */
  setReport: (draft: AuditUiState, report: AuditReport) => void
}

/** Create the audit store handle (apply world only; never module-level). */
export function createAuditStore(): EngineStoreHandle<AuditUiState, AuditUiActions> {
  return defineStore({
    init: (): AuditUiState => ({
      state: 'idle',
      report: null,
      error: null,
      refreshedAt: null,
    }),
    actions: {
      setState: (draft, state, error) => {
        draft.state = state
        draft.error = error
      },
      setReport: (draft, report) => {
        draft.report = report
        draft.state = 'ready'
        draft.error = null
        draft.refreshedAt = Date.now()
      },
    },
  })
}
