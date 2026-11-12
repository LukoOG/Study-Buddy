// Wake phrase detection on the transcript ("Hey Buddy, …"). Cheap and needs no extra model,
// since every utterance is transcribed anyway. Swappable later for a dedicated wake-word
// model (e.g. openWakeWord) that runs before transcription.

// Whisper's common spellings of "Buddy" at the start of an utterance.
// "Body"-like spellings need a greeting first, so "A body moving at…" doesn't wake it.
const WAKE = /^\W*(?:(?:(?:hey|hi|hello|okay|ok|yo|eh)\W+)?(?:buddy|buddie|budi)|(?:hey|hi|hello|okay|ok|yo|eh)\W+(?:body|bodi|bodie|birdie|bud))\b\W*/i;
const STOP = /^(?:stop|wait|hold on|never ?mind|cancel|okay that'?s fine)\b/i;

export function parseUtterance(text) {
  const m = WAKE.exec(text);
  const rest = (m ? text.slice(m[0].length) : text).trim();
  return { woke: !!m, rest, stop: STOP.test(rest) };
}
