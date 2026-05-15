export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'killed';

export interface AgentConfig {
  id: string;
  name: string;
  taskId: string;
  tools: string[];
  systemPrompt?: string;
}

export interface AgentHandle {
  id: string;
  pid: number;
  status: AgentStatus;
  taskId: string;
  startedAt: string;
}
