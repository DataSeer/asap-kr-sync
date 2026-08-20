# Deployment

## Docker

### Multi-Stage Build

The `Dockerfile` uses a **three-stage** build, all on `node:20-slim`:

**Stage 1 (`deps`)** — installs the workspace dependencies with `npm ci`.

**Stage 2 (`build`)** — builds the frontend into `dist/`.

**Stage 3 (runtime)** — copies the installed tree and the built assets, adds
the backend source, config, migrations, seeders and scripts, creates a system
`app` user and runs as it (`USER app`), and exposes port `3000`.

> **`NODE_ENV` is NOT set in the image.** One image serves both the dev and prod
> systemd units, so the environment comes from the unit's `--env-file` on the
> host. That matters more than it looks: `src/backend/server.js` only enforces
> its production guards (a `JWT_SECRET` of at least 32 characters, an `https`
> `FRONTEND_URL`) when `NODE_ENV=production`, and `error.middleware.js` only
> collapses unknown errors to "Internal server error" in that mode — otherwise
> the raw message reaches the client. `utils/logger.js` likewise adds its file
> transports only in production. If the host env file is missing the line, all
> three degrade silently.
>
> One deliberate mitigation: the `Secure` cookie flag does not depend on it —
> `auth.controller.js` also accepts an `https` `FRONTEND_URL`.

**Note on devDependencies:** the runtime stage installs the full tree, not
`--omit=dev`, because the same image must be able to run `npm run dev` for the
dev unit. The build toolchain is therefore present in the production image.

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
├── src/backend/data/demo-findings/   # Demo findings dropped in manually (mounted read-only)
├── src/frontend/public/demo-files/   # Demo manuscripts dropped in manually
└── logs/                   # Application logs
    └── app.log
```

> **Prompt files come from the image, not the host.** The `src/backend/data/prompts/*.txt`
> files are baked into the Docker image at build time and must NOT be shadowed by a host
> mount. Only `src/backend/data/demo-findings/` is mounted read-only from the host. Mounting
> the whole `src/backend/data/` over the container would hide the image's prompts and break
> detection — mount only the `demo-findings` subdirectory (see the `.service` files in `deploy/`).

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
