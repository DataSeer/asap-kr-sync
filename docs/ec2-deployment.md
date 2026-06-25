# EC2 Deployment Guide

Complete guide to deploying ASAP KR-Sync on an AWS EC2 instance.

## Architecture Overview

```
                 Internet
                    │
              ┌─────┴─────┐
              │   Nginx    │  (host) SSL termination, reverse proxy
              │  :80/:443  │
              └─────┬──────┘
                    │ proxy_pass http://127.0.0.1:3000
              ┌─────┴──────┐
              │   Docker    │  Node.js serves API + Vue SPA
              │   :3000     │  (localhost only)
              └─────┬──────┘
                    │ host.docker.internal
              ┌─────┴──────┐
              │ PostgreSQL  │  (host) :5432
              └────────────┘
```

- **Nginx** runs on the host, handles SSL (Certbot) and proxies all traffic to the container
- **Docker container** runs the Node.js app which serves both the API (`/api/*`, `/health`) and the Vue SPA (all other routes)
- **PostgreSQL** runs on the host, accessed from Docker via `--add-host=host.docker.internal:host-gateway`

## Prerequisites

- **EC2 instance**: `t3.medium` (2 vCPU, 4 GB RAM) or equivalent, Ubuntu 22.04+ recommended
- **Domain name**: Pointed at the EC2 public IP (A record)
- **AWS ECR repository**: Created in your AWS account (named `asap-kr-sync`)
- **GitHub repository secrets** (for CI/CD):
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
- **GitHub repository variables**:
  - `AWS_REGION` (e.g., `us-east-1`)

---

## 1. EC2 Server Setup

### 1.1 Install system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io nginx certbot python3-certbot-nginx postgresql postgresql-contrib unzip
```

### 1.2 Install AWS CLI v2

The `awscli` apt package is not available on Ubuntu 24.04. Install AWS CLI v2 directly from AWS:

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
rm -rf aws awscliv2.zip

# Verify
aws --version
```

### 1.3 Enable and start services

```bash
sudo systemctl enable docker nginx postgresql
sudo systemctl start docker nginx postgresql
```

### 1.4 Add your user to the docker group

```bash
sudo usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

### 1.5 Configure PostgreSQL to accept connections from Docker

By default PostgreSQL only listens on `localhost`. The Docker container connects via the Docker bridge network (`172.17.0.1`), so PostgreSQL needs to listen there too and allow the app user to authenticate.

First, find the Docker bridge subnet:

```bash
docker network inspect bridge | grep Subnet
# Typically: 172.17.0.0/16
```

Edit `/etc/postgresql/*/main/postgresql.conf` — add the Docker bridge IP to `listen_addresses`:

```
listen_addresses = 'localhost,172.17.0.1'
```

This keeps PostgreSQL off the public interface. Only localhost and the Docker bridge can reach it.

Edit `/etc/postgresql/*/main/pg_hba.conf` — add a rule for the app user only, using `scram-sha-256`:

```
# Allow the app user from Docker containers (and only this user/database)
host    asap_krsync_prod    asap_krsync    172.17.0.0/16    scram-sha-256
```

This is locked down to:
- **Database**: `asap_krsync_prod` only (not `all`)
- **User**: `asap_krsync` only (not `all`)
- **Auth**: `scram-sha-256` (stronger than `md5`, default since PostgreSQL 15)

Restart PostgreSQL:

```bash
sudo systemctl restart postgresql
```

---

## 2. Create the Database

```bash
sudo -u postgres psql
```

```sql
CREATE USER asap_krsync WITH PASSWORD 'your_strong_password_here';
CREATE DATABASE asap_krsync_prod OWNER asap_krsync;
GRANT ALL PRIVILEGES ON DATABASE asap_krsync_prod TO asap_krsync;
\q
```

---

## 3. Application Directory Setup

```bash
# Create app directory
sudo mkdir -p /opt/asap-kr-sync/{credentials,logs}

