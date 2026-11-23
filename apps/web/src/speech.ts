// Read-aloud in the browser with the system's own voices (on a Mac, Hungarian text with Tünde).
// Only voices that run on this device: Chrome also lists network voices, which would send the
// text to Google.
import { isHungarian, speakable } from "@achords/i18n";

export const canSpeak = () => typeof speechSynthesis !== "undefined";

const localVoice = (lang: string) => {
  const local = speechSynthesis.getVoices().filter((v) => v.localService);
  const norm = (l: string) => l.replace("_", "-").toLowerCase();
  return (
    local.find((v) => norm(v.lang) === norm(lang)) ??
    local.find((v) => norm(v.lang).startsWith(norm(lang).split("-")[0] as string))
  );
};

/** Reads the text aloud; `onEnd` runs when it finishes, is stopped or no local voice fits. */
export function speak(text: string, onEnd: () => void): void {
  speechSynthesis.cancel();
  const said = speakable(text);
  const lang = isHungarian(said) ? "hu-HU" : navigator.language || "en-US";
  const voice = localVoice(lang) ?? localVoice("en-US");
  if (!said || !voice) {
    onEnd();
    return;
  }
  const u = new SpeechSynthesisUtterance(said);
  u.voice = voice;
  u.lang = voice.lang;
  u.onend = onEnd;
  u.onerror = onEnd;
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak()) speechSynthesis.cancel();
}
