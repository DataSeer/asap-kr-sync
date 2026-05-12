# Getting Started

## Prerequisites

- **Node.js** 20+ (required)
- **PostgreSQL** 15+ (local or Docker)
- **Docker & Docker Compose** (recommended for local services)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd asap-kr-sync

# Install all dependencies (root, backend, frontend)
npm install
```

## Configuration

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your values. See [Environment Variables](./environment-variables.md) for the full reference.

3. At minimum, configure:
   - `DATABASE_URL` — PostgreSQL connection string
   - `JWT_SECRET` — A strong random string
   - `AWS_*` / `S3_*` — S3 credentials (or use MinIO locally)

## Local Services (MinIO + optional PostgreSQL)

Start S3-compatible storage (and optionally PostgreSQL) with Docker:

```bash
# MinIO only (use your own PostgreSQL)
docker-compose up -d minio

# MinIO + PostgreSQL
docker-compose --profile with-postgres up -d
```

- **MinIO Console**: http://localhost:9001 (minioadmin / minioadmin)
- **MinIO API**: http://localhost:9000
- **PostgreSQL** (if using Docker): localhost:5432

## Database Setup

```bash
# Run all migrations
npm run migrate

# (Optional) Seed demo data
npm run seed
```

To reset the database:

```bash
# Full reset (drops and recreates all tables + seeds)
npm run db:reset

# Reset but preserve user accounts
npm run db:reset:preserve-users
```

## Running the Application

```bash
# Development (concurrent backend + frontend with hot reload)
npm run dev
```

This starts:
- **Backend API** on http://localhost:3000
- **Frontend dev server** on http://localhost:5173 (proxies `/api` to backend)

### Run backend or frontend individually

```bash
# Backend only
cd src/backend && npm run dev

# Frontend only
cd src/frontend && npm run dev
```

## Production Build

```bash
# Build frontend
npm run build

# Start production server (serves API + built frontend)
cd src/backend && npm start
```

See [Deployment](./deployment.md) for Docker and systemd instructions.

## Available npm Scripts

### Root

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both backend and frontend in dev mode |
| `npm run build` | Build the frontend for production |
| `npm run migrate` | Run pending database migrations |
| `npm run migrate:undo` | Revert the last migration |
| `npm run db:init` | Initialize the database (migrate + seed) |
| `npm run db:reset` | Drop all tables, re-migrate, and re-seed |
| `npm run db:reset:preserve-users` | Reset but keep user accounts |
| `npm run seed` | Run database seeders |
| `npm test` | Run all tests |
| `npm run lint` | Lint all code |

### Backend (`src/backend/`)

| Script | Description |
|--------|-------------|
| `npm start` | Start production server |
| `npm run dev` | Start with nodemon (auto-restart) |
| `npm run migrate` | Run migrations via sequelize-cli |
| `npm run seed` | Run seeders |
| `npm run db:create` | Create the database |
| `npm run db:drop` | Drop the database |
| `npm test` | Run backend tests |

### Frontend (`src/frontend/`)

| Script | Description |
|--------|-------------|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run lint` | ESLint check |
| `npm test` | Vitest tests |