# Set ownership (your user or a dedicated service user)
sudo chown -R $USER:$USER /opt/asap-kr-sync
```

### 3.1 Create the environment file

```bash
nano /opt/asap-kr-sync/.env
```

Paste and customize the following (see `.env.production.example` in the repo for reference):

```bash
# ===========================================
# ASAP KR-Sync - Production Environment
# ===========================================

NODE_ENV=production

# Server
PORT=3000
API_BASE_URL=https://yourdomain.com
FRONTEND_URL=https://yourdomain.com

# Database — use host.docker.internal to reach host PostgreSQL from Docker
DATABASE_URL=postgresql://asap_krsync:your_strong_password_here@host.docker.internal:5432/asap_krsync_prod
DATABASE_POOL_MIN=5
DATABASE_POOL_MAX=20

# JWT — generate with: node scripts/generate-jwt-secret.js
JWT_SECRET=REPLACE_WITH_A_STRONG_RANDOM_SECRET
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Auth0 (ASAP Hub identity provider)
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://hub.asap.science/api
AUTH0_CLIENT_ID=your_auth0_client_id
AUTH0_CLIENT_SECRET=your_auth0_client_secret

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
S3_BUCKET_NAME=asap-kr-sync
S3_BUCKET_PREFIX=prod/

# PDF Analysis consolidates every detection into the Generated KRT. It uses
# an LM (Gemini, KRT_GENERATION_* vars) to do the final consolidation, with a
# rule-based merge fallback when the LM is not configured. The legacy
# PDF_ANALYSIS_API_* vars below are vestigial; the .env.example keeps them
# only so existing .env files don't error.
PDF_ANALYSIS_ENABLED=true

# Logging
LOG_LEVEL=info
LOG_FILE=logs/app.log

