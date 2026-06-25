import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT ?? 4300);
const host = process.env.HOST ?? '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserDist = path.resolve(__dirname, '../dist/semantic-memory-visor/browser');

app.use(express.json());

const neo4jConfig = {
  uri: normalizeNeo4jUri(process.env.NEO4J_URI),
  username: process.env.NEO4J_USERNAME ?? process.env.NEO4J_USER,
  password: process.env.NEO4J_PASSWORD,
  database: process.env.NEO4J_DATABASE ?? 'neo4j'
};

const neo4jDriver = neo4jConfig.uri && neo4jConfig.username && neo4jConfig.password
  ? neo4j.driver(neo4jConfig.uri, neo4j.auth.basic(neo4jConfig.username, neo4jConfig.password))
  : null;

const postgresConnectionString = process.env.POSTGRES_CONNECTION_STRING;
const postgresPool = postgresConnectionString
  ? new Pool({
      connectionString: postgresConnectionString,
      ssl: resolvePostgresSsl(postgresConnectionString)
    })
  : null;

app.get('/api/health', async (_req, res) => {
  const checks = {
    neo4j: await checkNeo4j(),
    postgres: await checkPostgres()
  };

  res.json({
    status: checks.neo4j.ok || checks.postgres.ok ? 'ok' : 'degraded',
    checks
  });
});

app.get('/api/users', async (_req, res) => {
  const warnings = [];
  const users = new Map();

  try {
    for (const row of await loadNeo4jUsers()) {
      const key = `${row.tenantId}::${row.userId}`;
      users.set(key, { ...row, graphNodes: row.nodes, graphEdges: row.edges, memoryChunks: 0, evidence: 0 });
    }
  } catch (error) {
    warnings.push(toWarning('Neo4j users unavailable', error));
  }

  try {
    for (const row of await loadPostgresUsers()) {
      const key = `${row.tenantId}::${row.userId}`;
      const existing = users.get(key) ?? {
        tenantId: row.tenantId,
        userId: row.userId,
        graphNodes: 0,
        graphEdges: 0,
        memoryChunks: 0,
        evidence: 0
      };

      existing.memoryChunks = row.memoryChunks;
      existing.evidence = row.evidence;
      users.set(key, existing);
    }
  } catch (error) {
    warnings.push(toWarning('Postgres users unavailable', error));
  }

  res.json({
    users: Array.from(users.values()).sort((a, b) =>
      (b.graphEdges + b.memoryChunks) - (a.graphEdges + a.memoryChunks)),
    warnings
  });
});

app.get('/api/graph', async (req, res) => {
  const filters = normalizeFilters(req.query);
  const warnings = [];
  let graph = emptyGraph();
  let chunks = [];
  let evidence = [];
  let filterOptions = { relationTypes: [], nodeTypes: [], statuses: ['Active', 'Superseded', 'Forgotten'] };

  try {
    graph = await loadNeo4jGraph(filters);
    filterOptions = await loadNeo4jFilterOptions(filters);
  } catch (error) {
    warnings.push(toWarning('Neo4j graph unavailable', error));
  }

  try {
    chunks = await loadPostgresChunks(filters);
    evidence = await loadPostgresEvidence(filters, graph.edges.map(edge => edge.id));
  } catch (error) {
    warnings.push(toWarning('Postgres memory unavailable', error));
  }

  res.json({
    ...graph,
    chunks,
    evidence,
    filters: filterOptions,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      chunks: chunks.length,
      evidence: evidence.length
    },
    warnings
  });
});

app.use(express.static(browserDist));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }

  res.sendFile(path.join(browserDist, 'index.html'), error => {
    if (error) {
      res.status(404).send('Build the Angular app first with npm run build.');
    }
  });
});

async function checkNeo4j() {
  if (!neo4jDriver) {
    return { ok: false, configured: false };
  }

  try {
    await neo4jDriver.verifyConnectivity();
    return {
      ok: true,
      configured: true,
      database: neo4jConfig.database,
      uri: describeNeo4jUri(neo4jConfig.uri)
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      database: neo4jConfig.database,
      uri: describeNeo4jUri(neo4jConfig.uri),
      error: error.message
    };
  }
}

