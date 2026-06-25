export interface MemoryUser {
  tenantId: string;
  userId: string;
  graphNodes: number;
  graphEdges: number;
  memoryChunks: number;
  evidence: number;
}

export interface UsersResponse {
  users: MemoryUser[];
  warnings: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  status: string;
  tenantId: string;
  userId: string;
  updatedAt: string;
  degree: number;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  relationType: string;
  confidence: number;
  status: string;
  tenantId: string;
  userId: string;
  updatedAt: string;
  properties: Record<string, unknown>;
}

export interface MemoryChunk {
  id: string;
  tenantId: string;
  userId: string;
  conversationId: string | null;
  rawTextPreview: string;
  memoryType: string;
  status: string;
  sourceType: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceItem {
  id: string;
  tenantId: string;
  userId: string;
  edgeId: string;
  memoryChunkId: string;
  quotePreview: string;
  confidence: number;
  createdAt: string;
}

export interface GraphFilters {
  relationTypes: string[];
  nodeTypes: string[];
  statuses: string[];
}

export interface GraphStats {
  nodes: number;
  edges: number;
  chunks: number;
  evidence: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: MemoryChunk[];
  evidence: EvidenceItem[];
  filters: GraphFilters;
  stats: GraphStats;
  warnings: string[];
}

export interface GraphQuery {
  tenantId: string;
  userId: string;
  status: string;
  relationType: string;
  search: string;
  limit: number;
}

export interface HealthResponse {
  status: string;
  checks: Record<string, { ok: boolean; configured: boolean; error?: string; database?: string }>;
}
