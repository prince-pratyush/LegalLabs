# Intake by email: threat note

`POST /hooks/email/{channel_key}` is the one route that takes content from the internet with no
session. Code: `apps/api/src/inbound/`, `apps/api/src/intake/channels.ts`, migration 0233.

## Trust

| Party                           | What it is trusted for                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The receiving mail server (MTA) | Holds the channel secret. Its topmost `Authentication-Results` header is believed                                                                        |
| The sender of an email          | Nothing. `From` is a name to answer: it never selects a user, matter, assignee, type or permission                                                       |
| Message content                 | Nothing. It is stored as files; none of it is run, fetched or logged. The subject and body of the message are put into the classification prompt (below) |

## Controls

| Threat                                  | Control                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Junk without a signature                | 120 failures a minute per address, counted apart from signed messages; once they are used up, a key that has signed before is still looked up                                                                                                                                                        |
| Forged posts                            | HMAC-SHA256 over `v0:{timestamp}:{raw body}` in `X-LegalLabs-Timestamp` and `X-LegalLabs-Signature`, checked before anything is parsed or stored. One answer for unknown channel, bad signature and stale timestamp                                                                                  |
| Replay                                  | Five minute window, and the hash of each body is kept so it is taken once, for good. A second message with the same `Message-ID` from the same sender is dropped                                                                                                                                     |
| Memory exhaustion before authentication | Unknown keys are refused before the body is read; the body is cut off at 15 MB while it streams; four bodies at a time, at most two from one address or for one channel; a body silent for 10 seconds, or not done in 60, is dropped                                                                 |
| Flooding by a key holder                | 120 signed messages a minute per channel; at most 500 messages or 200 MB waiting, and 50 or 50 MB from one sender (then `429`, so the MTA retries); 600 accepted per workspace and 30 per sender in an hour, the rest stay queued; 600 refused per channel in an hour; workspaces are served in turn |
| Parser abuse                            | Sender and DMARC are decided from the header block alone, before any body is parsed; limits on lines, parts, nesting, header bytes, attachments and body length; attached messages are not read into; text is never rendered as HTML; no expression that backtracks on message text                  |
| Spoofed sender                          | `dmarc=pass` for the exact `From` domain, from the first `Authentication-Results` header only and only if it names the configured server; comments and quoted strings are ignored; exactly one plain `From` address; exact domain allow list                                                         |
| Mail loops and backscatter              | The hook sends nothing (see below for what is sent later). Auto-submitted, bulk, list, bounce, report and own-address mail is dropped                                                                                                                                                                |
| Malicious files                         | Each is scanned before it is stored and again by the ingest worker; type and size checks are those of any upload; names lose paths and hidden characters                                                                                                                                             |
| Disclosure of what arrived              | Files go to the Inbox vault, with its walls, and cannot be material for threads, agents, tables or reviews (F-53 to F-55). A file is hidden from everyone until its request exists                                                                                                                   |
| Secrets                                 | 256 bit, sealed with `LEGALLABS_SECRETS_KEY`, shown once, rotated with an overlap of up to 72 hours or none                                                                                                                                                                                          |
| Content in logs and records             | Logs carry message ids and error codes. The audit log and the queue keep ids, counts, sizes, hashes and reason codes. The raw message is deleted when it is filed, refused or given up                                                                                                               |
| Database reach                          | The app role has no access to the queue. The hook and worker use narrow `security definer` functions that only the worker role may call, and take the workspace from the row                                                                                                                         |

## After filing: classification, mail and routing

Code: `apps/api/src/intake/{classify,worker,mail}.ts`, migration 0234.

| Threat                                        | Control                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instructions planted in a message             | Subject and body only, capped, invisible characters removed, instruction-like lines marked, angle brackets replaced. The answer must match a strict schema; it can name one configured type and fill that type's text, select, date, money and yes/no fields, nothing else                                                                                                                              |
| A requester choosing a matter, file or person | Matter fields are never filled; a file field takes only a file on the request; the apply function in the database refuses anything else and takes no matter or assignee. Assignment rules choose only among people the type's author named, though a field rule may read a value the requester stated                                                                                                   |
| A model or message causing mail               | Mail goes only to the authenticated address the request came from. Its words are fixed, apart from the type's question and a lawyer's reply. No requester or model text and no link is sent                                                                                                                                                                                                             |
| Mail loops and cost                           | `Auto-Submitted` and `X-Auto-Response-Suppress: All` on system mail; each field asked at most three times; in a day, 20 system mails to one address and answers to 5 of its requests, the rest dropped and not retried; five claims a mail; 10 model calls per request. A lawyer's reply is outside these limits. A responder that ignores the headers can still open requests, up to the intake limits |
| Joining someone else's request                | An answer must quote a random token from our Message-ID and come, with DMARC, from the request's own address                                                                                                                                                                                                                                                                                            |
| Routing widening access                       | Routes as set by a person who must still have the Space and an intake settings permission. The assignee must have triage, the request's matter and edit membership of the Space. The task carries the number and type name only                                                                                                                                                                         |
| Intake files becoming material                | Unchanged (F-53 to F-55). A type routed to contract review or to an agent is left in the queue for a person; there is no step that files an intake attachment into a vault                                                                                                                                                                                                                              |

## Over time

Code: `apps/api/src/intake/sweep.ts`, migration 0235.

- Escalation conditions are structured data that is compared, never evaluated.
- Escalation reaches only people who can open the request (triage permission and its matter);
  taking over a lawyer's task also needs edit membership of the Space.
- Only an email request whose question, or a lawyer's reply, has gone out in the current wait
  is reminded or closed: at most three reminders, then one closing message. A request set
  waiting by hand with nothing sent, or one that came another way, waits for a person.
- Merging never crosses matters and keeps the oldest. A merged thread's answers follow only when
  both requests came from the same address.
- A merged request's task and files stay on it.

## What the deployer must do

- The MTA must remove incoming `Authentication-Results` headers that name its own server id and
  add its own at the top, for every message. A server that adds none leaves a forged one first.
- Send to the hook over TLS, only for the intake address.
- Refuse messages over 15 MB at SMTP time, and treat `413` and `202` as final without bouncing
  to the sender. Retry `408`, `429`, `503` and `500`.
- Behind a proxy, list it in `LEGALLABS_TRUSTED_PROXIES`.

## Residual

- Several senders in an allowed domain, or one who can vary the local part, can together fill
  a channel's queue. Someone who knows a channel key (not the secret) can take its two read
  places with slow bodies.
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
- Classification accuracy has not been measured; tests use a fake model.
- A lawyer's reply is held until it is sent and then dropped, so the timeline records that one
  was sent, not what it said.
