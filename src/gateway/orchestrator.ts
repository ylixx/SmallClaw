// ARCHIVED — Legacy orchestrator (manager → executor → verifier pipeline).
// Superseded by src/agents/reactor.ts + src/orchestration/multi-agent.ts.
// Kept as an empty module so any stale imports compile without errors.

// Minimal compatibility shim: server-legacy.ts still instantiates
// AgentOrchestrator at module load. The instance is never used afterwards,
// so an empty class is sufficient to keep the legacy module loadable.
export class AgentOrchestrator {}
