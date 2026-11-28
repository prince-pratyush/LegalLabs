# Install on one server

Everything runs on one Linux server with Docker Compose: the web app and API, the runs worker,
Temporal, Postgres with pgvector, an S3 object store (SeaweedFS), ClamAV, the document parser
(docproc) and a TLS proxy (Caddy). Only the proxy listens on the network.

CI runs the commands marked below on every change to this bundle, with a stand-in model.
It has not been run on a rented server or against a public certificate authority.

## What you need

- A Linux server, x86-64. 8 vCPU, 32 GB memory and 500 GB disk for a pilot team. ClamAV alone
  holds about 3 GB; do not try less than 8 GB.
- Docker Engine 27 or later with the Compose plugin 2.30 or later, `git` and `openssl`.
- A DNS name pointing at the server, with ports 80 and 443 open to the people who will use it.
- A model: an Anthropic API key, or an Ollama server you run. Nothing else is cleared for
  client data (see [model policy](../security/model-policy.md)).
- Recommended: an SMTP server, for invitations, guest sign-in codes and notifications.

The server's disk should be encrypted: search indexes and extracted text are stored in
Postgres in the clear.

## 1. Get the code

```bash
git clone https://github.com/prince-pratyush/LegalLabs.git
cd LegalLabs
```

Check out the commit you intend to run, and note it: the upgrade steps need it.

## 2. Create the settings file

