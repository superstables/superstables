// Asking the owner for the wallet key's passphrase at a terminal. Nothing typed is echoed, and nothing here reads a
// passphrase from an argument, a file or the environment: an argument is in the process table, and a passphrase in a file
// next to the key would protect nothing.

import { StringDecoder } from "node:string_decoder";

export interface PassphraseIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/** At least this many characters: the passphrase is all that stands between a copied key file and the key. */
const MIN_LENGTH = 12;
const TRIES = 3;

function defaultIo(): PassphraseIo {
  return { input: process.stdin, output: process.stderr };
}

/** True when a passphrase can be asked: stdin and stderr are terminals. */
export function canAsk(io: PassphraseIo = defaultIo()): boolean {
  return io.input.isTTY === true && io.output.isTTY === true;
}

/**
 * What arrived after the end of a line, kept for the next question. A terminal sends a keystroke at a time, but a paste
 * can hold two lines, and the second is the answer to the next prompt.
 */
const pending = new WeakMap<object, { decoder: StringDecoder; text: string }>();

/** Reads one line without echo (raw mode); Ctrl-C rejects with "cancelled"; backspace edits; returns the NFC-normalised text. */
export function askHidden(prompt: string, io: PassphraseIo = defaultIo()): Promise<string> {
  const { input, output } = io;
  let state = pending.get(input);
  if (!state) {
    state = { decoder: new StringDecoder("utf8"), text: "" };
    pending.set(input, state);
  }
  const buffered = state;
  return new Promise<string>((resolve, reject) => {
    let typed = "";
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      input.off("data", onData);
      input.off("end", onEnd);
      try {
        input.setRawMode?.(false);
      } finally {
        input.pause();
        // a paused stdin still holds the process open; the wallet must stop on Ctrl-C once it has its passphrase
        input.unref?.();
        output.write("\n");
        if (error) reject(error);
        else resolve(typed.normalize("NFC"));
      }
    };
    const take = (text: string) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (c === "\r" || c === "\n") {
          // a "\r\n" pair is one line end
          const rest = chars.slice(chars[i + 1] === "\n" && c === "\r" ? i + 2 : i + 1).join("");
          buffered.text = rest;
          finish();
          return;
        }
        if (c === "\x03" || c === "\x04") {
          buffered.text = "";
          finish(new Error("cancelled"));
          return;
        }
        if (c === "\x7f" || c === "\b") {
          typed = [...typed].slice(0, -1).join("");
          continue;
        }
        if (c === "\x1b") {
          // an arrow or function key: ESC [ or ESC O, parameters, then one final letter; none of it is text
          i++;
          while (i < chars.length && /[[O0-9;]/.test(chars[i]!)) i++;
          continue;
        }
        if (c < " ") continue; // other control characters are not text
        typed += c;
      }
      buffered.text = "";
    };
    const onData = (chunk: Buffer | string) => take(typeof chunk === "string" ? chunk : buffered.decoder.write(chunk));
    const onEnd = () => finish(new Error("cancelled"));

    input.setRawMode?.(true); // before the prompt, so what is typed ahead of it is not echoed
    output.write(prompt);
    input.on("data", onData);
    input.on("end", onEnd);
    input.ref?.();
    input.resume();
    if (buffered.text) take(buffered.text);
  });
}

/** Asks twice for a new passphrase; at least 12 characters; the two must match (3 tries). */
export async function askNewPassphrase(io: PassphraseIo = defaultIo()): Promise<string> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const first = await askHidden("New passphrase for the wallet key: ", io);
    if ([...first].length < MIN_LENGTH) {
      io.output.write(`The passphrase needs at least ${MIN_LENGTH} characters.\n`);
      continue;
    }
    const second = await askHidden("Type it again: ", io);
    if (first !== second) {
      io.output.write("The two passphrases do not match.\n");
      continue;
    }
    return first;
  }
  throw new Error("too many tries: no passphrase was set");
}
