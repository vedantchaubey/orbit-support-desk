const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateTicketId() {
  // Derive from the greatest numeric suffix, not the last inserted row. The
  // create transaction below serializes writers before this is called.
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(ticket_id, 5) AS INTEGER)) AS max_num
    FROM tickets WHERE ticket_id GLOB 'TKT-[0-9]*'`).get();
  return `TKT-${String((row?.max_num || 0) + 1).padStart(3, '0')}`;
}

const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

// POST /api/tickets — create a ticket
app.post('/api/tickets', (req, res) => {
  let { customer_name, customer_email, subject, description, priority } = req.body || {};
  customer_name = typeof customer_name === 'string' ? customer_name.trim() : '';
  customer_email = typeof customer_email === 'string' ? customer_email.trim().toLowerCase() : '';
  subject = typeof subject === 'string' ? subject.trim() : '';
  description = typeof description === 'string' ? description.trim() : '';
  if (!customer_name || !customer_email || !subject) {
    return res.status(400).json({ error: 'Customer name, a valid email, and issue title are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email)) {
    return res.status(400).json({ error: 'Please provide a valid customer email' });
  }
  if (customer_name.length > 120 || customer_email.length > 254 || subject.length > 180 || description.length > 10000) {
    return res.status(400).json({ error: 'One or more fields exceed the allowed length' });
  }
  if (priority && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  const idempotencyKey = req.get('Idempotency-Key');
  if (idempotencyKey && (idempotencyKey.length > 200 || !/^[\w:.\-]+$/.test(idempotencyKey))) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key' });
  }
  try {
    const createTicket = db.transaction(() => {
      if (idempotencyKey) {
        const prior = db.prepare('SELECT ticket_id, created_at FROM ticket_requests WHERE request_key = ?').get(idempotencyKey);
        if (prior) return { ...prior, replay: true };
      }
      const ticket_id = generateTicketId();
      db.prepare(`INSERT INTO tickets (ticket_id, customer_name, customer_email, subject, description, priority)
        VALUES (?, ?, ?, ?, ?, ?)`).run(ticket_id, customer_name, customer_email, subject, description || '', priority || 'Medium');
      const created = db.prepare('SELECT created_at FROM tickets WHERE ticket_id = ?').get(ticket_id);
      if (idempotencyKey) db.prepare('INSERT INTO ticket_requests (request_key, ticket_id, created_at) VALUES (?, ?, ?)').run(idempotencyKey, ticket_id, created.created_at);
      return { ticket_id, created_at: created.created_at, replay: false };
    }).immediate();
    res.status(createTicket.replay ? 200 : 201).json({ ticket_id: createTicket.ticket_id, created_at: createTicket.created_at, ...(createTicket.replay ? { idempotent_replay: true } : {}) });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ticket already exists; retry the request with the same Idempotency-Key' });
    throw err;
  }
});

// GET /api/stats — counts for the dashboard bar
app.get('/api/stats', (req, res) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) as count FROM tickets GROUP BY status`).all();
  const urgent = db.prepare(`SELECT COUNT(*) as count FROM tickets WHERE priority = 'Urgent' AND status != 'Closed'`).get();
  const total = db.prepare(`SELECT COUNT(*) as count FROM tickets`).get();
  const stats = { total: total.count, open: 0, in_progress: 0, closed: 0, urgent_open: urgent.count };
  for (const row of byStatus) {
    if (row.status === 'Open') stats.open = row.count;
    if (row.status === 'In Progress') stats.in_progress = row.count;
    if (row.status === 'Closed') stats.closed = row.count;
  }
  res.json(stats);
});

// GET /api/tickets — list, with optional ?status=, ?priority=, ?search=, ?page=, ?limit=
// Sorted by urgency first (Urgent > High > Medium > Low), then newest — so a
// triage queue surfaces what needs attention, which matters once volume is high.
// Response body stays a plain array (per spec); pagination metadata rides in headers
// so existing consumers of the endpoint don't break.
app.get('/api/tickets', (req, res) => {
  const { status, priority, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;

  const source = `(SELECT * FROM (SELECT tickets.*, ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY id ASC) AS duplicate_rank FROM tickets) WHERE duplicate_rank = 1)`;
  let where = ` WHERE 1=1`;
  const params = [];

  if (status) {
    where += ` AND status = ?`;
    params.push(status);
  }
  if (priority) {
    where += ` AND priority = ?`;
    params.push(priority);
  }
  if (search) {
    where += ` AND (customer_name LIKE ? OR customer_email LIKE ? OR ticket_id LIKE ? OR subject LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM ${source}${where}`).get(...params).count;

  const query = `
    SELECT ticket_id, customer_name, customer_email, subject, status, priority, created_at
    FROM ${source}${where}
    ORDER BY
      CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
      created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(query).all(...params, limit, offset);

  res.set('X-Total-Count', String(total));
  res.set('X-Page', String(page));
  res.set('X-Total-Pages', String(Math.max(1, Math.ceil(total / limit))));
  res.json(rows);
});

// GET /api/tickets/:ticket_id — detail + notes
app.get('/api/tickets/:ticket_id', (req, res) => {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE ticket_id = ? ORDER BY id ASC LIMIT 1`).get(req.params.ticket_id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const notes = db.prepare(`SELECT id, note_text, created_at FROM notes WHERE ticket_id = ? ORDER BY created_at DESC`).all(req.params.ticket_id);
  res.json({ ...ticket, notes });
});

// PUT /api/tickets/:ticket_id — update status and/or add a note
app.put('/api/tickets/:ticket_id', (req, res) => {
  const ticket = db.prepare(`SELECT * FROM tickets WHERE ticket_id = ? ORDER BY id ASC LIMIT 1`).get(req.params.ticket_id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const { status, priority } = req.body || {};
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  if (notes.length > 2000) return res.status(400).json({ error: 'Notes must be 2,000 characters or fewer' });
  if (status && !['Open', 'In Progress', 'Closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (priority && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: 'Invalid priority' });
  }
  if (status || priority) {
    const fields = [];
    const vals = [];
    if (status) { fields.push('status = ?'); vals.push(status); }
    if (priority) { fields.push('priority = ?'); vals.push(priority); }
    fields.push(`updated_at = datetime('now')`);
    vals.push(ticket.id);
    db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  } else {
    db.prepare(`UPDATE tickets SET updated_at = datetime('now') WHERE id = ?`).run(ticket.id);
  }

  if (notes) {
    db.prepare(`INSERT INTO notes (ticket_id, note_text) VALUES (?, ?)`).run(req.params.ticket_id, notes);
  }

  const updated = db.prepare(`SELECT updated_at FROM tickets WHERE id = ?`).get(ticket.id);
  res.json({ success: true, updated_at: updated.updated_at });
});

// Fallback for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler — catches anything thrown synchronously in a route
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Support CRM running on port ${PORT}`));
}

module.exports = app;
