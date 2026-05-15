export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  version: number;
  createdBy: string;
  tags: string[];
}

export interface ToolRegistryEntry extends ToolDefinition {
  id: number;
  filePath: string;
  createdAt: string;
  updatedAt: string;
}
