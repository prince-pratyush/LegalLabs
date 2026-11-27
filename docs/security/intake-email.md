# Intake by email: threat note

`POST /hooks/email/{channel_key}` is the one route that takes content from the internet with no
session. Code: `apps/api/src/inbound/`, `apps/api/src/intake/channels.ts`, migration 0233.

## Trust

| Party                           | What it is trusted for                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| The receiving mail server (MTA) | Holds the channel secret. Its topmost `Authentication-Results` header is believed                  |
| The sender of an email          | Nothing. `From` is a name to answer: it never selects a user, matter, assignee, type or permission |
| Message content                 | Nothing. It is stored as files; none of it is run, fetched, put into a prompt or logged            |

## Controls

| Threat                                  | Control                                                                                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged posts                            | HMAC-SHA256 over `v0:{timestamp}:{raw body}` in `X-LegalLabs-Timestamp` and `X-LegalLabs-Signature`, checked before anything is parsed or stored. One answer for unknown channel, bad signature and stale timestamp                          |
| Replay                                  | Five minute window, and the hash of each body is kept so it is taken once, for good. A second message with the same `Message-ID` from the same sender is dropped                                                                             |
| Memory exhaustion before authentication | 120 calls a minute per address; unknown keys are refused before the body is read; the body is cut off at 15 MB while it streams; four bodies at a time; 60 second read deadline                                                              |
| Flooding by a key holder                | 120 messages a minute per channel; at most 500 messages or 200 MB waiting (then `429`, so the MTA retries); 600 finished per workspace and 30 per sender in an hour, the rest stay queued                                                    |
| Parser abuse                            | Limits on lines, parts, nesting, header bytes, attachments and body length; attached messages are not read into; no expression that backtracks on message text                                                                               |
| Spoofed sender                          | `dmarc=pass` for the exact `From` domain, from the first `Authentication-Results` header only and only if it names the configured server; comments and quoted strings are ignored; exactly one plain `From` address; exact domain allow list |
| Mail loops and backscatter              | Nothing is ever sent. Auto-submitted, bulk, list, bounce, report and own-address mail is dropped                                                                                                                                             |
| Malicious files                         | Each is scanned before it is stored and again by the ingest worker; type and size checks are those of any upload; names lose paths and hidden characters                                                                                     |
| Disclosure of what arrived              | Files go to the Inbox vault, with its walls, and cannot be material for threads, agents, tables or reviews (F-53 to F-55). A file is hidden from everyone until its request exists                                                           |
| Secrets                                 | 256 bit, sealed with `LEGALLABS_SECRETS_KEY`, shown once, rotated with an overlap of up to 72 hours or none                                                                                                                                  |
| Content in logs and records             | Logs carry message ids and error codes. The audit log and the queue keep ids, counts, sizes, hashes and reason codes. The raw message is deleted when it is filed, refused or given up                                                       |
| Database reach                          | The app role has no access to the queue. The hook and worker use narrow `security definer` functions that only the worker role may call, and take the workspace from the row                                                                 |

## What the deployer must do

- The MTA must remove incoming `Authentication-Results` headers that name its own server id and
  add its own at the top, for every message. A server that adds none leaves a forged one first.
- Send to the hook over TLS, only for the intake address.
- Refuse messages over 15 MB at SMTP time, and treat `413` and `202` as final without bouncing
  to the sender. Retry `429`, `503` and `500`.
- Behind a proxy, list it in `LEGALLABS_TRUSTED_PROXIES`.

## Residual

- Anyone able to send authenticated mail from an allowed domain can create requests. Listing a
  public mail domain opens intake to everyone.
- DMARC authenticates a domain, not the mailbox: whether one person there can send as another
  is that domain's own control.
- `from_hash` is an unsalted-per-person hash of workspace and address: someone with database
  access can test a guess.
- Limits are held in memory, one API process. Parsing runs on that process's main thread,
  bounded by the limits above (a few seconds at worst).
- A message given up after its attempts (about half a day of real failures) is lost; it is
  audited as `email.inbound_failed`. Files already filed for it stay hidden in the Inbox until
  retention removes them.
- A queued message is not covered by a legal hold until it is filed.
- Live delivery from a real mail server has not been tested.
