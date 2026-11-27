import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where OpenBot writes `url` and `token` while at least one agent has Local scripts on. */
export function automationDir(): string {
  const override = process.env.OPENBOT_AUTOMATION_DIR;
  if (override) return override;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "OpenBot", "automation");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "OpenBot", "automation");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "OpenBot", "automation");
}

export interface Target {
  url: string;
  token: string;
}

/** An OpenBot answer that is not 2xx, or OpenBot that cannot be reached. */
export class OpenBotError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when OpenBot was not reached. */
    readonly status: number,
    /** The parsed JSON body of the error answer, when there was one. */
    readonly body: unknown = null,
    /** True when a new url/token may fix it (OpenBot restarted). */
    readonly stale = false,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reads the url and token files each time they are needed, so a restart of OpenBot
 * (new port, new token) is picked up without restarting this MCP server.
 */
export class OpenBotConnection {
  private target: Target | null = null;

  async read(): Promise<Target> {
    const dir = automationDir();
    try {
      const [url, token] = await Promise.all([
        readFile(join(dir, "url"), "utf8"),
        readFile(join(dir, "token"), "utf8"),
      ]);
      return { url: url.trim().replace(/\/+$/u, ""), token: token.trim() };
    } catch {
      throw new OpenBotError(
        `OpenBot is not running, or no agent has Local scripts on (no url/token files in ${dir}). ` +
          "Open the agent in OpenBot → Settings → Permissions → turn on Local scripts.",
        0,
      );
    }
  }

  private async current(): Promise<Target> {
    this.target ??= await this.read();
    return this.target;
  }

  /** One request. On 401 or a refused connection it re-reads the files once and retries. */
  async request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const target = await this.current();
    try {
      return await this.once<T>(target, method, path, body);
    } catch (error) {
      if (!(error instanceof OpenBotError) || !error.stale) throw error;
      const fresh = await this.read().catch(() => null);
      if (!fresh || (fresh.url === target.url && fresh.token === target.token)) throw error;
      this.target = fresh;
      return this.once<T>(fresh, method, path, body);
    }
  }

  private async once<T>(target: Target, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    // Routes that read a body need Content-Type: application/json (415 otherwise).
    // context/clear takes no body, so it is sent with neither.
    const hasBody = body !== undefined;
    try {
      response = await fetch(target.url + path, {
        method,
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OpenBotError(`OpenBot does not answer at ${target.url}.`, 0, null, true);
    }
    const text = await response.text();
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = text || null;
    }
    if (response.ok) return value as T;
    const reason =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : typeof value === "string" && value
          ? value
          : `HTTP ${response.status}`;
    throw new OpenBotError(explain(response.status, reason), response.status, value, response.status === 401);
  }
}

/** Adds a hint for the documented statuses so the model knows what to do next. */
function explain(status: number, reason: string): string {
  const hints: Record<number, string> = {
    400: "the request body was rejected",
    401: "the token is wrong; OpenBot may have restarted",
    403: "refused: the agent does not allow Local scripts, or only the owner/admin can do this in OpenBot",
    404: "the agent, routine, delivery or request does not exist",
    409: "the agent cannot do this now (busy, queued work, expired request, or invalid model/effort) — read the reason",
    413: "too large: body over 32 KiB or payload over 4,000 characters",
    415: "Content-Type must be application/json",
    429: "the agent hit its hourly limit of messages/routine runs from local scripts",
  };
  const hint = hints[status];
  return hint ? `OpenBot ${status} (${hint}): ${reason}` : `OpenBot ${status}: ${reason}`;
}