# KRT
KRT_TEMPLATE_URL=https://docs.google.com/spreadsheets/d/YOUR_TEMPLATE_ID/template/preview
```

Key differences from development:
- `DATABASE_URL` uses `host.docker.internal` instead of `localhost`
- `FRONTEND_URL` is your actual domain (same origin as API)
- `S3_ENDPOINT` is **not set** (uses real AWS S3, not MinIO)

### 3.2 Place credentials

Copy your Google service account JSON to the credentials volume:

```bash
scp google-service-account.json ec2-user@<EC2_IP>:/opt/asap-kr-sync/credentials/
```

### 3.3 Secure the files

```bash
chmod 600 /opt/asap-kr-sync/.env
chmod 600 /opt/asap-kr-sync/credentials/*
```

---

## 4. AWS ECR Login

Configure the AWS CLI on the EC2 instance:

```bash
aws configure
# Enter your AWS Access Key ID, Secret Access Key, and Region
```

Log in to ECR (you'll need to repeat this periodically — ECR tokens expire after 12 hours):

```bash
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
```

Replace `<REGION>` and `<ACCOUNT_ID>` with your values. For example:

```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
```

---

## 5. Install the Systemd Service

The repository ships **two** service files — pick the one matching your
deployment environment:

  - `deploy/asap-kr-sync-dev.service`  — dev / staging EC2 (built from `dev` branch)
  - `deploy/asap-kr-sync-prod.service` — production EC2 (built from `main` branch)

Before installing, replace the ECR registry placeholder. The example below
uses the **prod** variant; substitute `-dev` for staging.

```bash
# Clone the repo (or scp the service file)
# Edit the service file to replace <ECR_REGISTRY> with your actual ECR registry URL
# e.g., 123456789012.dkr.ecr.us-east-1.amazonaws.com

sudo cp deploy/asap-kr-sync-prod.service /etc/systemd/system/asap-kr-sync-prod.service

# Edit in place to set your ECR registry
sudo nano /etc/systemd/system/asap-kr-sync-prod.service
# Replace <ECR_REGISTRY> with your value, e.g.:
#   123456789012.dkr.ecr.us-east-1.amazonaws.com

sudo systemctl daemon-reload
sudo systemctl enable asap-kr-sync-prod
```

---

## 6. Nginx and SSL Setup

### 6.1 Install the Nginx site config

The config template is at `nginx/asap-kr-sync.conf` in the repository.

```bash
# Copy the config
sudo cp nginx/asap-kr-sync.conf /etc/nginx/sites-available/asap-kr-sync

# Replace all <YOUR_DOMAIN> placeholders
sudo sed -i 's/<YOUR_DOMAIN>/yourdomain.com/g' /etc/nginx/sites-available/asap-kr-sync

# Enable the site
sudo ln -sf /etc/nginx/sites-available/asap-kr-sync /etc/nginx/sites-enabled/

# Remove default site if present
sudo rm -f /etc/nginx/sites-enabled/default
```

### 6.2 Get SSL certificate with Certbot

Use `certonly` mode so Certbot gets the certificate without modifying the Nginx config
(the `--nginx` plugin rewrites server blocks and can break our config):

```bash
# Create the webroot directory for ACME challenges
sudo mkdir -p /var/www/certbot

# Temporarily comment out the HTTPS server block in the Nginx config
# (the SSL cert files don't exist yet, so nginx -t will fail otherwise)
# Keep only the HTTP server block, then:
sudo nginx -t && sudo systemctl reload nginx

# Get the certificate (certonly = no config rewriting)
sudo certbot certonly --webroot -w /var/www/certbot -d yourdomain.com

# Now restore the full config (both HTTP and HTTPS blocks)
# and replace placeholders if not already done:
sudo cp nginx/asap-kr-sync.conf /etc/nginx/sites-available/asap-kr-sync
sudo sed -i 's/<YOUR_DOMAIN>/yourdomain.com/g' /etc/nginx/sites-available/asap-kr-sync
```

**Do NOT use `sudo certbot --nginx`** — it rewrites server blocks (adds `listen 443 ssl`
and redirect rules to the wrong block), which causes infinite redirect loops.

### 6.3 Verify and reload Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6.4 Auto-renewal

Certbot installs a systemd timer by default. Verify:

```bash
sudo systemctl status certbot.timer
```

---

## 7. First Deployment

### 7.1 Pull the Docker image

The GitHub Actions workflows build and push images automatically:
- **`docker-build-dev.yml`**: Triggers on push to `dev` branch. Tags: `dev-latest`, `dev-<short-sha>`
- **`docker-build-tag.yml`**: Triggers on git tags matching `v*`. Tags: `<tag>` (e.g., `v1.0.0`)

Push code to the `dev` branch (or create a tag) to trigger a build. Then on EC2:

```bash
# Log in to ECR (if not already)
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ECR_REGISTRY>

# Pull the image
docker pull <ECR_REGISTRY>/asap-kr-sync:dev-latest
```

### 7.2 Start the service

```bash
\1-prod\3```

### 7.3 Check status

```bash
\1-prod\3
# View live container logs
docker logs -f asap-kr-sync
```

You should see:
1. "Waiting for PostgreSQL to be ready..."
2. "PostgreSQL is ready"
3. "Running database migrations..."
4. "Database connection established successfully"
5. "Server running on port 3000"

### 7.4 Create the first admin user

On the EC2 instance, run the user creation script inside the container:

```bash
docker exec -it asap-kr-sync node scripts/create-user.js
```

Or seed demo data (for initial testing):

```bash
docker exec -it asap-kr-sync sh -c "cd src/backend && npx sequelize-cli db:seed:all"
```

---

## 8. Updating / Redeploying

After pushing changes to `dev` (or tagging a release):

```bash
# Log in to ECR (token may have expired)
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ECR_REGISTRY>

# Pull the latest image
docker pull <ECR_REGISTRY>/asap-kr-sync:dev-latest

# Restart the service (entrypoint runs migrations automatically)
\1-prod\3```

To deploy a specific tagged version:

```bash
docker pull <ECR_REGISTRY>/asap-kr-sync:v1.0.0

# Edit the service file to use the specific tag, then:
sudo systemctl daemon-reload
\1-prod\3```

---

## 9. Verification

Run these checks after each deployment:

```bash
# 1. Backend health check (from EC2)
curl http://localhost:3000/health
# Expected: {"status":"ok","timestamp":"..."}

# 2. Frontend served by backend (from EC2)
curl -s http://localhost:3000/ | head -5
# Expected: HTML content with Vue SPA (<!DOCTYPE html>...)

# 3. API through Nginx with SSL (from anywhere)
curl https://yourdomain.com/health
# Expected: {"status":"ok","timestamp":"..."}

# 4. Frontend through Nginx
curl -s https://yourdomain.com/ | head -5
# Expected: Vue SPA HTML

# 5. Container is running
docker ps
# Expected: asap-kr-sync container listed

# 6. Service is active
\1-prod\3```

Then open the browser and test:
- Navigate to `https://yourdomain.com` — should show the Vue login page
- Log in with your credentials
- Create a submission
- Test PDF upload and analysis

---

## 10. Logs and Monitoring

### Application logs

```bash
# Live container logs (stdout/stderr)
docker logs -f asap-kr-sync

# Application log file (written by Winston)
tail -f /opt/asap-kr-sync/logs/app.log
```

### Systemd service logs

```bash
# Service logs via journald
sudo journalctl -u asap-kr-sync -f

# Last 100 lines
sudo journalctl -u asap-kr-sync -n 100
```

### Nginx logs

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### PostgreSQL logs

```bash
sudo tail -f /var/log/postgresql/postgresql-*-main.log
```

---

## 11. Troubleshooting

### Container won't start

```bash
# Check service status
\1-prod\3
# Check Docker logs
docker logs asap-kr-sync

# Try running manually
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  --env-file /opt/asap-kr-sync/.env \
  -v /opt/asap-kr-sync/credentials:/app/credentials:ro \
  -p 127.0.0.1:3000:3000 \
  <ECR_REGISTRY>/asap-kr-sync:dev-latest
```

### "PostgreSQL is unavailable" loop in entrypoint

- Verify PostgreSQL is running: `sudo systemctl status postgresql`
- Verify PostgreSQL listens on the Docker bridge: `sudo ss -tlnp | grep 5432`
- Verify `pg_hba.conf` allows `asap_krsync` user from `172.17.0.0/16`
- Verify `postgresql.conf` has `listen_addresses` including the Docker bridge IP
- Test from within a container: `docker run --rm --add-host=host.docker.internal:host-gateway postgres:15-alpine pg_isready -h host.docker.internal -U postgres`

### Database migration fails

```bash
# Run migrations manually inside the container
docker exec -it asap-kr-sync sh -c "cd src/backend && npx sequelize-cli db:migrate"

# Check migration status
docker exec -it asap-kr-sync sh -c "cd src/backend && npx sequelize-cli db:migrate:status"

# Undo last migration if needed
docker exec -it asap-kr-sync sh -c "cd src/backend && npx sequelize-cli db:migrate:undo"
```

### 502 Bad Gateway from Nginx

- Container not running: `docker ps` should show `asap-kr-sync`
- Port not bound: `curl http://localhost:3000/health` should respond
- Nginx misconfigured: `sudo nginx -t` to check syntax

### ECR login expired

ECR tokens expire after 12 hours. Re-authenticate:

```bash
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ECR_REGISTRY>
```

### SSL certificate issues

```bash
# Check certificate status
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal

# Reload Nginx after renewal
sudo systemctl reload nginx
```

---

## 12. Useful Commands Reference

```bash
# --- Service ---
\1-prod\3\1-prod\3\1-prod\3\1-prod\3
# --- Docker ---
docker ps                              # Running containers
docker logs -f asap-kr-sync            # Live logs
docker exec -it asap-kr-sync sh        # Shell into container
docker images                          # List local images

# --- Database (from host) ---
sudo -u postgres psql asap_krsync_prod # Connect to prod DB

# --- Database (from container) ---
docker exec -it asap-kr-sync sh -c "cd src/backend && npx sequelize-cli db:migrate:status"

# --- Nginx ---
sudo nginx -t                          # Test config
sudo systemctl reload nginx            # Reload after config change

# --- Full redeploy ---
aws ecr get-login-password --region <REGION> | docker login --username AWS --password-stdin <ECR_REGISTRY>
docker pull <ECR_REGISTRY>/asap-kr-sync:dev-latest
\1-prod\3```
