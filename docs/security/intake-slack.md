# Intake from Slack: threat note

`POST /hooks/slack/{channel_key}` takes a Slack app's events, slash command and message shortcut,
with no session. Code: `apps/api/src/inbound/slack*.ts`, `apps/api/src/intake/slack*.ts`,
migration 0280. It shares the queue, Inbox, classifier and routing of intake by email
([intake-email.md](intake-email.md)). It was written from Slack's public API documentation and
tested against fixtures only: no Slack workspace has been used.

## Trust

| Party                             | What it is trusted for                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Slack, holding the signing secret | Saying which Slack user and channel something came from                                                        |
| A Slack user                      | Nothing here. Their id names a requester; it is never matched to a user of the platform, a matter or a right   |
| Message content and file names    | Nothing. Stored as files; none is run or logged. The message is put into the classification prompt, as mail is |

## Controls

| Threat                                  | Control                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged posts                            | Slack's `v0` HMAC over the raw body, checked before it is parsed. One answer for unknown key, bad signature and stale timestamp. The mail hook opens only mail channels and this one only Slack's, since both sign the same way                                       |
| Replay and repeats                      | Five minute window; each queued item is taken once for good, and one message (channel and timestamp) makes one request however it arrives. Redelivered events are the same item                                                                                       |
| Memory exhaustion before authentication | Unknown keys refused before the body is read; 512 KB cap while it streams; 16 bodies at once, 8 per address, 4 per channel; a body silent for 2 seconds or not done in 5 is dropped; 120 failures a minute per address                                                |
| Flooding                                | 30 items a minute per person and 120 per channel; the queue caps of mail (500 or 200 MB per channel, 50 per sender); 600 accepted per workspace and 30 per sender in an hour; workspaces served in turn                                                               |
| Loops                                   | Anything with a bot id, from the app's own user, from Slackbot, edited, deleted or hidden is ignored. In a day one person gets at most 30 system messages and answers to 10 requests                                                                                  |
| Who may ask                             | New requests only from the channels an administrator listed, for the configured team id. People from another organisation in a shared channel are ignored                                                                                                             |
| Reading other people's talk             | A thread reply is stored only when it is under an open request, from the person who made it. Other replies are dropped unstored                                                                                                                                       |
| Where messages go                       | Only under the request's thread, or, after a slash command, to the requester's own direct conversation. Never broadcast to a channel. Fixed words apart from a type's question and a lawyer's reply; `<`, `>` and `&` escaped, so no mention or labelled link is made |
| Outbound requests                       | `https://slack.com/api/chat.postMessage` and `files.slack.com` only, through the checked fetch, following no redirect. Nothing is sent or fetched for a channel with no bot token                                                                                     |
| Malicious files                         | At most 5 and 20 MB per message; scanned before storage and again by ingest; type checks as any upload; names lose paths and hidden characters; an HTML sign-in page is not taken for a file; linked files held elsewhere are not followed                            |
| Secrets                                 | Signing secret and bot token sealed with `LEGALLABS_SECRETS_KEY`, never returned, never in the audit log or logs                                                                                                                                                      |
| Content in logs and records             | Logs carry ids, error names and Slack's error codes. The queued item is deleted when it is filed, refused or given up                                                                                                                                                 |
| Database reach                          | The app role has no access to the queue or to threads. The workspace comes from the channel key's row, never from the payload                                                                                                                                         |

A shortcut can send in someone else's message. The requester is the person who used it; the
filed message says who wrote it and who submitted it, marks an author from another workspace, and
the timeline records the author's id. A reply that arrives after its request closed is dropped
before anything is stored; if the request closes while its files are being filed, they stay on it.
Replies in threads that are not the sender's open request count against no limit. The hourly limit
on what is accepted is separate for mail and for Slack. Review findings: F-88 to F-91 in
[evidence.md](evidence.md).

## What the deployer must do

- Create a Slack app and add a channel in LegalLabs (`POST /api/v1/apps/intake/slack-channels`)
  with its signing secret, team id, the channel ids to take requests from and, to answer, the
  bot token. There is no settings screen for this yet.
- Point the Events request URL, the slash command and the message shortcut at the channel's
  `hook_path` on a public HTTPS address.
- Subscribe to `message.channels`, `message.groups` (private channels) and `message.im`.
  Do not rely on `app_mention`: it is ignored.
- Bot scopes: `channels:history`, `groups:history`, `im:history`, `chat:write`, `commands`, and
  `files:read` for attachments. Invite the bot to each listed channel.

## Residual

- Not tested against Slack. Payload shapes, scopes and error codes are from its documentation.
- A reply under a thread in a channel is visible to everyone in that channel, including a
  lawyer's reply. Use a channel whose members may see them.
- What Slack does with a reply whose parent message has been deleted has not been checked.
- Slack retries a refused delivery only a few times, so what is over a limit for several
  minutes is lost, and many refusals can make Slack turn the subscription off.
- A reply sent before the request has been filed (a few seconds) is ignored.
- A shortcut on one message by several people makes a request for each.
- A file that cannot be fetched at that moment is not tried again; the message file says so.
- A crash between posting and recording posts the message twice.
- Deleting or editing a message in Slack changes nothing here.
- Anyone in a listed channel can make requests, within the limits.
- Limits are held in memory, one API process.
