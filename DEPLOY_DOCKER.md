# Docker VPS Deployment

This build adds a local Docker stack for Cloud Mail plus a standalone SMTP API service.

## 1. Prepare the server

```bash
git clone https://github.com/xiaofujie369/cloud-mail.git
cd cloud-mail
cp .env.example .env
```

Edit `.env` and set real values for:

- `APP_HOST`: use `:80` for IP-only access, or your domain such as `mail.example.com`.
- `MAIL_DOMAIN` / `MAIL_DOMAINS`: the mailbox domain list.
- `ADMIN_EMAIL`: the first administrator email.
- `JWT_SECRET`: a long random string.
- `SMTP_API_TOKEN`: a long random token.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`: your SMTP provider.

Generate secrets:

```bash
openssl rand -hex 32
```

## 2. Start

```bash
docker compose up -d --build
```

Initialize the Cloud Mail database once:

```bash
curl "http://127.0.0.1/api/init/$(grep '^JWT_SECRET=' .env | cut -d= -f2-)"
```

Then open:

```text
http://SERVER_IP/
```

Register the `ADMIN_EMAIL` account first. The SMTP API admin page is available from the left management menu.

## 3. Send mail through the SMTP API

```bash
curl -X POST "http://SERVER_IP/smtp-api/send" \
  -H "Authorization: Bearer YOUR_SMTP_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "user@example.com",
    "subject": "Cloud Mail SMTP API test",
    "text": "Hello from Cloud Mail"
  }'
```

Optional fields: `from`, `fromName`, `cc`, `bcc`, `replyTo`, `html`, and `headers`.

## 4. Operate

```bash
docker compose logs -f
docker compose restart
docker compose pull && docker compose up -d --build
```

Persistent data is stored in Docker volumes:

- `cloud_mail_worker`: local D1/KV data used by Wrangler.
- `smtp_api_data`: SMTP API send logs.
- `caddy_data` / `caddy_config`: Caddy state and certificates.
