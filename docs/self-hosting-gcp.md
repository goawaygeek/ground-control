# Self-hosting on GCP

This is the setup the hosted instance at `groundcontrol.deepdeep.space` runs on:
a single GCE VM with Caddy fronting the Node server, secrets pulled from
GCP Secret Manager at boot, and systemd keeping everything running. It's
deliberately boring — no Kubernetes, no Cloud Run, no autoscaling — because
Ground Control needs long-lived in-memory state across hours-long games and
the simplest thing that solves that is a VM.

If you want to host your own (e.g. for friends-only, or for development),
this is the path of least surprise.

## What you need

- A GCP project with billing enabled (sign-up credits cover this for ~3 months)
- A domain you control, with DNS you can edit
- Local `gcloud` CLI authenticated against the project
- A Notion integration token + two Notion databases (players + analytics)
  — see the main README for the schemas

## Cost

Roughly **$13/month** on demand for the recommended `e2-small`. The static
IP is free while attached to a running VM. Egress, Secret Manager, and
Artifact Registry usage at HN-scale traffic round to pennies.

If you scale down to `e2-micro` in `us-central1`, `us-west1`, or `us-east1`
the VM falls into GCP's always-free tier — but 1GB RAM is tight if you
later add an in-process chess engine like stockfish.wasm.

## One-time setup

### 1. Enable APIs

```bash
gcloud services enable compute.googleapis.com secretmanager.googleapis.com
```

### 2. Create the three secrets

The server expects three env vars at boot. Stash them in Secret Manager so
they don't sit in plain text on the VM. Use `printf '%s'` (not `echo`) so
no trailing newline gets baked in.

```bash
printf '%s' 'YOUR_NOTION_TOKEN'         | gcloud secrets create notion-token            --data-file=- --replication-policy=automatic
printf '%s' 'YOUR_PLAYERS_DATABASE_ID'  | gcloud secrets create notion-players-db-id    --data-file=- --replication-policy=automatic
printf '%s' 'YOUR_ANALYTICS_DATABASE_ID'| gcloud secrets create notion-analytics-db-id  --data-file=- --replication-policy=automatic
```

### 3. Grant the VM's service account read access on each secret

The default Compute Engine service account is what the VM will use to read
secrets — no per-VM service account juggling needed for a setup this size.

```bash
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get project) --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for SECRET in notion-token notion-players-db-id notion-analytics-db-id; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:$SA" \
    --role=roles/secretmanager.secretAccessor
done
```

### 4. Reserve a static external IP

```bash
gcloud compute addresses create groundcontrol-ip \
  --region=us-central1 \
  --network-tier=PREMIUM
```

Note the IP it allocates — you'll point DNS at it shortly.

### 5. Open ports 80 and 443

These firewall rules are scoped by GCP tags so they only apply to VMs
that opt in.

```bash
gcloud compute firewall-rules create allow-http \
  --direction=INGRESS --action=ALLOW \
  --rules=tcp:80 --source-ranges=0.0.0.0/0 --target-tags=http-server

gcloud compute firewall-rules create allow-https \
  --direction=INGRESS --action=ALLOW \
  --rules=tcp:443 --source-ranges=0.0.0.0/0 --target-tags=https-server
```

### 6. Create the VM

```bash
gcloud compute instances create groundcontrol \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-standard \
  --address=groundcontrol-ip \
  --tags=http-server,https-server \
  --scopes=cloud-platform \
  --metadata=enable-oslogin=TRUE
```

The `--scopes=cloud-platform` is what lets the VM's service account call
Secret Manager from inside the box.

### 7. Install Node.js and Caddy

SSH in and install both:

```bash
gcloud compute ssh groundcontrol --zone=us-central1-a
```

Then inside the VM:

```bash
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates gnupg git debian-keyring debian-archive-keyring apt-transport-https

# Node 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy from the official stable repo
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update -qq
sudo apt-get install -y caddy
```

### 8. Clone the repo and install dependencies

```bash
sudo mkdir -p /opt/ground-control
sudo chown $(id -u):$(id -g) /opt/ground-control
git clone https://github.com/goawaygeek/ground-control.git /opt/ground-control
cd /opt/ground-control
npm install --omit=dev --no-audit --no-fund
```

### 9. Create the env-loader script

This is what systemd will exec. It fetches the three secrets at boot and
launches the server with them in env. Token rotation is handled by writing
a new secret version in Secret Manager and restarting the service.

```bash
sudo tee /opt/ground-control/load-env.sh > /dev/null << 'EOF'
#!/usr/bin/env bash
# Fetches secrets from GCP Secret Manager and execs the server with them
# in env. The VM service account needs roles/secretmanager.secretAccessor
# on each secret.
set -euo pipefail
export NOTION_TOKEN="$(gcloud secrets versions access latest --secret=notion-token --quiet)"
export NOTION_DATABASE_ID="$(gcloud secrets versions access latest --secret=notion-players-db-id --quiet)"
export NOTION_ANALYTICS_DATABASE_ID="$(gcloud secrets versions access latest --secret=notion-analytics-db-id --quiet)"
export PORT=8087
exec /usr/bin/npx tsx /opt/ground-control/src/server.ts
EOF
sudo chmod +x /opt/ground-control/load-env.sh
```