`init-env.sh` writes `infra/compose/.env` with generated passwords and keys, readable only by
you. It prints none of them and never overwrites the file. The second argument is an email
address, which gets a certificate from a public authority (by using it you accept that
authority's terms), or `internal`, for a certificate Caddy signs itself on a test server.

Set `DOMAIN` to the server's DNS name and `TLS` to your email, then run:

<!-- ci:configure -->
```bash
cd infra/compose
./init-env.sh "$DOMAIN" "$TLS"
```

**Copy `.env` somewhere safe now**, apart from the server and its backups. Without
`LEGALLABS_SECRETS_KEY` and `LEGALLABS_MFA_KEY`, stored provider keys, connector tokens and
second factors cannot be read again, even from a good backup.

Then add your own settings in `infra/compose/app.env`, one `NAME=value` a line, and
`chmod 600 app.env`. For example:

```bash
ANTHROPIC_API_KEY=your-key
LEGALLABS_SMTP_HOST=smtp.example.com
LEGALLABS_MAIL_FROM=legal@example.com
LEGALLABS_SMTP_USER=legal@example.com
LEGALLABS_SMTP_PASSWORD=your-password
```

## 3. Build and start

The first build takes a while: it compiles the app and downloads the parser's models.
ClamAV then downloads its signatures before it reports healthy.

<!-- ci:start -->
```bash
docker compose build
docker compose up -d --wait --wait-timeout 900
```

`up` first runs the `bootstrap` service, which applies the database migrations, gives the API
its own restricted database login, creates Temporal's login and creates the bucket. It is safe
to run again.

## 4. Create the first administrator

The password is read from standard input, never from an argument. Use at least 12 characters.

<!-- ci:admin -->
```bash
printf %s "$ADMIN_PASSWORD" | docker compose run --rm -T admin create-admin "$WORKSPACE" "$ADMIN_EMAIL"
```

To type it without it reaching your shell history, first run
`read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD`.

## 5. Sign in

Open `https://your-domain`, sign in with the workspace name, email and password, and set up an
authenticator app or passkey when asked. Keep the recovery codes. Invite everyone else from the
admin screens.

With `internal` TLS your browser will warn you. Caddy's root certificate is copied out with
`docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`.

## What refuses to start

In production the API and the worker stop, naming every problem, if any of these is true:

- a password or key is a well-known default, too short or not a generated key;
- `LEGALLABS_PUBLIC_URL` is not an `https` address, or `OIDC_INSECURE_DEV` is set;
- an application table lacks forced row-level security;
- the content or anchor bucket can be listed or read without credentials;
- the database login could bypass row-level security;
- there is no malware scanner, or second factors are not configured;
- the database has guests or open invitations and there is no mail server.

Read the reason with `docker compose logs api`.

## Day to day

| Task                      | Command (in `infra/compose`)        |
| ------------------------- | ----------------------------------- |
| Status                    | `docker compose ps`                 |
| Logs                      | `docker compose logs -f api worker` |
| Stop, keeping data        | `docker compose down`               |
| Apply a changed `app.env` | `docker compose up -d --wait`       |

`docker compose down -v` deletes every volume, and with it all your data.

## Settings

### Written to `.env` by `init-env.sh`

| Name                                       | What it is                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `LEGALLABS_DOMAIN`                         | Host name people use. Also names second factors: changing it later invalidates passkeys. |
| `LEGALLABS_TLS`                            | Certificate email, or `internal`.                                                        |
| `POSTGRES_PASSWORD`                        | Database owner. Used by `bootstrap` and `admin` only.                                    |
| `LEGALLABS_DB_PASSWORD`                    | The restricted login the API and worker use.                                             |
| `TEMPORAL_DB_PASSWORD`                     | Temporal's database login.                                                               |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object store credentials.                                                                |
| `LEGALLABS_SECRETS_KEY`                    | 32 bytes, base64. Seals provider keys and connector tokens.                              |
| `LEGALLABS_MFA_KEY`                        | 32 bytes, base64. Seals second-factor secrets.                                           |

### Optional, in `.env`

| Name                                          | Default          | What it is                                                                                                                                    |
| --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_BUCKET`                                   | `legallabs`      | Content bucket.                                                                                                                               |
| `S3_ANCHOR_BUCKET`                            | content bucket   | Bucket for daily audit anchors. They only prove something in a bucket with Object Lock in compliance mode, which this bundle does not set up. |
| `LEGALLABS_VERSION`                           | `local`          | Tag put on the images you build.                                                                                                              |
| `LEGALLABS_HTTP_PORT`, `LEGALLABS_HTTPS_PORT` | 80, 443          | Published ports. A public certificate needs 80 and 443.                                                                                       |
| `LEGALLABS_EDGE_SUBNET`                       | `172.30.99.0/24` | Network between proxy and API; change it if it clashes with yours.                                                                            |
| `DOCPROC_CONCURRENCY`                         | 2                | Files parsed at once.                                                                                                                         |
| `DOCPROC_THREADS`                             | 4                | CPU threads per PDF.                                                                                                                          |
| `DOCPROC_TIMEOUT_SECONDS`                     | 120              | Longest parse.                                                                                                                                |
| `DOCPROC_OCR_LANG`                            | `eng`            | OCR language. Only English data is in the image.                                                                                              |

### Optional, in `app.env` (API and worker)

Models:

| Name                                               | What it is                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                                | Anthropic.                                                                     |
| `GOOGLE_GENERATIVE_AI_API_KEY`, `DEEPSEEK_API_KEY` | Not cleared for client data.                                                   |
| `OLLAMA_BASE_URL`                                  | Your Ollama server, without `/v1`.                                             |
| `OLLAMA_CONTEXT_LENGTH`                            | Its context window, if raised from 4096.                                       |
| `LEGALLABS_MODEL_TIMEOUT_MS`                       | Longest model call.                                                            |
| `LEGALLABS_ALLOW_DEMO_MODELS`                      | `true` lets client data reach models that are not cleared for it. Leave unset. |
| `OLLAMA_EMBED_URL` or `TEI_URL`, `EMBED_MODEL`     | Embedding server for search by meaning. Without one, search is by keyword.     |
| `RERANK_URL`, `LEGALLABS_RERANK`                   | Reranker, used when `LEGALLABS_RERANK` is `on`.                                |

Mail:

| Name                                             | What it is                                                      |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `LEGALLABS_SMTP_HOST`, `LEGALLABS_MAIL_FROM`     | Both are needed to send mail.                                   |
| `LEGALLABS_SMTP_PORT`                            | 587, or 465 with `tls`.                                         |
| `LEGALLABS_SMTP_SECURITY`                        | `starttls` (default), `tls`, or `none` (refused in production). |
| `LEGALLABS_SMTP_USER`, `LEGALLABS_SMTP_PASSWORD` | If your server needs them.                                      |

Connectors and sources:

| Name                                                                                               | What it is                                                                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `LEGALLABS_GOOGLE_CLIENT_ID`, `LEGALLABS_GOOGLE_CLIENT_SECRET`                                     | Drive sync.                                                                                           |
| `LEGALLABS_MICROSOFT_CLIENT_ID`, `LEGALLABS_MICROSOFT_CLIENT_SECRET`, `LEGALLABS_MICROSOFT_TENANT` | SharePoint sync.                                                                                      |
| `LEGALLABS_SEARXNG_URL`, `LEGALLABS_SEARXNG_INTERNAL`                                              | Web search through your SearXNG. Off unless set.                                                      |
| `KNOWLEDGE_USER_AGENT`, `SEC_USER_AGENT`, `COURTLISTENER_TOKEN`                                    | Public-law sources. Load them with `docker compose run --rm api node apps/api/dist/knowledge/cli.js`. |

Limits:

| Name                                        | Default  | What it is                                                                       |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `LEGALLABS_ASKS_PER_10_MIN`                 | built in | Questions per person.                                                            |
| `LEGALLABS_TABLE_CELLS_IN_FLIGHT`           | built in | Review-table cells at once.                                                      |
| `LEGALLABS_REVIEW_PARALLELISM`              | 2        | Playbook rules checked at once.                                                  |
| `LEGALLABS_REVIEW_MAX_COST_USD`             | 5        | A review stops here.                                                             |
| `LEGALLABS_AGENT_MAX_COST_USD`              | built in | An agent run stops here.                                                         |
| `LEGALLABS_SOFFICE_VALIDATE`, `SOFFICE_BIN` | off      | Opens redlines in LibreOffice as a check. The images do not include LibreOffice. |

### Set by `compose.yaml`

Change these only to use a service of your own, by editing the compose file.

| Name                                                                    | What it is                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `NODE_ENV`                                                              | `production`.                                                               |
| `HOST`, `PORT`                                                          | Where the API listens inside its container.                                 |
| `DATABASE_URL`                                                          | Postgres address and login.                                                 |
| `S3_ENDPOINT`, `S3_REGION`                                              | Object store address and region (`us-east-1`).                              |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`                                | Temporal, namespace `default`.                                              |
| `DOCPROC_URL`                                                           | Document parser.                                                            |
| `DOCPROC_MODELS_DIR`                                                    | Set inside the parser image.                                                |
| `CLAMAV_HOST`, `CLAMAV_PORT`                                            | Malware scanner, port 3310.                                                 |
| `LEGALLABS_PUBLIC_URL`                                                  | `https://` followed by the domain.                                          |
| `LEGALLABS_MFA_RP_ID`, `LEGALLABS_MFA_ORIGINS`, `LEGALLABS_MFA_RP_NAME` | Second factors, from the domain.                                            |
| `LEGALLABS_TRUSTED_PROXIES`                                             | The proxy's network, so rate limits and the audit trail see real addresses. |

### Never in production

| Name                     | What it is                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- |
| `LEGALLABS_SCANNER`      | `stub` stands in for ClamAV on a developer's machine; refused in production. |
| `LEGALLABS_ALLOW_NO_MFA` | Runs without second factors.                                                 |
| `OIDC_INSECURE_DEV`      | Plain http single sign-on for local testing; refused in production.          |

## Not in this bundle

- High availability: one server is a single point of failure (ADR-024).
- Embedding and reranking servers, Zitadel, Valkey, monitoring dashboards.
- Encryption between containers, a KMS, signed images.
- The Office add-in panes are served under `/addin/` and `/outlook/`; installing their
  manifests in Microsoft 365 has not been tried against this bundle.
