# Semantic Memory Visor

Semantic Memory Visor es una app independiente para inspeccionar visualmente el grafo y los registros de un motor de memoria semantica.

La app combina:

- Angular 18 para la interfaz.
- `vis-network` para dibujar grafos interactivos.
- Express como backend local.
- Neo4j para entidades y relaciones semanticas.
- PostgreSQL/Supabase para chunks, evidencia y eventos.

## Capacidades

- Filtrar por `tenantId`, `userId`, estado, tipo de relacion, texto y limite de resultados.
- Dibujar nodos `SemanticNode` y relaciones `SEMANTIC_EDGE` desde Neo4j.
- Mostrar chunks recientes desde PostgreSQL.
- Ver estado de conexion a Neo4j y Postgres.
- Inspeccionar propiedades crudas de nodos y relaciones seleccionadas.
- Servir frontend y API desde el mismo proceso Node en produccion.

## Variables de entorno

Copia el ejemplo:

```bash
cp .env.example .env
```

Configura:

```env
PORT=4300
HOST=127.0.0.1

NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
NEO4J_USERNAME=your-username
NEO4J_PASSWORD=your-password
NEO4J_DATABASE=your-database

POSTGRES_CONNECTION_STRING=postgresql://user:password@host:5432/postgres
POSTGRES_SSL=true
```

Para Docker o Coolify usa:

```env
HOST=0.0.0.0
PORT=4300
```

Para Neo4j Aura usa siempre:

```env
NEO4J_URI=neo4j+s://your-instance.databases.neo4j.io
```

Si el deploy queda con `neo4j://...databases.neo4j.io`, el driver puede fallar con `No routing servers available`. El visor normaliza automaticamente hosts de Aura a `neo4j+s://`, pero conviene dejar la variable correcta en Coolify.

No guardes credenciales reales en git.

## Desarrollo

Instala dependencias:

```bash
npm install
```

Levanta el API:

```bash
npm run start:api
```

En otra terminal levanta Angular:

```bash
npm run start:web
```

Abre:

```text
http://localhost:4200
```

El proxy de Angular envia `/api/*` a `http://localhost:4300`.

## Produccion local

Compila Angular:

```bash
npm run build
```

Sirve frontend y API desde Express:

```bash
npm start
```

Abre:

```text
http://localhost:4300
```

## Endpoints

```http
GET /api/health
GET /api/users
GET /api/graph?tenantId=default&userId=Juan&status=Active&limit=150
```

`/api/graph` devuelve:

- `nodes`: nodos preparados para el visor.
- `edges`: relaciones semanticas.
- `chunks`: textos recientes desde Postgres.
- `evidence`: evidencia asociada si existe.
- `filters`: opciones disponibles para filtros.
- `stats`: conteos visibles.
- `warnings`: errores no fatales de una fuente de datos.

## Docker

Construir:

```bash
docker build -t semantic-memory-visor .
```

Ejecutar:

```bash
docker run --rm -p 4300:4300 --env-file .env semantic-memory-visor
```

## Nota sobre datos

Neo4j contiene el grafo semantico:

```text
(:SemanticNode)-[:SEMANTIC_EDGE]->(:SemanticNode)
```

PostgreSQL contiene:

```text
memory_chunks
evidence
memory_events
```

Si hay chunks pero no nodos/aristas, el visor mostrara los chunks y dejara el grafo vacio. Eso normalmente significa que la ingesta guardo texto, pero el extractor no produjo hechos semanticos.
