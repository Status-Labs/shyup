# Deploying Shyup

Shyup is one Node process and one SQLite file. Any Linux box with Node 24 runs it. A small VM (1 vCPU, 512 MB) is plenty.

## Option A: systemd + Caddy

On the server, as root:

```sh
# Node 24 from your distro, NodeSource or mise. Then:
useradd --system --home /opt/shyup --shell /usr/sbin/nologin shyup
git clone https://github.com/Status-Labs/shyup /opt/shyup
mkdir -p /var/lib/shyup && chown shyup: /var/lib/shyup
cp /opt/shyup/deploy/shyup.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now shyup
```

Make tokens and projects (as the service user, so the DB stays owned by it):

```sh
cd /opt/shyup
sudo -u shyup SHYUP_DB=/var/lib/shyup/shyup.db node src/cli.ts token create ben
sudo -u shyup SHYUP_DB=/var/lib/shyup/shyup.db node src/cli.ts project create WEM "WeMail"
```

HTTPS with [Caddy](https://caddyserver.com) (gets certificates automatically). `/etc/caddy/Caddyfile`:

```
tasks.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Upgrade: `cd /opt/shyup && git pull && systemctl restart shyup`. Migrations run on start.

## Option B: Docker

```sh
docker build -t shyup .
docker run -d --name shyup -p 127.0.0.1:4000:4000 -v shyup-data:/data shyup
docker exec shyup node src/cli.ts token create ben
```

Put a reverse proxy with HTTPS in front, as above.

## Backups

Everything is in the one database file. Back it up while running with:

```sh
sqlite3 /var/lib/shyup/shyup.db ".backup '/backups/shyup-$(date +%F).db'"
```

Copy that file somewhere off the box (S3, B2, another server). Restore by stopping the service and putting the file back.

## Security notes

- Always serve over HTTPS: tokens travel in headers and cookies.
- Keep `HOST=127.0.0.1` behind the proxy so the plain-HTTP port isn't public.
- Lost or leaked token: `node src/cli.ts token revoke <name>`, then create a new one.