async function checkPostgres() {
  if (!postgresPool) {
    return { ok: false, configured: false };
  }

  try {
    await postgresPool.query('select 1');
    return { ok: true, configured: true };
  } catch (error) {
    return { ok: false, configured: true, error: error.message };
  }
}

async function loadNeo4jUsers() {
  if (!neo4jDriver) {
    return [];
  }

  const session = neo4jDriver.session({ database: neo4jConfig.database });
  try {
    const result = await session.run(`
      MATCH (n:SemanticNode)
      WITH n.tenantId AS tenantId, n.userId AS userId, count(n) AS nodes
      OPTIONAL MATCH (:SemanticNode)-[r:SEMANTIC_EDGE]->(:SemanticNode)
      WHERE r.tenantId = tenantId
        AND r.userId = userId
      RETURN tenantId, userId, nodes, count(r) AS edges
      ORDER BY nodes DESC
      LIMIT 50
    `);

    return result.records.map(record => ({
      tenantId: record.get('tenantId'),
      userId: record.get('userId'),
      nodes: toNumber(record.get('nodes')),
      edges: toNumber(record.get('edges'))
    }));
  } finally {
    await session.close();
  }
}

async function loadPostgresUsers() {
  if (!postgresPool) {
    return [];
  }

  const result = await postgresPool.query(`
    SELECT mc.tenant_id,
           mc.user_id,
           count(DISTINCT mc.id)::int AS memory_chunks,
           count(DISTINCT e.id)::int AS evidence
    FROM memory_chunks mc
    LEFT JOIN evidence e
      ON e.tenant_id = mc.tenant_id
     AND e.user_id = mc.user_id
     AND e.memory_chunk_id = mc.id
    GROUP BY mc.tenant_id, mc.user_id
    ORDER BY memory_chunks DESC
    LIMIT 50
  `);

  return result.rows.map(row => ({
    tenantId: row.tenant_id,
    userId: row.user_id,
    memoryChunks: Number(row.memory_chunks),
    evidence: Number(row.evidence)
  }));
}

async function loadNeo4jGraph(filters) {
  if (!neo4jDriver) {
    return emptyGraph();
  }

  const params = {
    tenantId: filters.tenantId,
    userId: filters.userId,
    status: filters.status,
    relationType: filters.relationType,
    search: filters.search.toLowerCase(),
    limit: neo4j.int(filters.limit)
  };
  const session = neo4jDriver.session({ database: neo4jConfig.database });

  try {
    const edgeResult = await session.run(`
      MATCH (s:SemanticNode)-[r:SEMANTIC_EDGE]->(o:SemanticNode)
      WHERE ($tenantId = '' OR r.tenantId = $tenantId)
        AND ($userId = '' OR r.userId = $userId)
        AND ($status = 'All' OR r.status = $status)
        AND ($relationType = '' OR r.relationType = $relationType)
        AND (
          $search = ''
          OR toLower(coalesce(s.canonicalName, '')) CONTAINS $search
          OR toLower(coalesce(o.canonicalName, '')) CONTAINS $search
          OR toLower(coalesce(r.relationType, '')) CONTAINS $search
        )
      RETURN s, r, o
      ORDER BY coalesce(r.updatedAt, r.createdAt) DESC
      LIMIT $limit
    `, params);

    const nodeResult = await session.run(`
      MATCH (n:SemanticNode)
      WHERE ($tenantId = '' OR n.tenantId = $tenantId)
        AND ($userId = '' OR n.userId = $userId)
        AND ($status = 'All' OR n.status = $status)
        AND (
          $search = ''
          OR toLower(coalesce(n.canonicalName, '')) CONTAINS $search
          OR toLower(coalesce(n.type, '')) CONTAINS $search
          OR toLower(coalesce(n.normalizedKey, '')) CONTAINS $search
        )
      RETURN n
      ORDER BY coalesce(n.updatedAt, n.createdAt) DESC
      LIMIT $limit
    `, params);

    const nodes = new Map();
    const edges = [];

    for (const record of nodeResult.records) {
      const node = mapNeo4jNode(record.get('n'));
      nodes.set(node.id, node);
    }

    for (const record of edgeResult.records) {
      const source = mapNeo4jNode(record.get('s'));
      const target = mapNeo4jNode(record.get('o'));
      const edge = mapNeo4jEdge(record.get('r'), source.id, target.id);

      nodes.set(source.id, source);
      nodes.set(target.id, target);
      edges.push(edge);
    }

    for (const edge of edges) {
      const source = nodes.get(edge.from);
      const target = nodes.get(edge.to);
      if (source) source.degree += 1;
      if (target) target.degree += 1;
    }

    return { nodes: Array.from(nodes.values()), edges };
  } finally {
    await session.close();
  }
}

