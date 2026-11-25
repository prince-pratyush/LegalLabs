/** One plain-text email. No HTML: the web app is where people read the thing itself. */
export interface EmailMessage {
  to: { email: string; name: string };
  subject: string;
  text: string;
}

/** Where mail goes out; `mail/smtp.ts` is the one that really sends. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** For tests: keeps what was sent, and can be told to fail the next sends. */
export interface FakeEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[];
  failNext(times?: number): void;
  clear(): void;
}

export function createFakeEmailProvider(): FakeEmailProvider {
  const sent: EmailMessage[] = [];
  let failures = 0;
  return {
    sent,
    failNext(times = 1) {
      failures = times;
    },
    clear() {
      sent.length = 0;
    },
    async send(message) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("fake provider failure");
      }
      sent.push(message);
    },
  };
}

/**
 * The default provider: writes the recipient's domain and the subject to the log and sends
 * nothing. Bodies and addresses stay out of logs.
 */
export function createLogEmailProvider(
  log: (line: string) => void = (line) => console.log(line),
): EmailProvider {
  return {
    async send(message) {
      const domain = message.to.email.split("@")[1] ?? "unknown";
      log(`email to @${domain}: ${message.subject}`);
    },
  };
}
