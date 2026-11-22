import { type CatalogueEntry, files, sample, workflow } from "./define.js";

const audio = files("Board meeting.m4a", "Witness interview.mp3");

export const transcribe: CatalogueEntry = {
  key: "transcribe",
  title: "Transcribe Audio to Text",
  description: "Makes a Word transcript of each recording, with speakers and timestamps.",
  category: "Financial services",
  definition: workflow(
    [
      {
        type: "user_input.file",
        id: "audio",
        label: "Audio",
        prompt: "Add up to 10 recordings, each up to 4 hours.",
        max: 10,
        accept: [".mp3", ".m4a", ".wav"],
      },
      {
        type: "drafting",
        id: "transcripts",
        label: "Transcripts",
        format: "docx",
        mode: "edit_file",
        base: "@Audio",
        instructions:
          "Transcribe the recording word for word. Label each speaker and put a timestamp at the start of each turn. Mark inaudible passages.",
        track_changes: false,
      },
      {
        type: "response",
        id: "out",
        outputs: [{ ref: "@Transcripts", as: "file", title: "Transcripts" }],
        allow_follow_ups: true,
      },
    ],
    [
      ["audio", "transcripts"],
      ["transcripts", "out"],
    ],
  ),
  sample: sample({ Audio: audio.refs }, audio),
};
