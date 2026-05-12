# Deployment

## Docker

### Multi-Stage Build

The `Dockerfile` uses a two-stage build:

**Stage 1 — Frontend build:**
- Base: `node:20-alpine`
- Installs frontend dependencies and runs `npm run build`
- Produces static assets in `dist/`

**Stage 2 — Production runtime:**
- Base: `node:20-alpine`
- Installs `postgresql-client` (for migrations in entrypoint)
- Installs backend dependencies with native build tools (`python3`, `make`, `g++`), then removes build tools
- Copies built frontend from Stage 1
- Copies backend source, config, migrations, seeders, and scripts
- Sets `NODE_ENV=production`, exposes port `3000`

**Entrypoint** (`deploy/docker-entrypoint.sh`):
1. Waits for PostgreSQL to be ready (polls `pg_isready` every 2 seconds)
2. Runs database migrations (`npx sequelize-cli db:migrate`)
3. Starts the application (`node src/backend/server.js`)

### Build and Run

```bash
# Build
docker build -t asap-kr-sync .

# Run
docker run -p 3000:3000 --env-file .env asap-kr-sync
```

## Docker Compose (Local Development)

`docker-compose.yml` provides optional local services:

### MinIO (S3-Compatible Storage)

```bash
docker-compose up -d minio
```

- **API**: http://localhost:9000
- **Console**: http://localhost:9001
- **Credentials**: `minioadmin` / `minioadmin`
- Auto-creates the `asap-kr-sync` bucket on first start via the `minio-init` service

### PostgreSQL (Optional)

```bash
docker-compose --profile with-postgres up -d
```

- **Port**: 5432
- **Credentials**: `postgres` / `postgres`
- **Database**: `asap_krsync_dev`
- Only starts with the `with-postgres` profile flag

## Systemd

Two systemd service files are provided in `deploy/`:

- `asap-kr-sync-dev.service` — Development instance (port 3000)
- `asap-kr-sync-prod.service` — Production instance (port 3001)

Both services:
- Depend on `docker.service` and `postgresql.service`
- Stop and remove any existing container before starting (clean start)
- Map `host.docker.internal` to the host gateway (for accessing host services from the container)
- Mount environment file from `/opt/asap-kr-sync-{dev|prod}/.env`
- Mount credentials directory (read-only) from `/opt/asap-kr-sync-{dev|prod}/credentials/`
- Mount logs directory from `/opt/asap-kr-sync-{dev|prod}/logs/`
- Bind to `127.0.0.1` only (use a reverse proxy for external access)
- Restart automatically with a 10-second delay

### Installation

```bash
# Copy service file
sudo cp deploy/asap-kr-sync-dev.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable asap-kr-sync-dev
sudo systemctl start asap-kr-sync-dev

# Monitor
sudo systemctl status asap-kr-sync-dev
sudo journalctl -u asap-kr-sync-dev -f
```

### Directory Structure on Server

```
/opt/asap-kr-sync-{dev|prod}/
├── .env                    # Environment variables
├── credentials/            # Service account keys (mounted read-only, optional)
├── backend/data/           # Local data (prompt files, demo findings)
├── src/frontend/public/demo-files/   # Demo manuscripts dropped in manually
└── logs/                   # Application logs
    └── app.log
```

The `credentials/` directory is mounted read-only into the container, but there are no committed credentials in the repo today — Auth0 secrets come from AWS Secrets Manager (`AUTH0_SECRET_ID`), AWS S3 uses the EC2 instance role, and there is no Google Sheets integration. The directory is reserved for future provider keys if needed.

## Application Startup Sequence

1. Load environment variables (`.env` cascade: `.env` → `.env.local` → `.env.{NODE_ENV}` → `.env.{NODE_ENV}.local`)
2. Connect to PostgreSQL (Sequelize authenticate)
3. Load application configuration from database
4. Initialize pg-boss job queue
5. Register job workers
6. Start HTTP server on configured port

## Graceful Shutdown

On `SIGTERM` or `SIGINT`:

1. Stop accepting new HTTP connections
2. Stop pg-boss job queue (waits for in-flight jobs, up to 30 seconds)
3. Close database connection pool
4. Force exit after 30 seconds if not complete

## Express Middleware Stack

The production server serves both the API and the built frontend:

1. **Helmet** — security headers
2. **CORS** — allows `FRONTEND_URL` origin
3. **Body parsing** — JSON and URL-encoded (10MB limit)
4. **Morgan** — request logging (`dev` or `combined` format)
5. **Health check** — `GET /health` returns 200
6. **API routes** — `/api/*`
7. **Static files** — serves Vue SPA from `src/frontend/dist/`
8. **SPA fallback** — returns `index.html` for client-side routing
9. **Error handler** — centralized error middleware

## Static Configuration

`conf/rate-limits.json` defines rate-limit rules loaded at startup. See [Authentication](./authentication.md) for details.
