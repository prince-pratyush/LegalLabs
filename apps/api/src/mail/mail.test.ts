import { afterAll, afterEach, describe, expect, it } from "vitest";
import { emailGuestMailer } from "../spaces/guests.js";
import { seedMember, testPool } from "../test-db.js";
import { type FakeSmtp, startFakeSmtp } from "../test-smtp.js";
import { createSmtpEmailProvider, smtpConfigFromEnv } from "./smtp.js";
import { guestsInUse, mailStartupCheck } from "./startup.js";

const pool = testPool();
afterAll(() => pool.end());

let server: FakeSmtp | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const provider = (port: number, extra: object = {}) =>
  createSmtpEmailProvider({
    host: "127.0.0.1",
    port,
    security: "none",
    from: "no-reply@firm.test",
    ...extra,
  });

describe("SMTP sender", () => {
  it("delivers a guest's code, with the code in the body and never in the subject", async () => {
    server = await startFakeSmtp();
    const mailer = emailGuestMailer(
      provider(server.port, { auth: { user: "mailer", pass: "not-a-real-password" } }),
    );
    await mailer.sendCode({ workspace: "acme", email: "lead@other.test" }, "04815162");

    expect(server.received).toHaveLength(1);
    const mail = server.received[0];
    expect(mail?.from).toBe("no-reply@firm.test");
    expect(mail?.to).toEqual(["lead@other.test"]);
    expect(mail?.auth).toBe("\0mailer\0not-a-real-password");
    const [headers, body] = (mail?.data ?? "").split("\r\n\r\n", 2);
    expect(headers).toContain("Subject: Your LegalLabs sign-in code");
    expect(headers).not.toContain("04815162");
    expect(body).toContain("04815162");
    expect(body).toContain('"acme"');
  });

  it("cannot be made to add a recipient through a name", async () => {
    server = await startFakeSmtp();
    await provider(server.port).send({
      to: { email: "ana@firm.test", name: 'x" <evil@bad.test>, "y\r\nBcc: evil@bad.test' },
      subject: "hello\r\nBcc: evil@bad.test",
      text: "body",
    });
    expect(server.received[0]?.to).toEqual(["ana@firm.test"]);
  });

  it("marks system mail so mail systems don't answer it", async () => {
    server = await startFakeSmtp();
    const sender = provider(server.port);
    const to = { email: "jo@acme.example", name: "" };
    await sender.send({ to, subject: "s", text: "t", auto: true });
    await sender.send({ to, subject: "s", text: "t" });
    const [system, person] = server.received.map((m) => m.data.split("\r\n\r\n")[0]);
    expect(system).toContain("Auto-Submitted: auto-replied");
    expect(system).toContain("X-Auto-Response-Suppress: All");
    expect(person).not.toContain("Auto-Response-Suppress");
  });

  it("reports a refusal without repeating the address or the message", async () => {
    server = await startFakeSmtp();
    server.rejectRecipients();
    const failure = await provider(server.port)
      .send({ to: { email: "lead@other.test", name: "" }, subject: "s", text: "04815162" })
      .then(
        () => null,
        (err: Error) => err,
      );
    expect(failure?.name).toBe("EENVELOPE");
    const everything = `${failure?.message} ${failure?.stack} ${JSON.stringify(failure)}`;
    expect(everything).not.toContain("lead@other.test");
    expect(everything).not.toContain("04815162");
  });

  it("will not fall back to plain text when STARTTLS is asked for", async () => {
    server = await startFakeSmtp();
    await expect(
      provider(server.port, { security: "starttls" }).send({
        to: { email: "lead@other.test", name: "" },
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow();
    expect(server.received).toHaveLength(0);
  });
});

describe("mail configuration", () => {
  const base = { LEGALLABS_SMTP_HOST: "mail.firm.test", LEGALLABS_MAIL_FROM: "a@firm.test" };

  it("is off when nothing is set, and uses STARTTLS on 587 by default", () => {
    expect(smtpConfigFromEnv({})).toBeNull();
    expect(smtpConfigFromEnv(base)).toEqual({
      host: "mail.firm.test",
      port: 587,
      security: "starttls",
      from: "a@firm.test",
    });
    expect(smtpConfigFromEnv({ ...base, LEGALLABS_SMTP_SECURITY: "tls" })?.port).toBe(465);
  });

  it("refuses a half-set or unsafe configuration", () => {
    for (const env of [
      { LEGALLABS_MAIL_FROM: "a@firm.test" },
      { LEGALLABS_SMTP_HOST: "mail.firm.test" },
      { ...base, LEGALLABS_SMTP_USER: "u" },
      { ...base, LEGALLABS_SMTP_PORT: "smtp" },
      { ...base, LEGALLABS_SMTP_SECURITY: "ssl" },
      { ...base, LEGALLABS_SMTP_SECURITY: "none", NODE_ENV: "production" },
      {
        ...base,
        LEGALLABS_SMTP_SECURITY: "none",
        LEGALLABS_SMTP_USER: "u",
        LEGALLABS_SMTP_PASSWORD: "p",
      },
    ]) {
      expect(() => smtpConfigFromEnv(env), JSON.stringify(env)).toThrow();
    }
  });

  it("stops production only when there are guests and no mail server", () => {
    const check = (NODE_ENV: string, configured: boolean, guests: boolean) =>
      mailStartupCheck({ NODE_ENV }, { configured, guests }).action;
    expect(check("production", false, true)).toBe("refuse");
    expect(check("production", false, false)).toBe("warn");
    expect(check("development", false, true)).toBe("warn");
    expect(check("production", true, true)).toBe("ok");
  });

  it("finds an open invite or a live guest, through the worker role", async () => {
    const ana = await seedMember(pool);
    // Other test files share the database, so only this one's rows are changed and rolled back.
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("update work.guest_invite set revoked_at = now() where revoked_at is null");
      await db.query("update core.guest_profile set deactivated_at = now()");
      const used = async () => {
        await db.query("set local role legallabs_worker");
        const { rows } = await db.query<{ used: boolean }>("select admin.guests_in_use() as used");
        await db.query("reset role");
        return rows[0]?.used;
      };
      expect(await used()).toBe(false);
      const guest = await db.query<{ id: string }>(
        `insert into core."user" (workspace_id, email, status, kind)
         values ($1, 'g@other.test', 'active', 'guest') returning id`,
        [ana.workspaceId],
      );
      await db.query(
        `insert into core.guest_profile (workspace_id, user_id, email_domain, expires_at)
         values ($1, $2, 'other.test', now() + interval '1 day')`,
        [ana.workspaceId, guest.rows[0]?.id],
      );
      expect(await used()).toBe(true);
    } finally {
      await db.query("rollback");
      db.release();
    }
    expect(typeof (await guestsInUse(pool))).toBe("boolean");
  });
});
