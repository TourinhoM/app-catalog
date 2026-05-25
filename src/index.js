'use strict'

const Fastify = require('fastify')
const { Pool } = require('pg')
const promClient = require('prom-client')

// --- Métricas ---
promClient.collectDefaultMetrics()
const httpDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
})

// --- App ---
const app = Fastify({ logger: true })

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function initDb () {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}

// Hook de duração para todas as rotas
app.addHook('onResponse', (req, reply, done) => {
  httpDuration
    .labels(req.method, req.routeOptions?.url ?? req.url, reply.statusCode)
    .observe(reply.elapsedTime / 1000)
  done()
})

// --- Rotas de plataforma ---
app.get('/health', async () => ({ status: 'ok' }))

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', promClient.register.contentType)
  return promClient.register.metrics()
})

// --- CRUD /items ---
app.get('/items', async () => {
  const { rows } = await pool.query('SELECT * FROM items ORDER BY created_at DESC')
  return rows
})

app.post('/items', {
  schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } }
}, async (req, reply) => {
  const { name, description = null } = req.body
  const { rows } = await pool.query(
    'INSERT INTO items (name, description) VALUES ($1, $2) RETURNING *',
    [name, description]
  )
  return reply.status(201).send(rows[0])
})

app.get('/items/:id', async (req, reply) => {
  const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id])
  if (!rows.length) return reply.status(404).send({ error: 'not found' })
  return rows[0]
})

app.put('/items/:id', {
  schema: { body: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } } }
}, async (req, reply) => {
  const { name, description } = req.body
  const { rows } = await pool.query(
    'UPDATE items SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3 RETURNING *',
    [name, description, req.params.id]
  )
  if (!rows.length) return reply.status(404).send({ error: 'not found' })
  return rows[0]
})

app.delete('/items/:id', async (req, reply) => {
  const result = await pool.query('DELETE FROM items WHERE id = $1', [req.params.id])
  if (!result.rowCount) return reply.status(404).send({ error: 'not found' })
  return reply.status(204).send()
})

// --- Start ---
const start = async () => {
  await initDb()
  await app.listen({ port: parseInt(process.env.PORT ?? '3000'), host: '0.0.0.0' })
}

start().catch(err => {
  app.log.error(err)
  process.exit(1)
})
