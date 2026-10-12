/** api-schedules.ts — cron schedule CRUD/run/parse routes extracted from
 * server-v2.ts (Phase 5d-9). deps: cronScheduler singleton (isConfirmed is
 * an import from chat-execution). */
import express from 'express';
import { isConfirmed } from './chat-execution';

export interface SchedulesRouteDeps {
  cronScheduler: {
    getJobs: () => any[];
    createJob: (j: any) => any;
    updateJob: (id: string, patch: any) => any;
    deleteJob: (id: string) => boolean;
    runJobNow: (id: string, opts?: any) => Promise<void>;
  };
}

export function registerSchedulesRoutes(app: express.Express, deps: SchedulesRouteDeps): void {
// ─── Scheduler API ─────────────────────────────────────────────────────────



app.post('/api/schedules', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, confirm } = req.body;
  
  // Require confirmation for create
  if (!isConfirmed(confirm)) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  if (!name || !pattern || !prompt) {
    return res.json({ success: false, error: 'name, pattern, and prompt are required' });
  }
  
  try {
    const job = deps.cronScheduler.createJob({
      name: String(name).slice(0, 100),
      prompt: String(prompt).slice(0, 2000),
      schedule: /^\d/.test(pattern) ? pattern : null,  // If starts with number, assume cron
      runAt: !/^\d/.test(pattern) ? pattern : null,  // NL pattern
      tz: timezone || 'UTC',
      delivery: 'web',  // Only web supported for now
    });
    
    res.json({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        status: 'active',
        next_run: job.nextRun,
      },
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.post('/api/schedules', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, confirm } = req.body;
  
  // Require confirmation for create
  if (!isConfirmed(confirm)) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  if (!name || !pattern || !prompt) {
    return res.json({ success: false, error: 'name, pattern, and prompt are required' });
  }
  
  try {
    const job = deps.cronScheduler.createJob({
      name: String(name).slice(0, 100),
      prompt: String(prompt).slice(0, 2000),
      schedule: /^\d/.test(pattern) ? pattern : null,  // If starts with number, assume cron
      runAt: !/^\d/.test(pattern) ? pattern : null,  // NL pattern
      tz: timezone || 'UTC',
      delivery: 'web',  // Only web supported for now
    });
    
    res.json({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        status: 'active',
        next_run: job.nextRun,
      },
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.patch('/api/schedules/:id', (req: any, res: any) => {
  const { status } = req.body;
  
  try {
    const job = deps.cronScheduler.updateJob(req.params.id, { status });
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.patch('/api/schedules/:id', (req: any, res: any) => {
  const { status } = req.body;
  
  try {
    const job = deps.cronScheduler.updateJob(req.params.id, { status });
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.patch('/api/schedules/:id', (req: any, res: any) => {
  const { status } = req.body;
  
  try {
    const job = deps.cronScheduler.updateJob(req.params.id, { status });
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.post('/api/schedules/:id/run', (req: any, res: any) => {
  try {
    deps.cronScheduler.runJobNow(req.params.id);
    res.json({ success: true, message: 'Schedule triggered' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});



app.post('/api/schedules/parse', (req: any, res: any) => {
  const { text, timezone } = req.body;
  
  if (!text) {
    return res.json({ success: false, error: 'text is required' });
  }
  
  try {
    let cron = '';
    let preview = '';
    const t = text.toLowerCase().trim();
    
    // Helper: extract time from text and handle AM/PM
    function extractTime(text: string): { hour: number; minute: number } | null {
      // Match: "3:13pm", "15:13", "3:13", "11am", etc.
      const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (!timeMatch) return null;
      
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const period = timeMatch[3]?.toLowerCase();
      
      // Convert 12-hour to 24-hour format if AM/PM specified
      if (period === 'pm' && hour !== 12) {
        hour += 12;
      } else if (period === 'am' && hour === 12) {
        hour = 0;
      }
      
      // Validate ranges
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      
      return { hour, minute };
    }
    
    if (t.includes('daily') || t.includes('every day')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        const hourStr = String(timeInfo.hour).padStart(2, '0');
        const minStr = String(timeInfo.minute).padStart(2, '0');
        cron = `${timeInfo.minute} ${timeInfo.hour} * * *`;
        preview = `Daily at ${hourStr}:${minStr}`;
      } else {
        cron = '0 9 * * *';
        preview = 'Daily at 09:00';
      }
    } else if (t.includes('weekly')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1`;
        preview = `Weekly on Monday at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1';
        preview = 'Weekly on Monday at 09:00';
      }
    } else if (t.includes('monday') || t.includes('tuesday') || t.includes('wednesday') || t.includes('thursday') || t.includes('friday')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1-5`;
        preview = `Weekdays at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1-5';
        preview = 'Weekdays at 09:00';
      }
    } else if (/^\d{1,2} \d{1,2} \d|\d \d \*/.test(t)) {
      cron = t;
      preview = 'Custom cron pattern';
    } else {
      return res.json({
        success: false,
        error: 'Could not parse pattern. Try: "daily at 3:13pm", "daily at 15:13", "weekly", or cron like "0 9 * * *"',
        confidence: 0,
      });
    }
    
    res.json({
      success: true,
      kind: 'cron',
      cron,
      human_text: preview,
      preview,
      timezone: timezone || 'UTC',
      confidence: 0.8,
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});


}