async function loadNeo4jFilterOptions(filters) {
  if (!neo4jDriver) {
    return { relationTypes: [], nodeTypes: [], statuses: ['Active', 'Superseded', 'Forgotten'] };
  }

  const session = neo4jDriver.session({ database: neo4jConfig.database });
  const params = { tenantId: filters.tenantId, userId: filters.userId };

  try {
    const relationTypes = await session.run(`
      MATCH ()-[r:SEMANTIC_EDGE]->()
      WHERE ($tenantId = '' OR r.tenantId = $tenantId)
        AND ($userId = '' OR r.userId = $userId)
      RETURN DISTINCT r.relationType AS value
      ORDER BY value
    `, params);

    const nodeTypes = await session.run(`
      MATCH (n:SemanticNode)
      WHERE ($tenantId = '' OR n.tenantId = $tenantId)
        AND ($userId = '' OR n.userId = $userId)
      RETURN DISTINCT n.type AS value
      ORDER BY value
    `, params);

    const statuses = await session.run(`
      MATCH (n:SemanticNode)
      WHERE ($tenantId = '' OR n.tenantId = $tenantId)
        AND ($userId = '' OR n.userId = $userId)
      RETURN DISTINCT n.status AS value
      ORDER BY value
    `, params);

    return {
      relationTypes: relationTypes.records.map(record => record.get('value')).filter(Boolean),
      nodeTypes: nodeTypes.records.map(record => record.get('value')).filter(Boolean),
      statuses: statuses.records.map(record => record.get('value')).filter(Boolean)
    };
  } finally {
    await session.close();
  }
}

