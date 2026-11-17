import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "../src/index.ts";

type Step = number | Error | { status: number; headers: Record<string, string> };

/** A fetch that answers with each scripted status (or throws each scripted error) in turn. */
function scripted(...steps: Step[]) {
  const times: number[] = [];
  const fetchImpl = (async () => {
    times.push(Date.now());
    const step = steps.shift();
    if (step === undefined) throw new Error("no more scripted replies");
    if (step instanceof Error) throw step;
    return typeof step === "number" ? new Response(`status ${step}`, { status: step }) : new Response("", step);
  }) as typeof fetch;
  return { fetch: fetchImpl, times };
}
const call = (s: ReturnType<typeof scripted>, options: Partial<Parameters<typeof fetchWithRetry>[3]> = {}) =>
  fetchWithRetry(s.fetch, "https://x.test", {}, { retries: 2, baseDelayMs: 1, ...options });

describe("fetchWithRetry", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("retries a %i and returns the eventual success", async (status) => {
    const s = scripted(status, 200);
    expect((await call(s)).status).toBe(200);
    expect(s.times).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422])("returns a %i at once: repeating it would not help", async (status) => {
    const s = scripted(status, 200);
    expect((await call(s)).status).toBe(status);
    expect(s.times).toHaveLength(1);
  });

  it("returns the last response when every attempt fails, so the caller can read why", async () => {
    const s = scripted(503, 503, 502);
    const response = await call(s);
    expect([response.status, await response.text()]).toEqual([502, "status 502"]);
    expect(s.times).toHaveLength(3);
  });

  it("retries network errors and throws the last one if none succeeds", async () => {
    expect((await call(scripted(new TypeError("ECONNRESET"), 200))).status).toBe(200);
    const s = scripted(new TypeError("first"), new TypeError("second"), new TypeError("last"));
    await expect(call(s)).rejects.toThrow("last");
    expect(s.times).toHaveLength(3);
  });

  it("`retries: 0` makes exactly one attempt", async () => {
    const s = scripted(503, 200);
    expect((await call(s, { retries: 0 })).status).toBe(503);
    expect(s.times).toHaveLength(1);
  });

  it("waits longer each time, within the limit", async () => {
    const s = scripted(503, 503, 503, 200);
    await call(s, { retries: 3, baseDelayMs: 20, maxDelayMs: 45 });
    const gaps = s.times.slice(1).map((t, i) => t - s.times[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(9); // 20ms with up to half taken off by jitter
    expect(gaps[1]).toBeGreaterThanOrEqual(19); // 40ms, likewise
    expect(gaps[2]).toBeLessThan(80); // 80ms capped to 45
  });

  it("waits as long as Retry-After asks, in seconds or as a date, but never past the limit", async () => {
    const immediate = scripted({ status: 429, headers: { "retry-after": "0" } }, 200);
    const started = Date.now();
    await call(immediate, { baseDelayMs: 300 });
    expect(Date.now() - started).toBeLessThan(150); // the server's 0 seconds wins over our 300ms backoff

    const capped = scripted({ status: 429, headers: { "retry-after": "120" } }, 200);
    await call(capped, { maxDelayMs: 20 });
    expect(capped.times[1]! - capped.times[0]!).toBeLessThan(200);

    const dated = scripted({ status: 503, headers: { "retry-after": new Date(Date.now() + 60_000).toUTCString() } }, 200);
    await call(dated, { maxDelayMs: 20 });
    expect(dated.times).toHaveLength(2);
    const nonsense = scripted({ status: 503, headers: { "retry-after": "soon" } }, 200);
    expect((await call(nonsense)).status).toBe(200); // unreadable header: fall back to backoff
  });

  it("stops at once when the caller aborts, during a wait or a request", async () => {
    const waiting = new AbortController();
    const s = scripted(503, 200);
    const pending = call(s, { baseDelayMs: 5_000, signal: waiting.signal });
    setTimeout(() => waiting.abort(new Error("cancelled")), 10);
    await expect(pending).rejects.toThrow("cancelled");
    expect(s.times).toHaveLength(1);

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const aborted = scripted(abort, 200);
    await expect(call(aborted)).rejects.toThrow("aborted");
    expect(aborted.times).toHaveLength(1); // an abort is not a network error to retry

    const already = new AbortController();
    already.abort(new Error("too late"));
    await expect(call(scripted(503, 200), { signal: already.signal })).rejects.toThrow("too late");
  });
});
