# voice-input

### R-voice-input-001 · shipped
User can define custom terms or abbreviations to improve voice-recognition accuracy for words it otherwise mishears.
- asked: 2026-09-24
- shipped: 08f5844

### R-voice-input-002 · shipped
When voice input falls back to the phone's recogniser because the desktop transcriber is unavailable, the UI shows it.
- asked: 2026-09-27
- shipped: 91e1470

### R-voice-input-003 · shipped
Voice input shows when audio recording stops or reaches its limit, and for how long it has heard.
- asked: 2026-09-28
- shipped: 07b6504

### R-voice-input-004 · shipped
Every dictation button in the app is the same reusable voice input component, looking and behaving identically, with the compose bar's round microphone as the template.
- asked: 2026-10-05
- shipped: 6792295e

### R-voice-input-005 · shipped
The voice input button transcribes with the desktop's whisper and returns to it when the desktop connection comes back, instead of staying on the phone's own recogniser.
- asked: 2026-10-22
- shipped: 33047b20
- note: Item had the owner's complaint backwards: he disliked it feeling like on-device speech-to-text.


### R-voice-input-006 · shipped
The desktop sets up local dictation on a person's tap: whisper.cpp through brew on macOS, and a model chosen from a pinned list, downloaded from upstream and verified by sha256 — never bundled.
- asked: 2026-11-12 (owner)
- note: Host half (`dictatesetup.ts`, `shared/dictatemodels.ts`); refuses below model size + 2 GB free; nothing starts without the tap and a failure is never retried.

### R-voice-input-007 · shipped
Send tapped while a dictation is not back yet (microphone open, or a recording waiting to be read) asks whether to send the transcript unread the moment it returns or to read it first; when the words come from the phone's own recogniser the ask also warns that its transcription is far less accurate. A picture's own Send (the annotator's Send & run, Send all + submit and their when-it's-free twins) asks the same and holds the picture in the box with the words, rather than running without them.
- asked: 2026-11-14 (owner); the picture's Send 2026-11-23 (owner)
- note: `dictationSendAsk` (`composeSend.ts`); `useVoice`'s `pending`/`finish()`; the armed send is phone-held and in memory only, called off by tapping Send again. The picture's Send asks through `dictationGate` (`core/queue/uploads.ts`, `pictureGate.test.mjs`).
### R-voice-input-008 · shipped
When voice input falls back to the phone's recogniser, a pill says it is weaker and opens the local dictation setup row.
- asked: 2026-11-12
- shipped: 880d030aa

