import { useRef, useState } from "preact/hooks";
import { transcribe } from "./api.ts";

export type RecState = "idle" | "recording" | "transcribing";

/**
 * Microphone → MediaRecorder → local Whisper on the gateway. The text is handed back for the
 * owner to review in the composer; nothing is sent automatically.
 */
export function useRecorder(onText: (text: string) => void, onError: (msg: string) => void) {
  const [state, setState] = useState<RecState>("idle");
  const rec = useRef<MediaRecorder | undefined>(undefined);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        for (const track of stream.getTracks()) track.stop(); // release the mic indicator
        setState("transcribing");
        try {
          onText(await transcribe(new Blob(chunks, { type: r.mimeType })));
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setState("idle");
        }
      };
      r.start();
      rec.current = r;
      setState("recording");
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const stop = () => rec.current?.stop();
  return { state, start, stop };
}
