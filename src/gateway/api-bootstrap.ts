/** api-bootstrap.ts — one-shot startup data aggregate.
 * Bundles the six lightweight endpoints the UI fires in parallel on first
 * paint (status / system-stats / orchestration config+eligible / search
 * settings / think settings) into a single request to cut startup round-trips.
 * systemStats can be slow (nvidia-smi probe); it races a 2s timeout and the
 * UI's 3s polling refresh fills in the null slot afterwards. */
import express from 'express';
import { getStatusPayload } from './api-files';
import { getSystemStatsPayload } from './api-system';
import { getOrchestrationConfigForApi } from './api-skills';
import { checkOrchestrationEligibility } from '../orchestration/multi-agent';
import { getSearchSettingsPayload, getThinkSettingsPayload } from './api-settings';

const SYSTEM_STATS_TIMEOUT_MS = 2000;

export function registerBootstrapRoutes(app: express.Express): void {
  app.get('/api/bootstrap', async (_req, res) => {
    try {
      const [s1, s2, s3, s4, s5, s6] = await Promise.allSettled([
        getStatusPayload(),
        Promise.race([
          getSystemStatsPayload(),
          new Promise<any>((resolve) => setTimeout(() => resolve(null), SYSTEM_STATS_TIMEOUT_MS)),
        ]),
        Promise.resolve(getOrchestrationConfigForApi()),
        checkOrchestrationEligibility().catch(() => ({ eligible: false, reason: 'eligibility-check-failed' })),
        Promise.resolve(getSearchSettingsPayload()),
        Promise.resolve(getThinkSettingsPayload()),
      ]);
      const val = <T>(x: PromiseSettledResult<T>): T | null => (x.status === 'fulfilled' ? x.value : null);
      res.json({
        ok: true,
        status: val(s1),
        systemStats: val(s2),
        orchestration: {
          config: val(s3),
          eligible: val(s4),
        },
        searchSettings: val(s5),
        thinkSettings: val(s6),
        servedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}
