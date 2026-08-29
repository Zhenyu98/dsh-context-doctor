/**
 * Browser-side audit store: the audit report snapshot plus fetch lifecycle,
 * written only through the store's actions. Components only read snapshots.
 * @module dsh-context-doctor/client/store
 */
import { defineStore } from '@deepseek-ai/dsh-client-store';
/** Create the audit store handle (apply world only; never module-level). */
export function createAuditStore() {
    return defineStore({
        init: () => ({
            state: 'idle',
            report: null,
            error: null,
            refreshedAt: null,
        }),
        actions: {
            setState: (draft, state, error) => {
                draft.state = state;
                draft.error = error;
            },
            setReport: (draft, report) => {
                draft.report = report;
                draft.state = 'ready';
                draft.error = null;
                draft.refreshedAt = Date.now();
            },
        },
    });
}
