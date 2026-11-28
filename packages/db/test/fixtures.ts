import { randomUUID } from "node:crypto";
import type { Tx } from "./db.js";

export const WORKFLOW_DEFINITION = JSON.stringify({
  schema: "counsel.workflow/1",
  blocks: [
    { type: "user_input.text", id: "q", label: "Question", prompt: "Ask" },
    { type: "response", id: "out", outputs: [{ ref: "@Question" }] },
  ],
  edges: [{ from: "q", to: "out" }],
  embedded_files: [],
});

// Two workspaces with a row in every table, inserted as the schema owner.
export async function seed(tx: Tx) {
  await tx.asOwner();
  const tag = randomUUID().slice(0, 8);
  const id = async (sql: string, params: unknown[]) =>
    (await tx.one<{ id: string }>(sql, params)).id;

  const workspace = (slug: string) =>
    id("insert into core.workspace (slug, name, region) values ($1, $1, 'au') returning id", [
      `${slug}-${tag}`,
    ]);
  const role = (ws: string, name: string, permissions: string[]) =>
    id("insert into core.role (workspace_id, name, permissions) values ($1, $2, $3) returning id", [
      ws,
      name,
      permissions,
    ]);
  const user = (
    ws: string,
    email: string,
    roleId: string,
    opts: { status?: string; kind?: string; extra?: string[] } = {},
  ) =>
    id(
      `insert into core."user" (workspace_id, email, role_id, status, kind, extra_permissions)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ws, email, roleId, opts.status ?? "active", opts.kind ?? "member", opts.extra ?? []],
    );

  const acme = await workspace("acme");
  const beta = await workspace("beta");
  const acmeAdmin = await role(acme, "Admin", ["*"]);
  const acmeUser = await role(acme, "User", ["threads.use"]);
  const betaAdmin = await role(beta, "Admin", ["*"]);

  const ana = await user(acme, "ana@acme.test", acmeAdmin);
  const ben = await user(acme, "ben@acme.test", acmeUser);
  const cal = await user(acme, "cal@acme.test", acmeUser);
  const sue = await user(acme, "sue@acme.test", acmeAdmin, { status: "suspended" });
  const gia = await id(
    `insert into core."user" (workspace_id, email, status, kind) values ($1, 'gia@guest.test', 'active', 'guest') returning id`,
    [acme],
  );
  // A live guest: without a profile a guest is locked out.
  await tx.rows(
    `insert into core.guest_profile (workspace_id, user_id, email_domain, expires_at)
     values ($1, $2, 'guest.test', now() + interval '30 days')`,
    [acme, gia],
  );
  // Holds admin.users but not admin.matters, to test that it cannot grant more.
  const dee = await user(acme, "dee@acme.test", acmeUser, { extra: ["admin.users"] });
  const bob = await user(beta, "bob@beta.test", betaAdmin);

  const group = (ws: string, name: string, visibility: string, kind = "standard") =>
    id(
      `insert into core."group" (workspace_id, name, visibility, kind) values ($1, $2, $3, $4) returning id`,
      [ws, name, visibility, kind],
    );
  const join = (ws: string, groupId: string, userIds: string[]) =>
    Promise.all(
      userIds.map((u) =>
        tx.rows(
          "insert into core.group_member (workspace_id, group_id, user_id) values ($1, $2, $3)",
          [ws, groupId, u],
        ),
      ),
    );

  const corpTeam = await group(acme, "corp-team", "private");
  const litTeam = await group(acme, "lit-team", "private");
  const everyone = await group(acme, "everyone", "public");
  const partyP = await group(acme, "party-p", "private", "party");
  const betaTeam = await group(beta, "beta-team", "private");
  await join(acme, corpTeam, [ana, ben]);
  await join(acme, litTeam, [cal]);
  await join(acme, partyP, [gia]);
  await join(beta, betaTeam, [bob]);

  const matter = (ws: string, number: string, mode: string) =>
    id(
      `insert into core.matter (workspace_id, client_id, client_name, matter_number, matter_name, wall_mode)
       values ($1, 'C1', 'Client', $2, $2, $3) returning id`,
      [ws, number, mode],
    );
  const wall = (ws: string, matterId: string, type: string, principal: string, effect: string) =>
    tx.rows(
      `insert into core.wall (workspace_id, matter_id, principal_type, principal_id, effect)
       values ($1, $2, $3, $4, $5)`,
      [ws, matterId, type, principal, effect],
    );

  // M3 is an allow-list nobody is on yet.
  const m1 = await matter(acme, "M1", "allow_list");
  const m2 = await matter(acme, "M2", "open");
  const m3 = await matter(acme, "M3", "allow_list");
  const mb = await matter(beta, "MB", "open");
  await wall(acme, m1, "group", corpTeam, "allow");
  await wall(acme, m1, "user", ben, "deny");
  await wall(acme, m2, "user", cal, "deny");
  await wall(beta, mb, "group", betaTeam, "allow");
  await tx.rows(
    `insert into core.matter_acknowledgement (workspace_id, user_id, matter_id, notice_version)
     values ($1, $2, $3, 1), ($4, $5, $6, 1)`,
    [acme, ana, m2, beta, bob, mb],
  );
  for (const [ws, admin] of [
    [acme, ana],
    [beta, bob],
  ] as const) {
    await tx.rows("insert into core.matter_options (workspace_id) values ($1)", [ws]);
    await tx.rows("insert into core.wall_provider (workspace_id) values ($1)", [ws]);
    await tx.rows(
      "insert into core.wall_sync_report (workspace_id, provider, status) values ($1, 'csv', 'ok')",
      [ws],
    );
    await tx.rows(
      `insert into core.matter_import (workspace_id, kind, mode, rows, preview, created_by)
       values ($1, 'matters', 'upsert', '[]', '{}', $2)`,
      [ws, admin],
    );
  }

  // Objects arrive in later modules; a share only needs a type and an id.
  const t1 = await id("select core.uuid7() as id", []);
  const tb = await id("select core.uuid7() as id", []);
  const share = (
    ws: string,
    objectId: string,
    type: string,
    principal: string,
    level: string,
    by: string,
  ) =>
    tx.rows(
      `insert into core.share_grant
         (workspace_id, object_type, object_id, principal_type, principal_id, level, granted_by)
       values ($1, 'thread', $2, $3, $4, $5, $6)`,
      [ws, objectId, type, principal, level, by],
    );
  await share(acme, t1, "group", corpTeam, "view", ana);
  await share(acme, t1, "user", cal, "edit", ana);
  await share(beta, tb, "workspace", beta, "view", bob);

  // Only hashes are stored; tests hold the raw secrets to look them up again.
  const session = (ws: string, userId: string, secret: string, expires = "1 day") =>
    tx.rows(
      `insert into core.session (workspace_id, user_id, token_hash, expires_at)
       values ($1, $2, sha256(convert_to($3, 'utf8')), now() + $4::interval)`,
      [ws, userId, secret, expires],
    );
  const token = (ws: string, userId: string, secret: string, scopes: string[]) =>
    tx.rows(
      `insert into core.api_token (workspace_id, principal_id, name, token_hash, scopes, expires_at)
       values ($1, $2, 'test', sha256(convert_to($3, 'utf8')), $4, now() + interval '90 days')`,
      [ws, userId, secret, scopes],
    );
  const secrets = {
    ana: `sid-ana-${tag}`,
    ben: `sid-ben-${tag}`,
    sue: `sid-sue-${tag}`,
    expired: `sid-old-${tag}`,
    bob: `sid-bob-${tag}`,
    anaToken: `cns_ana_${tag}`,
    bobToken: `cns_bob_${tag}`,
  };
  await session(acme, ana, secrets.ana);
  await session(acme, ben, secrets.ben);
  await session(acme, sue, secrets.sue);
  await session(acme, ana, secrets.expired, "-1 hour");
  await session(beta, bob, secrets.bob);
  await token(acme, ana, secrets.anaToken, ["audit:read"]);
  await token(beta, bob, secrets.bobToken, ["whoami"]);

  const audit = async (ws: string, userId: string) => {
    await tx.as(userId, ws);
    await tx.rows("select admin.append_audit_event('login.success', 'user', $1)", [userId]);
  };
  await audit(acme, ana);
  await audit(beta, bob);
  await tx.as(null, null);
  await tx.asOwner();
  for (const ws of [acme, beta]) {
    await tx.rows(
      `insert into admin.audit_anchor (workspace_id, day, last_seq, last_hash, storage_key)
       values ($1, '2000-01-01', 1, '\\x00', 'fixture')`,
      [ws],
    );
  }

  const document = async (ws: string, owner: string) => {
    const documentId = await id(
      `insert into content.document (workspace_id, owner_id, name, mime, size)
       values ($1, $2, 'msa.txt', 'text/plain', 10) returning id`,
      [ws, owner],
    );
    const versionId = await id(
      `insert into content.document_version (workspace_id, document_id, sha256, page_count, created_by)
       values ($1, $2, sha256('msa'), 1, $3) returning id`,
      [ws, documentId, owner],
    );
    const text = "The supplier accepts liability for loss.";
    await tx.rows(
      `insert into content.page (workspace_id, version_id, page_no, width, height, text, layout)
       values ($1, $2, 1, 612, 792, $3, '{"blocks":[]}')`,
      [ws, versionId, text],
    );
    await tx.rows(
      `insert into content.chunk (workspace_id, version_id, page_no, ordinal, char_from, char_to, text)
       values ($1, $2, 1, 0, 0, $3, $4)`,
      [ws, versionId, text.length, text],
    );
    await tx.rows(
      "insert into content.document_blob (workspace_id, version_id, bytes) values ($1, $2, '\\x00')",
      [ws, versionId],
    );
    await tx.rows(
      "insert into content.ingest_job (workspace_id, version_id, status) values ($1, $2, 'indexed')",
      [ws, versionId],
    );
    return { documentId, versionId };
  };
  const documents = { acme: await document(acme, ana), beta: await document(beta, bob) };

  // A vault with one folder and one filed document in each workspace.
  const vault = async (ws: string, owner: string) => {
    const vaultId = await id(
      "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Deal room') returning id",
      [ws, owner],
    );
    const folderId = await id(
      `insert into content.folder (workspace_id, vault_id, name, created_by)
       values ($1, $2, 'Contracts', $3) returning id`,
      [ws, vaultId, owner],
    );
    const documentId = await id(
      `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id, folder_id)
       values ($1, $2, 'nda.txt', 'text/plain', 10, $3, $4) returning id`,
      [ws, owner, vaultId, folderId],
    );
    return { vaultId, folderId, documentId };
  };
  const vaults = { acme: await vault(acme, ana), beta: await vault(beta, bob) };

  const thread = async (ws: string, owner: string, versionId: string) => {
    const threadId = await id(
      `insert into work.thread (workspace_id, owner_id, title) values ($1, $2, 'Liability') returning id`,
      [ws, owner],
    );
    await tx.rows(
      "insert into work.thread_document (workspace_id, thread_id, version_id) values ($1, $2, $3)",
      [ws, threadId, versionId],
    );
    const messageId = await id(
      `insert into work.message (workspace_id, thread_id, role, content)
       values ($1, $2, 'assistant', 'The supplier is liable.') returning id`,
      [ws, threadId],
    );
    await tx.rows(
      `insert into work.citation
         (workspace_id, message_id, ordinal, anchor, version_id, page_no, quote, char_from, char_to, status)
       values ($1, $2, 0, 22, $3, 1, 'accepts liability', 13, 30, 'ok')`,
      [ws, messageId, versionId],
    );
    const runId = await id(
      `insert into work.run (workspace_id, thread_id, owner_id, kind, status, question_id, answer_id)
       values ($1, $2, $3, 'thread', 'done', $4, $4) returning id`,
      [ws, threadId, owner, messageId],
    );
    await tx.rows(
      `insert into work.run_event (workspace_id, run_id, seq, type, data)
       values ($1, $2, 1, 'status', '{"status":"done"}')`,
      [ws, runId],
    );
    await tx.rows(
      "insert into work.thread_favourite (workspace_id, thread_id, user_id) values ($1, $2, $3)",
      [ws, threadId, owner],
    );
    const draftId = await id(
      `insert into work.draft (workspace_id, thread_id, owner_id, kind, title)
       values ($1, $2, $3, 'editor', 'Memo') returning id`,
      [ws, threadId, owner],
    );
    await tx.rows(
      `insert into work.draft_version (workspace_id, draft_id, no, body, author, created_by)
       values ($1, $2, 1, 'Draft text.', 'user', $3)`,
      [ws, draftId, owner],
    );
    const outputId = await id(
      `insert into work.thread_output
         (workspace_id, thread_id, message_id, owner_id, name, format, size, bytes)
       values ($1, $2, $3, $4, 'Memo.docx', 'docx', 1, '\\x00') returning id`,
      [ws, threadId, messageId, owner],
    );
    return { threadId, messageId, runId, draftId, outputId };
  };
  const threads = {
    acme: await thread(acme, ana, documents.acme.versionId),
    beta: await thread(beta, bob, documents.beta.versionId),
  };

  const preset = (ws: string, user: string) =>
    tx.rows(
      `insert into knowledge.source_filter_preset (workspace_id, user_id, source_id, name, filter)
       values ($1, $2, 'us_caselaw', 'Supreme Court', '{"courts":["us"]}')`,
      [ws, user],
    );
  await preset(acme, ana);
  await preset(beta, bob);

  // Unpublished, with one rule and an edit grant to the owner's team.
  const playbook = async (ws: string, owner: string, team: string) => {
    const playbookId = await id("select core.uuid7() as id", []);
    const versionId = await id("select core.uuid7() as id", []);
    await tx.rows(
      `insert into work.playbook (id, workspace_id, owner_id, name, contract_type, version_id)
       values ($1, $2, $3, 'NDA positions', 'NDA', $4)`,
      [playbookId, ws, owner, versionId],
    );
    await tx.rows(
      `insert into work.playbook_version
         (id, workspace_id, playbook_id, no, name, contract_type, rules, created_by)
       values ($1, $2, $3, 1, 'NDA positions', 'NDA', $4, $5)`,
      [
        versionId,
        ws,
        playbookId,
        JSON.stringify([{ title: "Term", standard_position: "Two years." }]),
        owner,
      ],
    );
    await tx.rows(
      `insert into work.playbook_grant
         (workspace_id, playbook_id, principal_type, principal_id, level, granted_by)
       values ($1, $2, 'group', $3, 'edit', $4)`,
      [ws, playbookId, team, owner],
    );
    return { playbookId, versionId };
  };
  const playbooks = {
    acme: await playbook(acme, ana, corpTeam),
    beta: await playbook(beta, bob, betaTeam),
  };

  // A finished review of the owner's document, with its steps and one suggestion.
  const review = async (
    ws: string,
    owner: string,
    pb: { playbookId: string; versionId: string },
    doc: { documentId: string; versionId: string },
  ) => {
    const runId = await id(
      `insert into work.run (workspace_id, owner_id, kind, status)
       values ($1, $2, 'playbook_review', 'done') returning id`,
      [ws, owner],
    );
    await tx.rows(
      `insert into work.run_step (workspace_id, run_id, ordinal, kind, status, model)
       values ($1, $2, 0, 'plan', 'done', 'fixture')`,
      [ws, runId],
    );
    const reviewId = await id(
      `insert into work.playbook_review (workspace_id, run_id, owner_id, playbook_id,
         playbook_version_id, playbook_name, rules, document_id, document_version_id, surface,
         customisation, status)
       values ($1, $2, $3, $4, $5, 'NDA positions', '[]', $6, $7, 'web',
               '{"party":"Acme","paper":"theirs","mode":"standard","scope":"all"}', 'done')
       returning id`,
      [ws, runId, owner, pb.playbookId, pb.versionId, doc.documentId, doc.versionId],
    );
    await tx.rows(
      `insert into work.review_suggestion (id, workspace_id, review_id, rule_id, kind, anchor,
         before, after, justification)
       values (core.uuid7(), $1, $2, core.uuid7(), 'replace',
               '{"paragraph_index":0,"char_from":0,"char_to":3,"para_hash":"00"}',
               'The', 'This', 'Fixture.')`,
      [ws, reviewId],
    );
    // A re-run of one rule; reads the same version here, which is enough for coverage.
    await tx.rows(
      `insert into work.review_rerun (workspace_id, review_id, rule_id, run_id,
         source_document_version_id, finding)
       values ($1, $2, core.uuid7(), $3, $4, '{}')`,
      [ws, reviewId, runId, doc.versionId],
    );
    return { runId, reviewId };
  };
  const reviews = {
    acme: await review(acme, ana, playbooks.acme, documents.acme),
    beta: await review(beta, bob, playbooks.beta, documents.beta),
  };
  // A contract review agent over that playbook, with one finished contract in its queue.
  const contractReview = async (
    ws: string,
    owner: string,
    pb: { playbookId: string },
    doc: { documentId: string; versionId: string },
    done: { runId: string; reviewId: string },
  ) => {
    const agentId = await id(
      `insert into apps.ci_review_agent (workspace_id, owner_id, name, contract_type,
         playbook_id, party, paper, assignment, thresholds, status)
       values ($1, $2, 'NDA intake', 'NDA', $3, 'Acme', 'theirs', '[]', '{}', 'live')
       returning id`,
      [ws, owner, pb.playbookId],
    );
    await tx.rows(
      `insert into apps.ci_contract_review (workspace_id, ci_agent_id, agent_name, owner_id,
         document_id, document_version_id, playbook_review_id, run_id, status, result,
         assignee_id, playbook_id)
       values ($1, $2, 'NDA intake', $3, $4, $5, $6, $7, 'aligned', 'aligned', $3, $8)`,
      [ws, agentId, owner, doc.documentId, doc.versionId, done.reviewId, done.runId, pb.playbookId],
    );
  };
  await contractReview(acme, ana, playbooks.acme, documents.acme, reviews.acme);
  await contractReview(beta, bob, playbooks.beta, documents.beta, reviews.beta);

  // Intake: the service user, its Inbox, and one request with a file and a timeline.
  const intake = async (ws: string, owner: string) => {
    const serviceId = await id(
      `insert into core."user" (workspace_id, email, status, kind)
       values ($1, 'intake@inbox.invalid', 'active', 'service') returning id`,
      [ws],
    );
    const vaultId = await id(
      "insert into content.vault (workspace_id, owner_id, name) values ($1, $2, 'Intake inbox') returning id",
      [ws, serviceId],
    );
    await tx.rows(
      "insert into apps.intake_inbox (workspace_id, service_user_id, vault_id) values ($1, $2, $3)",
      [ws, serviceId, vaultId],
    );
    const typeId = await id(
      `insert into apps.intake_request_type (workspace_id, name, fields, sla_hours, created_by)
       values ($1, 'NDA', '[]', 8, $2) returning id`,
      [ws, owner],
    );
    const requesterId = await id(
      `insert into apps.intake_requester (workspace_id, channel, external_user_id, display_name)
       values ($1, 'api', 'jo', 'Jo') returning id`,
      [ws],
    );
    const requestId = await id(
      `insert into apps.intake_request (workspace_id, channel, external_ref, requester_id,
         requester_name, type_id, status, created_by)
       values ($1, 'api', 'ref-1', $2, 'Jo', $3, 'new', $4) returning id`,
      [ws, requesterId, typeId, owner],
    );
    const documentId = await id(
      `insert into content.document (workspace_id, owner_id, name, mime, size, vault_id)
       values ($1, $2, 'in.txt', 'text/plain', 10, $3) returning id`,
      [ws, serviceId, vaultId],
    );
    await tx.rows(
      `insert into apps.intake_attachment (workspace_id, document_id, request_id, added_by)
       values ($1, $2, $3, $4)`,
      [ws, documentId, requestId, owner],
    );
    await tx.rows(
      `insert into apps.intake_event (workspace_id, request_id, kind, actor_type, actor_id)
       values ($1, $2, 'inbound', 'user', $3)`,
      [ws, requestId, owner],
    );
    const channelId = await id(
      `insert into apps.intake_channel (workspace_id, key, name, address, authserv_id,
         allowed_domains, secret_sealed, created_by)
       values ($1, replace(gen_random_uuid()::text, '-', ''), 'Legal', 'legal@firm.test',
         'mx.firm.test', array['acme.example'], 'sealed', $2) returning id`,
      [ws, owner],
    );
    await tx.rows(
      `insert into apps.inbound_email (workspace_id, channel_id, event_hash, size_bytes, status, raw)
       values ($1, $2, sha256('mail'), 4, 'queued', 'mail')`,
      [ws, channelId],
    );
    await tx.rows(
      "insert into apps.intake_work (request_id, workspace_id) values ($1, $2) on conflict do nothing",
      [requestId, ws],
    );
    await tx.rows(
      `insert into apps.intake_outbound (workspace_id, request_id, kind, ref)
       values ($1, $2, 'done', 'done')`,
      [ws, requestId],
    );
    await tx.rows(
      "insert into apps.intake_sweep (request_id, workspace_id) values ($1, $2) on conflict do nothing",
      [requestId, ws],
    );
    await tx.rows(
      "insert into apps.intake_escalation (request_id, workspace_id, key) values ($1, $2, 'k')",
      [requestId, ws],
    );
    await tx.rows(
      "insert into apps.intake_watcher (request_id, workspace_id, user_id) values ($1, $2, $3)",
      [requestId, ws, owner],
    );
    return { serviceId, vaultId, typeId, requestId, documentId, channelId };
  };
  const intakes = { acme: await intake(acme, ana), beta: await intake(beta, bob) };

  // Seeded as the table owner, as the earlier objects are.
  const library = async (ws: string, owner: string) => {
    const promptId = await id(
      `insert into library.prompt (workspace_id, owner_id, name, body)
       values ($1, $2, 'Summarise', 'Summarise {{document}}') returning id`,
      [ws, owner],
    );
    const templateId = await id(
      `insert into library.template (workspace_id, owner_id, name) values ($1, $2, 'Letterhead')
       returning id`,
      [ws, owner],
    );
    await tx.rows(
      `insert into library.template_version
         (workspace_id, template_id, no, file_name, bytes, sha256, created_by)
       values ($1, $2, 1, 'firm.docx', '\\x504b', repeat('a', 64), $3)`,
      [ws, templateId, owner],
    );
    return { promptId, templateId };
  };
  const libraryItems = { acme: await library(acme, ana), beta: await library(beta, bob) };

  // The OIDC tables the app can read, seeded in beta only.
  await tx.rows(
    "insert into core.oidc_provider (workspace_id, issuer, client_id) values ($1, 'https://idp.beta.test', 'beta-client')",
    [beta],
  );
  await tx.rows(
    "insert into core.external_identity (workspace_id, user_id, issuer, subject, linked_via) values ($1, $2, 'https://idp.beta.test', 'sub-bob', 'email')",
    [beta, bob],
  );

  // One of each notification table in beta only, so the notification tests start from nothing
  // in acme (they check the other workspace stays untouched).
  await tx.rows(
    `insert into notify.notification (workspace_id, user_id, kind, category, object_type,
       object_id, title, url)
     values ($1, $2, 'thread.shared', 'threads', 'thread', core.uuid7(), 'Shared thread', '#/t/x')`,
    [beta, bob],
  );
  await tx.rows(
    "insert into notify.notification_pref (workspace_id, user_id, category, value) values ($1, $2, 'vault', true)",
    [beta, bob],
  );
  await tx.rows(
    `insert into notify.notification_quiet_hours (workspace_id, user_id, from_local, to_local, tz)
     values ($1, $2, '22:00', '07:00', 'UTC')`,
    [beta, bob],
  );
  await tx.rows(
    "insert into notify.workspace_notification_pref (workspace_id, category) values ($1, 'vault')",
    [beta],
  );
  await tx.rows("insert into notify.workspace_notification_setting (workspace_id) values ($1)", [
    beta,
  ]);
  await tx.rows(
    `insert into notify.email_outbox (workspace_id, user_id, category, batch_key, payload)
     values ($1, $2, 'threads', 'seed', '{}')`,
    [beta, bob],
  );

  // One of each retention table in beta, so isolation tests have rows to look for.
  const retentionPolicy = await id(
    `insert into retention.policy (workspace_id, scope, scope_id, hours)
     values ($1, 'workspace', $1, 24) returning id`,
    [beta],
  );
  const retentionJob = await id(
    `insert into retention.deletion_job (workspace_id, kind, policy_id) values ($1, 'sweep', $2)
     returning id`,
    [beta, retentionPolicy],
  );
  await tx.rows(
    `insert into retention.hold (workspace_id, object_type, object_id, reason, set_by)
     values ($1, 'matter', $2, 'Seed', $3)`,
    [beta, randomUUID(), bob],
  );
  await tx.rows(
    `insert into retention.recycle_bin (workspace_id, object_type, object_id, label, policy_id, job_id,
                                        restorable_until)
     values ($1, 'thread', $2, 'Seed', $3, $4, now() + interval '30 days')`,
    [beta, randomUUID(), retentionPolicy, retentionJob],
  );
  await tx.rows(
    `insert into retention.warning_sent (workspace_id, vault_id, lead_days, expires_on)
     values ($1, $2, 7, current_date)`,
    [beta, randomUUID()],
  );

  // SCIM state in beta: the mass-delete guard, one recorded removal and one group-role mapping.
  await tx.rows("insert into scim.guard (workspace_id) values ($1)", [beta]);
  await tx.rows(
    "insert into scim.deprovision_event (workspace_id, user_id, via) values ($1, $2, 'delete')",
    [beta, bob],
  );
  await tx.rows(
    `insert into scim.group_role (workspace_id, group_id, role_id, needs_confirmation, state, requested_by)
     values ($1, $2, $3, false, 'active', $4)`,
    [beta, betaTeam, betaAdmin, bob],
  );

  // A review table with one row, column, cell, citation, history entry, star and run.
  const reviewTable = async (
    ws: string,
    owner: string,
    doc: { documentId: string; versionId: string },
  ) => {
    const tableId = await id(
      `insert into work.review_table (workspace_id, owner_id, name, source_kind)
       values ($1, $2, 'Deal review', 'uploads') returning id`,
      [ws, owner],
    );
    const rowId = await id(
      `insert into work.rt_row (workspace_id, table_id, ordinal, document_ids)
       values ($1, $2, 0, array[$3::uuid]) returning id`,
      [ws, tableId, doc.documentId],
    );
    const columnId = await id(
      `insert into work.rt_column (workspace_id, table_id, ordinal, label, type, prompt)
       values ($1, $2, 0, 'Governing law', 'free', 'Which law governs?') returning id`,
      [ws, tableId],
    );
    const cellId = await id(
      `insert into work.rt_cell (workspace_id, table_id, row_id, column_id, status, value_text)
       values ($1, $2, $3, $4, 'done', 'New York') returning id`,
      [ws, tableId, rowId, columnId],
    );
    await tx.rows(
      `insert into work.rt_cell_citation
         (workspace_id, table_id, cell_id, ordinal, version_id, quote, status)
       values ($1, $2, $3, 1, $4, 'governed by New York law', 'unresolved')`,
      [ws, tableId, cellId, doc.versionId],
    );
    await tx.rows(
      `insert into work.rt_cell_history (workspace_id, table_id, cell_id, actor_id, field, new)
       values ($1, $2, $3, $4, 'value', '"New York"')`,
      [ws, tableId, cellId, owner],
    );
    await tx.rows(
      "insert into work.rt_star (workspace_id, table_id, user_id) values ($1, $2, $3)",
      [ws, tableId, owner],
    );
    await tx.rows(
      `insert into work.run (workspace_id, owner_id, kind, status, table_id, column_id)
       values ($1, $2, 'rt_column', 'done', $3, $4)`,
      [ws, owner, tableId, columnId],
    );
    const templateId = await id(
      `insert into work.rt_template (workspace_id, owner_id, name, columns)
       values ($1, $2, 'Credit terms', '[]') returning id`,
      [ws, owner],
    );
    return { tableId, rowId, columnId, cellId, templateId };
  };
  const reviewTables = {
    acme: await reviewTable(acme, ana, documents.acme),
    beta: await reviewTable(beta, bob, documents.beta),
  };

  // A live workflow in each workspace.
  const workflow = async (ws: string, owner: string) => {
    const workflowId = await id(
      "insert into work.workflow (workspace_id, owner_id, title) values ($1, $2, 'NDA summary') returning id",
      [ws, owner],
    );
    const versionId = await id(
      `insert into work.workflow_version (workspace_id, workflow_id, no, definition, created_by)
       values ($1, $2, 1, $3, $4) returning id`,
      [ws, workflowId, WORKFLOW_DEFINITION, owner],
    );
    await tx.rows("update work.workflow set live_version_id = $2, status = 'live' where id = $1", [
      workflowId,
      versionId,
    ]);
    return { workflowId, versionId };
  };
  const workflows = { acme: await workflow(acme, ana), beta: await workflow(beta, bob) };

  // An agent with a live version, an upload, a schedule, a pending share and a dismissed nudge.
  const agent = async (ws: string, owner: string, doc: { documentId: string }) => {
    const agentId = await id("select core.uuid7() as id", []);
    const versionId = await id("select core.uuid7() as id", []);
    await tx.rows(
      `insert into work.agent (id, workspace_id, owner_id, title, live_version_id)
       values ($1, $2, $3, 'NDA first pass', $4)`,
      [agentId, ws, owner, versionId],
    );
    await tx.rows(
      `insert into work.agent_version (id, workspace_id, agent_id, no, instructions, details,
                                       created_by)
       values ($1, $2, $3, 1, 'Review the NDA.', '{"title":"NDA first pass"}', $4)`,
      [versionId, ws, agentId, owner],
    );
    await tx.rows(
      `insert into work.agent_document (workspace_id, agent_id, document_id) values ($1, $2, $3)`,
      [ws, agentId, doc.documentId],
    );
    await tx.rows(
      `insert into work.agent_schedule (workspace_id, agent_id, user_id, rule, params, time_local,
                                        tz)
       values ($1, $2, $3, 'weekly', '{"weekdays":[1]}', '08:00', 'UTC')`,
      [ws, agentId, owner],
    );
    await tx.rows(
      `insert into work.share_request (workspace_id, resource_type, resource_id, principal_type,
                                       principal_id, level, approver, requested_by)
       values ($1, 'agent', $2, 'workspace', $1, 'run', 'agents_admin', $3)`,
      [ws, agentId, owner],
    );
    await tx.rows(`insert into work.sharing_config (workspace_id) values ($1)`, [ws]);
    await tx.rows(
      `insert into work.agent_nudge_dismissal (workspace_id, user_id, agent_id)
       values ($1, $2, $3)`,
      [ws, owner, agentId],
    );
    return { agentId, versionId };
  };
  const agents = {
    acme: await agent(acme, ana, documents.acme),
    beta: await agent(beta, bob, documents.beta),
  };

  // A Space with a phase, a task, a comment, a shared resource, an activity row, a template and
  // a request to join, in each workspace.
  const space = async (ws: string, owner: string, asker: string) => {
    const spaceId = await id(
      `insert into work.space (workspace_id, name, created_by) values ($1, 'Deal room', $2) returning id`,
      [ws, owner],
    );
    const phaseId = await id(
      `insert into work.phase (workspace_id, space_id, ordinal, name) values ($1, $2, 1, 'Diligence') returning id`,
      [ws, spaceId],
    );
    const taskId = await id(
      `insert into work.task (workspace_id, space_id, phase_id, name, created_by)
       values ($1, $2, $3, 'Review the MSA', $4) returning id`,
      [ws, spaceId, phaseId, owner],
    );
    await tx.rows(
      `insert into work.task_comment (workspace_id, space_id, task_id, author_id, body_md)
       values ($1, $2, $3, $4, 'Started.')`,
      [ws, spaceId, taskId, owner],
    );
    await tx.rows(
      `insert into work.space_resource (workspace_id, space_id, resource_type, resource_id, access, granted_by)
       values ($1, $2, 'vault', core.uuid7(), 'view', $3)`,
      [ws, spaceId, owner],
    );
    await tx.rows(
      `insert into work.space_activity (workspace_id, space_id, actor_id, type) values ($1, $2, $3, 'task.created')`,
      [ws, spaceId, owner],
    );
    await tx.rows(
      `insert into work.space_template (workspace_id, owner_id, name, definition)
       values ($1, $2, 'Deal template', '{"schema": "counsel.space-template/1"}')`,
      [ws, owner],
    );
    await tx.rows(
      `insert into work.space_access_request (workspace_id, space_id, user_id) values ($1, $2, $3)`,
      [ws, spaceId, asker],
    );
    return { spaceId, phaseId, taskId };
  };
  const spaces = { acme: await space(acme, ana, ben), beta: await space(beta, bob, bob) };

  // A fact table in each Space: one fact with its quote, version, names and trail.
  const facts = async (
    ws: string,
    owner: string,
    spaceId: string,
    doc: { documentId: string; versionId: string },
  ) => {
    const factId = await id(
      `insert into apps.fact (workspace_id, space_id, created_by, source, source_documents, text,
         date_precision)
       values ($1, $2, $3, 'manual', array[$4::uuid], 'The notice was sent.', 'unknown')
       returning id`,
      [ws, spaceId, owner, doc.documentId],
    );
    await tx.rows(
      `insert into apps.fact_version (workspace_id, fact_id, no, text, date_precision, edited_by)
       values ($1, $2, 1, 'The notice was sent.', 'unknown', $3)`,
      [ws, factId, owner],
    );
    await tx.rows(
      `insert into apps.fact_citation (workspace_id, fact_id, document_id, document_version_id,
         page_no, char_from, char_to, quote)
       values ($1, $2, $3, $4, 1, 0, 4, 'Term')`,
      [ws, factId, doc.documentId, doc.versionId],
    );
    const entityId = await id(
      `insert into apps.entity (workspace_id, space_id, kind, canonical_name, origin, created_by)
       values ($1, $2, 'org', 'Acme', 'manual', $3) returning id`,
      [ws, spaceId, owner],
    );
    const issueId = await id(
      `insert into apps.issue (workspace_id, space_id, name, origin, created_by)
       values ($1, $2, 'Delay', 'manual', $3) returning id`,
      [ws, spaceId, owner],
    );
    await tx.rows(
      `insert into apps.fact_entity (workspace_id, space_id, fact_id, entity_id, via)
       values ($1, $2, $3, $4, 'manual')`,
      [ws, spaceId, factId, entityId],
    );
    await tx.rows(
      `insert into apps.fact_issue (workspace_id, space_id, fact_id, issue_id, via)
       values ($1, $2, $3, $4, 'manual')`,
      [ws, spaceId, factId, issueId],
    );
    await tx.rows(
      `insert into apps.fact_audit (workspace_id, space_id, fact_id, actor_id, action)
       values ($1, $2, $3, $4, 'created')`,
      [ws, spaceId, factId, owner],
    );
    // An extraction of that document into the table, as a run of its own kind.
    const runId = await id(
      `insert into work.run (workspace_id, owner_id, kind, status, space_id)
       values ($1, $2, 'fact_extraction', 'done', $3) returning id`,
      [ws, owner, spaceId],
    );
    await tx.rows(
      `insert into apps.fact_extraction (id, workspace_id, space_id, requested_by, state)
       values ($1, $2, $3, $4, 'done')`,
      [runId, ws, spaceId, owner],
    );
    await tx.rows(
      `insert into apps.fact_extraction_document (extraction_id, workspace_id, document_id,
         document_version_id, position, state, reason)
       values ($1, $2, $3, $4, 0, 'failed', 'NO_TEXT')`,
      [runId, ws, doc.documentId, doc.versionId],
    );
    return { factId, entityId, issueId, runId };
  };
  const factTables = {
    acme: await facts(acme, ana, spaces.acme.spaceId, documents.acme),
    beta: await facts(beta, bob, spaces.beta.spaceId, documents.beta),
  };
  // A horizon scan with something found, per workspace.
  const horizon = async (ws: string, owner: string) => {
    await tx.rows("insert into apps.horizon_settings (workspace_id, enabled) values ($1, true)", [
      ws,
    ]);
    const scanId = await id(
      `insert into apps.horizon_scan (workspace_id, owner_id, name, purpose, sources, from_date)
       values ($1, $2, 'Widgets', 'Rules about widgets', array['fr'], current_date) returning id`,
      [ws, owner],
    );
    await tx.rows(
      `insert into apps.horizon_cursor (workspace_id, scan_id, source_id, cursor)
       values ($1, $2, 'fr', '{"since": "2026-01-01"}')`,
      [ws, scanId],
    );
    const itemId = await id(
      `insert into apps.horizon_item (workspace_id, scan_id, source_id, external_id, url, title,
         summary, doc_type, jurisdiction, published_on, relevance, explanation)
       values ($1, $2, 'fr', '2026-00001', 'https://www.federalregister.gov/d/2026-00001',
         'Widget rule', '', 'rule', 'US', current_date, 'high', 'About widgets.') returning id`,
      [ws, scanId],
    );
    await tx.rows(
      "insert into apps.horizon_item_state (workspace_id, user_id, item_id) values ($1, $2, $3)",
      [ws, owner, itemId],
    );
    await tx.rows(
      "insert into apps.horizon_spend (workspace_id, owner_id, usd) values ($1, $2, 0)",
      [ws, owner],
    );
    return { scanId, itemId };
  };
  const horizons = { acme: await horizon(acme, ana), beta: await horizon(beta, bob) };

  // Web search turned on, a matter it is kept from, and a page a run read, per workspace.
  const web = async (ws: string, matterId: string, runId: string) => {
    await tx.rows("insert into work.web_settings (workspace_id, enabled) values ($1, true)", [ws]);
    await tx.rows("insert into work.web_blocked_matter (workspace_id, matter_id) values ($1, $2)", [
      ws,
      matterId,
    ]);
    await tx.rows(
      `insert into work.web_fetch_cache (workspace_id, run_id, url, title, text, fetched_at)
       values ($1, $2, 'https://example.org/a', 'A', 'Page text.', now())`,
      [ws, runId],
    );
  };
  await web(acme, m1, threads.acme.runId);
  await web(beta, mb, threads.beta.runId);

  // An external Space with a party, its connection, an invite, a guest and a login code, per workspace.
  const guestRoom = async (ws: string, owner: string, domain: string) => {
    const spaceId = await id(
      `insert into work.space (workspace_id, name, kind, created_by) values ($1, 'Outside room', 'external', $2) returning id`,
      [ws, owner],
    );
    const partyId = await id(
      `insert into work.space_party (workspace_id, space_id, name, domain, created_by)
       values ($1, $2, 'Other LLP', $3, $4) returning id`,
      [ws, spaceId, domain, owner],
    );
    await tx.rows(
      `insert into work.space_connection (workspace_id, space_id, party_id) values ($1, $2, $3)`,
      [ws, spaceId, partyId],
    );
    await tx.rows(
      `insert into work.guest_invite (workspace_id, space_id, party_id, email, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, sha256(gen_random_uuid()::text::bytea), $5, now() + interval '7 days')`,
      [ws, spaceId, partyId, `x@${domain}`, owner],
    );
    const guestId = await id(
      `insert into core."user" (workspace_id, email, status, kind) values ($1, $2, 'active', 'guest') returning id`,
      [ws, `y@${domain}`],
    );
    await tx.rows(
      `insert into core.guest_profile (workspace_id, user_id, email_domain, expires_at)
       values ($1, $2, $3, now() + interval '30 days')`,
      [ws, guestId, domain],
    );
    await tx.rows(
      `insert into core.guest_login_code (workspace_id, user_id, code_hash, expires_at)
       values ($1, $2, sha256(gen_random_uuid()::text::bytea), now() + interval '10 minutes')`,
      [ws, guestId],
    );
    return { spaceId, partyId, guestId };
  };
  const guestRooms = {
    acme: await guestRoom(acme, ana, "other.test"),
    beta: await guestRoom(beta, bob, "other.test"),
  };
  // One of each memory table in beta only, so the memory tests start from nothing in acme.
  await tx.rows(
    `insert into memory.memory (workspace_id, user_id, text, source, normalized_hash)
     values ($1, $2, 'Use UK spelling', 'manual', repeat('a', 64))`,
    [beta, bob],
  );
  await tx.rows(
    "insert into memory.memory_candidate (workspace_id, user_id, text) values ($1, $2, 'Be formal')",
    [beta, bob],
  );
  await tx.rows("insert into memory.memory_setting (workspace_id, user_id) values ($1, $2)", [
    beta,
    bob,
  ]);
  await tx.rows(
    "insert into memory.memory_import (workspace_id, user_id, rows) values ($1, $2, '[]')",
    [beta, bob],
  );
  await tx.rows(
    "insert into memory.message_use (message_id, workspace_id, user_id) values ($1, $2, $3)",
    [threads.beta.messageId, beta, bob],
  );
  await tx.rows(
    `insert into memory.writing_style (workspace_id, owner_id, name, kind, instructions)
     values ($1, $2, 'Terse', 'instructions', 'Short sentences.')`,
    [beta, bob],
  );

  // Command Center: one of each analytics table in beta only.
  await tx.rows(
    "insert into analytics.usage_event (workspace_id, user_id, access_point, surface, action, action_class) values ($1, $2, 'web', 'web', 'thread.message', 'query')",
    [beta, bob],
  );
  await tx.rows(
    "insert into analytics.outcome_event (workspace_id, user_id, workflow_type, baseline_hours, hours_saved) values ($1, $2, 'contract_reviewed', 2, 2)",
    [beta, bob],
  );
  await tx.rows(
    "insert into analytics.outcome_baseline (workspace_id, workflow_type, hours_per_completion) values ($1, 'contract_reviewed', 2)",
    [beta],
  );
  await tx.rows(
    "insert into analytics.daily (workspace_id, day, metrics) values ($1, current_date, '{}')",
    [beta],
  );
  await tx.rows("insert into analytics.refresh_state (workspace_id) values ($1)", [beta]);
  await tx.rows(
    "insert into analytics.action_dismissal (workspace_id, user_id, action_key, dismissed_until) values ($1, $2, 'sso', now() + interval '30 days')",
    [beta, bob],
  );
  await tx.rows(
    "insert into analytics.export_job (workspace_id, requested_by, params) values ($1, $2, '{}')",
    [beta, bob],
  );

  // Models and connectors admin: one of each table in beta only.
  await tx.rows(
    "insert into admin.secret (id, workspace_id, ciphertext) values ('sec_' || md5(random()::text), $1, decode(repeat('00', 40), 'hex'))",
    [beta],
  );
  await tx.rows(
    "insert into admin.model_config (workspace_id, provider, model) values ($1, 'anthropic', 'claude-haiku-5-5')",
    [beta],
  );
  await tx.rows("insert into admin.model_policy (workspace_id) values ($1)", [beta]);
  const connectorId = (
    await tx.rows<{ id: string }>(
      "insert into admin.connector (workspace_id, name, url, auth_kind) values ($1, 'Docs', 'https://mcp.example.com/mcp', 'none') returning id",
      [beta],
    )
  )[0]?.id;
  await tx.rows(
    `insert into admin.connector_tool (workspace_id, connector_id, name, tool_hash)
     values ($1, $2, 'search', repeat('c', 64))`,
    [beta, connectorId],
  );
  await tx.rows(
    `insert into admin.connector_user_policy (workspace_id, connector_id, user_id, tool_name, policy)
     values ($1, $2, $3, 'search', 'block')`,
    [beta, connectorId, bob],
  );

  // Drive and SharePoint sync: a connection, a synced vault and one mapped file, beta only.
  const syncRef = "sec_" + "ab".repeat(16);
  await tx.rows(
    "insert into admin.secret (id, workspace_id, ciphertext) values ($1, $2, decode(repeat('00', 40), 'hex'))",
    [syncRef, beta],
  );
  const syncConnection = (
    await tx.rows<{ id: string }>(
      `insert into content.sync_connection (workspace_id, user_id, provider, secret_ref)
       values ($1, $2, 'google_drive', $3) returning id`,
      [beta, bob, syncRef],
    )
  )[0]?.id;
  await tx.rows(
    `insert into content.vault_sync (vault_id, workspace_id, connection_id, provider, root_remote_id)
     values ($1, $2, $3, 'google_drive', 'root1')`,
    [vaults.beta.vaultId, beta, syncConnection],
  );
  await tx.rows(
    `insert into content.sync_item (vault_id, remote_id, workspace_id, kind, name)
     values ($1, 'f1', $2, 'folder', 'Contracts')`,
    [vaults.beta.vaultId, beta],
  );

  return {
    guestRooms,
    workflows,
    agents,
    documents,
    intakes,
    horizons,
    factTables,
    vaults,
    spaces,
    threads,
    playbooks,
    reviews,
    reviewTables,
    library: libraryItems,
    slugs: { acme: `acme-${tag}`, beta: `beta-${tag}` },
    secrets,
    objects: { t1, tb },
    matters: { m1, m2, m3, mb },
    acme,
    beta,
    roles: { acmeAdmin, acmeUser, betaAdmin },
    groups: { corpTeam, litTeam, everyone, partyP, betaTeam },
    ana,
    ben,
    cal,
    sue,
    gia,
    dee,
    bob,
  };
}

export type Seed = Awaited<ReturnType<typeof seed>>;
