import { createServer, type Socket } from "node:net";

export interface ReceivedMail {
  from: string;
  to: string[];
  /** Headers and body, with quoted-printable undone. */
  data: string;
  auth: string | null;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  /** Refuses every recipient from now on, quoting the address as real servers do. */
  rejectRecipients(): void;
  stop(): Promise<void>;
}

const decode = (text: string) =>
  text
    .replace(/=\r\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** A mail server in this process: plain text, no STARTTLS, keeps what it is handed. */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  const sockets = new Set<Socket>();
  let rejecting = false;

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const say = (line: string) => socket.write(`${line}\r\n`);
    let buffer = "";
    let mail: ReceivedMail = { from: "", to: [], data: "", auth: null };
    let reading = false;
    say("220 fake ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (reading) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push({ ...mail, data: decode(buffer.slice(0, end)) });
          buffer = buffer.slice(end + 5);
          mail = { from: "", to: [], data: "", auth: mail.auth };
          reading = false;
          say("250 queued");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(" ")[0]?.toUpperCase();
        const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
        if (verb === "EHLO") say("250-fake\r\n250 AUTH PLAIN");
        else if (verb === "AUTH") {
          mail.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          say("235 ok");
        } else if (verb === "MAIL") {
          mail.from = address;
          say("250 ok");
        } else if (verb === "RCPT") {
          if (rejecting) say(`550 no mailbox <${address}>`);
          else {
            mail.to.push(address);
            say("250 ok");
          }
        } else if (verb === "DATA") {
          reading = true;
          say("354 go on");
        } else if (verb === "QUIT") {
          say("221 bye");
          socket.end();
        } else say("250 ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    port: typeof address === "object" && address ? address.port : 0,
    received,
    rejectRecipients() {
      rejecting = true;
    },
    stop() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