async function loadPostgresChunks(filters) {
  if (!postgresPool) {
    return [];
  }

  const result = await postgresPool.query(`
    SELECT id,
           tenant_id,
           user_id,
           conversation_id,
           left(raw_text, 420) AS raw_text_preview,
           memory_type,
           status,
           source_type,
           importance,
           created_at,
           updated_at
    FROM memory_chunks
    WHERE ($1 = '' OR tenant_id = $1)
      AND ($2 = '' OR user_id = $2)
      AND ($3 = 'All' OR status = $3)
      AND ($4 = '' OR raw_text ILIKE '%' || $4 || '%')
    ORDER BY created_at DESC
    LIMIT $5
  `, [filters.tenantId, filters.userId, filters.status, filters.search, Math.min(filters.limit, 100)]);

  return result.rows.map(row => ({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    rawTextPreview: row.raw_text_preview,
    memoryType: row.memory_type,
    status: row.status,
    sourceType: row.source_type,
    importance: Number(row.importance),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

async function loadPostgresEvidence(filters, edgeIds) {
  if (!postgresPool) {
    return [];
  }

  if (edgeIds.length > 0) {
    const result = await postgresPool.query(`
      SELECT id,
             tenant_id,
             user_id,
             edge_id,
             memory_chunk_id,
             left(coalesce(quote, ''), 420) AS quote_preview,
             confidence,
             created_at
      FROM evidence
      WHERE edge_id = ANY($1::uuid[])
      ORDER BY created_at DESC
      LIMIT 100
    `, [edgeIds]);

    return result.rows.map(mapEvidenceRow);
  }

  const result = await postgresPool.query(`
    SELECT id,
           tenant_id,
           user_id,
           edge_id,
           memory_chunk_id,
           left(coalesce(quote, ''), 420) AS quote_preview,
           confidence,
           created_at
    FROM evidence
    WHERE ($1 = '' OR tenant_id = $1)
      AND ($2 = '' OR user_id = $2)
    ORDER BY created_at DESC
    LIMIT 100
  `, [filters.tenantId, filters.userId]);

  return result.rows.map(mapEvidenceRow);
}

function mapEvidenceRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    edgeId: row.edge_id,
    memoryChunkId: row.memory_chunk_id,
    quotePreview: row.quote_preview,
    confidence: Number(row.confidence),
    createdAt: row.created_at
  };
}

function normalizeFilters(query) {
  return {
    tenantId: asText(query.tenantId),
    userId: asText(query.userId),
    status: asText(query.status) || 'Active',
    relationType: asText(query.relationType),
    search: asText(query.search),
    limit: clamp(Number(query.limit ?? 150), 10, 500)
  };
}

function mapNeo4jNode(node) {
  const properties = normalizeNeo4jValue(node.properties);
  return {
    id: properties.id ?? node.elementId,
    label: properties.canonicalName ?? properties.normalizedKey ?? properties.id ?? node.elementId,
    type: properties.type ?? 'Unknown',
    status: properties.status ?? 'Unknown',
    tenantId: properties.tenantId ?? '',
    userId: properties.userId ?? '',
    updatedAt: properties.updatedAt ?? properties.createdAt ?? '',
    degree: 0,
    properties
  };
}

function mapNeo4jEdge(edge, from, to) {
  const properties = normalizeNeo4jValue(edge.properties);
  return {
    id: properties.id ?? edge.elementId,
    from,
    to,
    label: properties.relationType ?? edge.type,
    relationType: properties.relationType ?? edge.type,
    confidence: Number(properties.confidence ?? 0),
    status: properties.status ?? 'Unknown',
    tenantId: properties.tenantId ?? '',
    userId: properties.userId ?? '',
    updatedAt: properties.updatedAt ?? properties.createdAt ?? '',
    properties
  };
}

function normalizeNeo4jValue(value) {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeNeo4jValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeNeo4jValue(entry)]));
  }

  return value;
}

function resolvePostgresSsl(connectionString) {
  if (process.env.POSTGRES_SSL === 'false') {
    return false;
  }

  if (process.env.POSTGRES_SSL === 'true') {
    return { rejectUnauthorized: false };
  }

  try {
    const host = new URL(connectionString).hostname;
    return host === 'localhost' || host === '127.0.0.1' ? false : { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

function normalizeNeo4jUri(rawUri) {
  if (!rawUri || !rawUri.trim()) {
    return undefined;
  }

  const trimmedUri = rawUri.trim();

  try {
    const uri = new URL(trimmedUri);

    if (!uri.hostname.endsWith('.databases.neo4j.io') || uri.protocol === 'neo4j+s:') {
      return trimmedUri;
    }

    const port = uri.port ? `:${uri.port}` : '';
    const path = uri.pathname === '/' ? '' : uri.pathname;

    return `neo4j+s://${uri.hostname}${port}${path}${uri.search}`;
  } catch {
    return trimmedUri;
  }
}

function describeNeo4jUri(uri) {
  if (!uri) {
    return undefined;
  }

  try {
    const parsed = new URL(uri);
    return {
      scheme: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parsed.port || undefined
    };
  } catch {
    return { raw: 'invalid-uri-format' };
  }
}

function emptyGraph() {
  return { nodes: [], edges: [] };
}

function asText(value) {
  return Array.isArray(value) ? String(value[0] ?? '').trim() : String(value ?? '').trim();
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function toNumber(value) {
  return neo4j.isInt(value) ? value.toNumber() : Number(value ?? 0);
}

function toWarning(message, error) {
  return `${message}: ${error.message}`;
}

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

async function shutdown() {
  await Promise.all([
    neo4jDriver?.close(),
    postgresPool?.end()
  ]);
}

app.listen(port, host, () => {
  console.log(`Semantic Memory Visor listening on http://${host}:${port}`);
});
