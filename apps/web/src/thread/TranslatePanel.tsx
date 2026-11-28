import {
  TRANSLATE_LIMITS,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "@legallabs/contracts";
import { Button, Checkbox, PANEL_MIN, SidePanel, Textarea } from "@legallabs/ui";
import { type FormEvent, useId, useState } from "react";
import { api, messageOf, type Thread } from "../api.js";

/** Translates files of the thread into .docx copies, or words into the thread itself. */
export function TranslatePanel({
  thread,
  initialText,
  onStarted,
  onClose,
}: {
  thread: Thread;
  initialText: string;
  onStarted: () => void;
  onClose: () => void;
}) {
  const [width, setWidth] = useState(PANEL_MIN);
  const [language, setLanguage] = useState<TranslationLanguage>("fr");
  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const files = chosen.length > 0;
  const ready = files || text.trim().length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.translate(thread.id, {
        target_lang: language,
        ...(files ? { document_ids: chosen } : { text }),
      });
      onStarted();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel title="Translate" onClose={onClose} width={width} onWidthChange={setWidth}>
      <form onSubmit={submit} className="grid gap-4 text-dense">
        <label className="grid gap-1" htmlFor={`${id}-lang`}>
          Into
          <select
            id={`${id}-lang`}
            value={language}
            onChange={(e) => setLanguage(e.target.value as TranslationLanguage)}
            className="h-8 rounded-md border border-border bg-bg px-2"
          >
            {Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {thread.documents.length > 0 && (
          <fieldset className="grid gap-1">
            <legend className="font-semibold">Files, up to {TRANSLATE_LIMITS.documents}</legend>
            {thread.documents.map((document) => (
              <div key={document.id} className="flex items-center gap-1">
                <Checkbox
                  id={`${id}-${document.id}`}
                  checked={chosen.includes(document.id)}
                  disabled={
                    !chosen.includes(document.id) && chosen.length >= TRANSLATE_LIMITS.documents
                  }
                  onCheckedChange={() =>
                    setChosen((list) =>
                      list.includes(document.id)
                        ? list.filter((d) => d !== document.id)
                        : [...list, document.id],
                    )
                  }
                />
                <label htmlFor={`${id}-${document.id}`} className="truncate">
                  {document.name}
                </label>
              </div>
            ))}
          </fieldset>
        )}
        <label className="grid gap-1" htmlFor={`${id}-text`}>
          Or text
          <Textarea
            id={`${id}-text`}
            value={text}
            maxLength={TRANSLATE_LIMITS.textChars}
            disabled={files}
            onChange={(e) => setText(e.target.value)}
            className="min-h-32"
          />
        </label>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={!ready || busy}>
            Start translating
          </Button>
        </div>
      </form>
    </SidePanel>
  );
}
