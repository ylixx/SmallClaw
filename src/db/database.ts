import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { Job, Task, Step, Artifact, Approval, TaskState, JobStatus, TaskStatus } from '../types';

const DB_PATH = path.join(os.homedir(), '.smallclaw', 'jobs.db');

export class JobDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || DB_PATH;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'queued',
        priority INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        completed_at INTEGER,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        assigned_to TEXT,
        dependencies TEXT DEFAULT '[]',
        acceptance_criteria TEXT DEFAULT '[]',
        retry_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        agent_role TEXT,
        tool_name TEXT,
        tool_args TEXT,
        result TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT,
        path TEXT,
        content TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        details TEXT,
        approval_status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        resolved_at INTEGER,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_state (
        job_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
      CREATE TABLE IF NOT EXISTS memory_logs (
        id TEXT PRIMARY KEY,
        reference TEXT,
        fact TEXT,
        source_tool TEXT,
        source_output TEXT,
        actor TEXT,
        success INTEGER DEFAULT 1,
        error TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      CREATE TABLE IF NOT EXISTS synth_logs (
        id TEXT PRIMARY KEY,
        reference TEXT,
        facts TEXT,
        reply TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS agent_failures (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        turn_id TEXT,
        kind TEXT NOT NULL,
        details TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_failures_session ON agent_failures(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_failures_kind ON agent_failures(kind);
    `);
  }

  // ---- Jobs ----
  createJob(job: Omit<Job, 'created_at' | 'updated_at'>): Job {
    this.db.prepare(`
      INSERT INTO jobs (id, title, description, status, priority, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.id, job.title, job.description, job.status, job.priority,
           job.metadata ? JSON.stringify(job.metadata) : null);
    return this.getJob(job.id)!;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : undefined };
  }

  listJobs(status?: JobStatus): Job[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC').all(status) as any[]
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : undefined }));
  }

  updateJobStatus(id: string, status: JobStatus): void {
    this.db.prepare(`UPDATE jobs SET status = ?, updated_at = strftime('%s','now') WHERE id = ?`).run(status, id);
  }

  // ---- Tasks ----
  createTask(task: Omit<Task, 'created_at'>): Task {
    this.db.prepare(`
      INSERT OR IGNORE INTO tasks (id, job_id, title, description, status, assigned_to, dependencies, acceptance_criteria, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.job_id, task.title, task.description, task.status,
           task.assigned_to, JSON.stringify(task.dependencies),
           JSON.stringify(task.acceptance_criteria), task.retry_count);
    return this.getTask(task.id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { ...row, dependencies: JSON.parse(row.dependencies), acceptance_criteria: JSON.parse(row.acceptance_criteria) };
  }

  listTasksForJob(jobId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE job_id = ? ORDER BY created_at ASC').all(jobId) as any[];
    return rows.map(r => ({ ...r, dependencies: JSON.parse(r.dependencies), acceptance_criteria: JSON.parse(r.acceptance_criteria) }));
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
  }

  // ---- Steps ----
  createStep(step: Omit<Step, 'created_at'>): Step {
    this.db.prepare(`
      INSERT INTO steps (id, task_id, step_number, agent_role, tool_name, tool_args, result, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(step.id, step.task_id, step.step_number, step.agent_role, step.tool_name,
           step.tool_args ? JSON.stringify(step.tool_args) : null,
           step.result ? JSON.stringify(step.result) : null, step.error);
    return this.getStep(step.id)!;
  }

  getStep(id: string): Step | null {
    const row = this.db.prepare('SELECT * FROM steps WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { ...row, tool_args: row.tool_args ? JSON.parse(row.tool_args) : undefined, result: row.result ? JSON.parse(row.result) : undefined };
  }

  listStepsForTask(taskId: string): Step[] {
    const rows = this.db.prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY step_number ASC').all(taskId) as any[];
    return rows.map(r => ({ ...r, tool_args: r.tool_args ? JSON.parse(r.tool_args) : undefined, result: r.result ? JSON.parse(r.result) : undefined }));
  }

  // ---- Artifacts ----
  createArtifact(artifact: Omit<Artifact, 'created_at'>): Artifact {
    this.db.prepare(`INSERT INTO artifacts (id, job_id, task_id, type, path, content) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.job_id, artifact.task_id, artifact.type, artifact.path, artifact.content);
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact.id) as Artifact;
  }

  listArtifactsForJob(jobId: string): Artifact[] {
    return this.db.prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC').all(jobId) as Artifact[];
  }

  // ---- Task State ----
  saveTaskState(state: TaskState): void {
    this.db.prepare(`INSERT OR REPLACE INTO task_state (job_id, state, updated_at) VALUES (?, ?, strftime('%s','now'))`)
      .run(state.job_id, JSON.stringify(state));
  }

  getTaskState(jobId: string): TaskState | null {
    const row = this.db.prepare('SELECT * FROM task_state WHERE job_id = ?').get(jobId) as any;
    return row ? JSON.parse(row.state) : null;
  }

  // ---- Approvals ---- (column renamed to approval_status to avoid SQLite keyword conflict)
  createApproval(approval: Omit<Approval, 'created_at'>): Approval {
    this.db.prepare(`
      INSERT INTO approvals (id, job_id, task_id, action, reason, details, approval_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(approval.id, approval.job_id, approval.task_id, approval.action,
           approval.reason, approval.details ? JSON.stringify(approval.details) : null,
           approval.status);
    return this.getApproval(approval.id)!;
  }

  // ---- Synthesis logs ----
  createSynthesisLog(log: { id: string; reference?: string; facts?: any; reply?: string; error?: string }): any {
    this.db.prepare(`
      INSERT INTO synth_logs (id, reference, facts, reply, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(log.id, log.reference || null, log.facts ? JSON.stringify(log.facts) : null, log.reply || null, log.error || null);
    return this.db.prepare('SELECT * FROM synth_logs WHERE id = ?').get(log.id);
  }

  // ---- Memory logs ----
  createMemoryLog(log: { id: string; reference?: string; fact?: string; source_tool?: string; source_output?: any; actor?: string; success?: number; error?: string }): any {
    this.db.prepare(`
      INSERT INTO memory_logs (id, reference, fact, source_tool, source_output, actor, success, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(log.id, log.reference || null, log.fact || null, log.source_tool || null, log.source_output ? JSON.stringify(log.source_output) : null, log.actor || null, log.success ?? 1, log.error || null);
    return this.db.prepare('SELECT * FROM memory_logs WHERE id = ?').get(log.id);
  }

  // ---- Agent session persistence ----
  saveAgentSessionState(sessionId: string, state: any): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_sessions (session_id, state, updated_at)
      VALUES (?, ?, strftime('%s','now'))
    `).run(sessionId, JSON.stringify(state));
  }

  getAgentSessionState(sessionId: string): any | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) as any;
    if (!row) return null;
    try {
      return JSON.parse(row.state);
    } catch {
      return null;
    }
  }

  // ---- Agent failure taxonomy logs ----
  createAgentFailure(log: { id: string; session_id?: string; turn_id?: string; kind: string; details?: any }): any {
    this.db.prepare(`
      INSERT INTO agent_failures (id, session_id, turn_id, kind, details)
      VALUES (?, ?, ?, ?, ?)
    `).run(log.id, log.session_id || null, log.turn_id || null, log.kind, log.details ? JSON.stringify(log.details) : null);
    return this.db.prepare('SELECT * FROM agent_failures WHERE id = ?').get(log.id);
  }

  listAgentFailures(sessionId?: string, limit = 100): any[] {
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const rows = sessionId
      ? this.db.prepare('SELECT * FROM agent_failures WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, safeLimit) as any[]
      : this.db.prepare('SELECT * FROM agent_failures ORDER BY created_at DESC LIMIT ?').all(safeLimit) as any[];
    return rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : undefined }));
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    if (!row) return null;
    return { ...row, status: row.approval_status, details: row.details ? JSON.parse(row.details) : undefined };
  }

  listPendingApprovals(): Approval[] {
    const rows = this.db.prepare(`SELECT * FROM approvals WHERE approval_status = 'pending' ORDER BY created_at ASC`).all() as any[];
    return rows.map(r => ({ ...r, status: r.approval_status, details: r.details ? JSON.parse(r.details) : undefined }));
  }

  resolveApproval(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare(`UPDATE approvals SET approval_status = ?, resolved_at = strftime('%s','now') WHERE id = ?`).run(status, id);
  }

  close(): void { this.db.close(); }
}

let dbInstance: JobDatabase | null = null;
export function getDatabase(): JobDatabase {
  if (!dbInstance) dbInstance = new JobDatabase();
  return dbInstance;
}
