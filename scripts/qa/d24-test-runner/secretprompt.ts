// Hidden-input prompt shared by the provisioning CLI and the owner CLI. Reads from a TTY without echo; otherwise from all of stdin. Never prints the value.

/** Hidden prompt on a TTY (no echo); otherwise all of stdin. The value is returned to the caller and never printed. */
export async function readSecret(stdin: NodeJS.ReadStream, prompt: (s: string) => void, label = "Paste the restricted TEST key (input hidden), then press Enter: "): Promise<string> {
  if (stdin.isTTY) {
    prompt(label);
    return new Promise((resolveP) => {
      let buf = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c === "\r" || c === "\n") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            prompt("\n");
            return resolveP(buf);
          }
          if (c === "\u0003") process.exit(130);
          if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
          else buf += c;
        }
      };
      stdin.on("data", onData);
    });
  }
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) data += chunk;
  return data.replace(/[\r\n]+$/, "");
}