### 10. Write the systemd unit

```bash
sudo tee /etc/systemd/system/groundcontrol.service > /dev/null << 'EOF'
[Unit]
Description=Ground Control game server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ground-control
ExecStart=/opt/ground-control/load-env.sh
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
MemoryHigh=1G
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable groundcontrol
sudo systemctl start groundcontrol
```

Check that it came up:

```bash
sudo journalctl -u groundcontrol -n 30
curl -sf http://localhost:8087/health  # → {"ok":true}
```

You should see three banners: "Using Notion for player persistence",
"Using Notion for analytics events", and "Chess bot enabled". If you see
the "Using local JSON file" / "Using local JSONL file" fallbacks instead,
the secret loading failed — check `journalctl` for the `gcloud secrets
versions access` error.

### 11. Write the Caddyfile

Replace `your.domain.example` with your actual domain. The `flush_interval`
is critical for SSE — without it, Caddy buffers responses and game events
arrive in chunks.

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
your.domain.example {
    encode gzip
    reverse_proxy localhost:8087 {
        flush_interval -1
    }
}
EOF
sudo systemctl restart caddy
```

### 12. Point DNS at the VM

At your DNS provider, create an **A record** for your domain pointing to
the static IP you reserved in step 4. Delete any pre-existing CNAME or AAAA
records for the same name — they will fight with the new A record and break
Let's Encrypt validation in confusing ways.

DreamHost specifically takes 5-15 minutes to publish changes from their
admin panel to their nameservers, and updates the three nameservers
asynchronously. Other providers may differ.

### 13. Wait for the cert

Caddy automatically requests a Let's Encrypt cert as soon as DNS resolves
to the VM. Watch the journal:

```bash
sudo journalctl -u caddy -f
```

Look for `certificate obtained successfully` for your domain. The first
attempt may fail if DNS hasn't fully propagated yet — Caddy retries every
60 seconds with exponential backoff up to 30 days.

When it succeeds, test from outside the VM:

```bash
curl https://your.domain.example/health
```

You should see `{"ok":true}`.

## Day-to-day operations

### Deploy a new version

```bash
gcloud compute ssh groundcontrol --zone=us-central1-a --command='
  cd /opt/ground-control &&
  git pull &&
  npm install --omit=dev --no-audit --no-fund &&
  sudo systemctl restart groundcontrol
'
```

Restart is ~3 seconds. SSE connections drop during the restart; the client
auto-reconnects via the 401-retry path in `channel-client.ts`.

### Tail logs

```bash
gcloud compute ssh groundcontrol --zone=us-central1-a --command='sudo journalctl -u groundcontrol -n 50 --no-pager'
```

Or follow live:

```bash
gcloud compute ssh groundcontrol --zone=us-central1-a --command='sudo journalctl -u groundcontrol -f'
```

### Rotate a Notion token

1. In Notion: generate a new token, save it somewhere safe.
2. Add it as a new version of the existing secret:
   ```bash
   printf '%s' 'NEW_TOKEN' | gcloud secrets versions add notion-token --data-file=-
   ```
3. Restart the service so it picks up the new version:
   ```bash
   gcloud compute ssh groundcontrol --zone=us-central1-a --command='sudo systemctl restart groundcontrol'
   ```
4. Disable the old version in Secret Manager once you're sure everything still works.

### Stop billing temporarily

Just stop the VM — the disk is preserved, and there's a small disk-only
charge while it's stopped (~$1/mo). Start it again when you want it back.

```bash
gcloud compute instances stop groundcontrol --zone=us-central1-a
gcloud compute instances start groundcontrol --zone=us-central1-a
```

The static IP stays reserved even while the VM is stopped.

### Tear it all down

```bash
gcloud compute instances delete groundcontrol --zone=us-central1-a --quiet
gcloud compute addresses delete groundcontrol-ip --region=us-central1 --quiet
gcloud compute firewall-rules delete allow-http allow-https --quiet
# Secrets and DNS are yours to keep or destroy.
```

## Gotchas worth knowing

- **Cloud Run doesn't work for this app.** Cloud Run is the obvious first
  reach for "deploy a Node server on GCP," but it aggressively scales
  instances to zero, wipes in-memory state on every restart, and has a
  hard 1-hour cap on SSE connection lifetime. Long-running games and
  in-memory session state make it the wrong primitive. A VM is right.
- **Don't co-locate a CNAME and an A record on the same DNS name.** It's
  invalid DNS — some resolvers return one, some return the other. If you
  migrated from another platform that used CNAMEs (Cloud Run, Vercel, etc),
  delete the old CNAME explicitly when you add the A record. If you don't,
  Let's Encrypt's IPv6 validators will chase the CNAME to the old IP and
  cert issuance will fail with cryptic 404 errors.
- **`enable-oslogin=TRUE`** on the VM means you SSH in using your Google
  identity instead of static SSH keys. Cleaner audit trail, no key
  rotation. Worth keeping enabled.
- **The chess bot's move computation is cheap** but if you swap in a real
  engine like stockfish.wasm or Maia, watch memory. `e2-small` has 2GB
  and the Node process plus the engine could easily breach the systemd
  `MemoryMax=1500M` ceiling — bump it or move to `e2-medium`.
