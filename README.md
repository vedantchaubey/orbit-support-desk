# Orbit Support Desk

A responsive, full-stack customer support ticket CRM built for the DataStraw assessment. It includes ticket creation, searchable and filterable queues, ticket details, status and priority updates, internal notes, live queue metrics, and pagination.

## Stack

- Node.js + Express 5 REST API
- SQLite with `better-sqlite3`
- HTML, vanilla JavaScript, Tailwind CSS CDN, and custom responsive CSS
- Jest + Supertest API tests

## Features

- Create support tickets with customer name, email, title, description, and priority.
- Browse all tickets, sorted by priority (Urgent, High, Medium, Low) and then newest first.
- Search by ticket ID, customer name/email, or subject.
- Filter by status and priority, with server-side pagination.
- Open a ticket detail view, update status/priority, and append internal notes.
- Dashboard counters for total, open, in-progress, and urgent active tickets.
- Responsive mobile layout, keyboard-accessible ticket rows, Escape/backdrop modal close, form validation, and success/error feedback.

## Run locally

Use Node.js 20 or newer.

```bash
npm install
cp .env.example .env   # Windows PowerShell: Copy-Item .env.example .env
npm start
```

Open `http://localhost:3000`. The SQLite database is initialized automatically on first start. Set `DB_PATH` to choose a different database file. Set `PORT` if your host requires a specific port; the app uses the platform-provided `PORT` automatically.

## Tests

```bash
npm test -- --runInBand
```

The Jest/Supertest suite exercises ticket creation and validation, listing, search, filters, pagination headers, detail retrieval, updates, notes, and stats. Tests set `DB_PATH=:memory:` to avoid modifying the local database.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/tickets` | Create a ticket. Required JSON: `customer_name`, `customer_email`, `subject`; optional: `description`, `priority`. |
| `GET` | `/api/tickets?search=&status=&priority=&page=&limit=` | Search, filter, and paginate tickets. Returns a JSON array and `X-Total-Count`, `X-Page`, `X-Total-Pages` headers. |
| `GET` | `/api/tickets/:ticket_id` | Get ticket details and notes. |
| `PUT` | `/api/tickets/:ticket_id` | Update `status` and/or `priority`, and/or add a note using `notes`. |
| `GET` | `/api/stats` | Return ticket counts by status and urgent non-closed count. |

Allowed statuses: `Open`, `In Progress`, `Closed`. Allowed priorities: `Low`, `Medium`, `High`, `Urgent`.

## Deployment

Deploy the Node app to Railway or Render using the repository root, install command `npm install`, and start command `npm start`. The frontend is served by Express, so no separate frontend deployment/build is needed.

**SQLite persistence warning:** free/ephemeral hosting filesystems can reset on redeploy or restart. For a demo, SQLite is sufficient. For persistent hosted data, attach a persistent disk/volume and set `DB_PATH` to a file path on that mounted volume, or migrate to a managed database. Confirm the selected host's current free-tier and persistent-volume rules before deploying.

## Architecture and scope

The schema intentionally uses two tables: `tickets` and `notes`. Authentication, agent assignment, email notifications, and SLA automation are not included in this MVP, consistent with the assignment's instruction to keep authentication basic or omit it.

## AI/tool use

AI assistance was used to refine the interface and improve client-side error handling and validation. The API, schema, request/response behavior, and UI code should be reviewed and understood by the candidate before the walkthrough.

## Manage workspace

The dashboard includes a **Manage** workspace with a ticket operations table (open a ticket to edit status, priority, and internal notes). It does not include a team directory or user-access administration.

**Important:** Team roster entries are stored in the current browser's local storage. They are not user accounts and do not provide authentication, authorization, or shared team sync. Do not use the roster to grant real system access. Add server-side authentication and role-based authorization before exposing administration features to a production team.
