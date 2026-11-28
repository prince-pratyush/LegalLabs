import { type Api, messageOf } from "@legallabs/addin";
import { Button, StatusText } from "@legallabs/ui";
import { useEffect, useState } from "react";
import type { MailHost, MailItem } from "../office/host.js";

/** Who a reply to the open message would go to, and the one way to start it. */
export function DraftCard({
  api,
  host,
  item,
  threadId,
  messageId,
  ungrounded,
}: {
  api: Api;
  host: MailHost;
  item: MailItem;
  threadId: string;
  messageId: string;
  /** Some sentences of the draft cite nothing. */
  ungrounded: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Undefined while being read. A reply may not go to the sender, so nothing is claimed early.
  const [replyTo, setReplyTo] = useState<string[] | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const read = async () => (host.item()?.itemId === item.itemId ? host.replyTo() : null);
    read()
      .catch(() => null)
      .then((found) => live && setReplyTo(found));
    return () => {
      live = false;
    };
  }, [host, item.itemId]);

  const to = replyTo && (replyTo.length > 0 ? replyTo : [item.from]);
  const elsewhere = replyTo?.some((a) => a.toLowerCase() !== item.from.toLowerCase());

  const create = async () => {
    setBusy(true);
    setError(null);
    setOpened(false);
    try {
      // The server turns the answer into the body, and refuses if a source forbids copies.
      const { body_html } = await api.post<{ body_html: string }>("/api/v1/addins/outlook/drafts", {
        thread_id: threadId,
        message_id: messageId,
      });
      // A reply goes to whoever sent the open message, so it must still be this one.
      if (host.item()?.itemId !== item.itemId) {
        setError("Another email is open now. Go back to the one this reply answers.");
        return;
      }
      host.reply(body_html);
      setOpened(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Draft reply" className="grid gap-2 rounded-md border border-border p-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-dense">
        {to && (
          <>
            <dt className="text-fg-muted">To</dt>
            <dd className="break-all">{to.join(", ")}</dd>
          </>
        )}
        <dt className="text-fg-muted">Subject</dt>
        <dd className="break-words">Re: {item.subject}</dd>
      </dl>
      {elsewhere && (
        <StatusText tone="warning">
          This email asks for replies to go to {replyTo?.join(", ")}, not to its sender {item.from}.
        </StatusText>
      )}
      {replyTo === null && (
        <StatusText tone="warning">Check the recipients in Outlook before you send.</StatusText>
      )}
      {ungrounded && (
        <StatusText tone="warning">
          Some of this draft has no source. Check it before you send it.
        </StatusText>
      )}
      <Button className="justify-self-start" disabled={busy} onClick={() => void create()}>
        Create in Outlook
      </Button>
      {opened && (
        <p className="text-dense text-fg-muted">
          Outlook opened a reply. Nothing is sent unless you send it.
        </p>
      )}
      {error && <StatusText tone="failed">{error}</StatusText>}
    </section>
  );
}
