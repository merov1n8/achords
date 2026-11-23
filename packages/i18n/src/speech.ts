// Read-aloud (web and Telegram): the text a voice should say, and which language it is in.

/** Markdown marks, code blocks and link targets out; what is left reads naturally. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Hungarian text gets a Hungarian voice; anything else the system default. */
export function isHungarian(text: string): boolean {
  if (/[őűŐŰ]/.test(text)) return true;
  const accents = text.match(/[áéíóöúüÁÉÍÓÖÚÜ]/g)?.length ?? 0;
  const common = new Set(["és", "az", "hogy", "nem", "egy", "van", "ez", "meg", "ha", "már"]);
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => common.has(w)).length;
  return accents >= 3 && words >= 1;
}
