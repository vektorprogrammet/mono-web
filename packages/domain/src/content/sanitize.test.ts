import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sanitizeArticleBodyHtml } from "./sanitize.js";

describe("content article HTML sanitizer", () => {
  it.effect("rejects entity, control, and whitespace-obfuscated executable URL schemes", () =>
    Effect.gen(function* () {
      const payloads = [
        '<a href="java&#x73;cript:alert(1)">entity letter</a>',
        '<a href="javascript&#58;alert(1)">entity colon</a>',
        '<a href="jav&#x09;ascript:alert(1)">entity tab</a>',
        '<a href="java\nscript:alert(1)">literal newline</a>',
        '<a href="j a v a s c r i p t:alert(1)">literal spaces</a>',
        '<form action="vb&#x73;cript:alert(1)">form</form>',
        '<img src="d&#97;ta:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">',
        '<a href="blob:https://example.invalid/id">blob</a>',
        '<a href="livescript:alert(1)">obsolete executable scheme</a>',
      ];

      for (const payload of payloads) {
        const failure = yield* Effect.flip(sanitizeArticleBodyHtml("test sanitize", payload));
        expect(failure._tag).toBe("ContentDecodeError");
        expect(failure.message).toContain("URL scheme");
      }
    }),
  );

  it.effect("removes closed executable contexts and refuses unclosed documents", () =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeArticleBodyHtml(
        "test sanitize",
        '<p>before</p><script>alert(1)</script><iframe src="https://example.invalid"></iframe><p>after</p>',
      );
      expect(sanitized).toBe("<p>before</p><p>after</p>");

      for (const payload of [
        "<p>before</p><script>alert(1)",
        '<p>before</p><iframe src="https://example.invalid">after',
      ]) {
        const failure = yield* Effect.flip(sanitizeArticleBodyHtml("test sanitize", payload));
        expect(failure._tag).toBe("ContentDecodeError");
        expect(failure.message).toContain("unclosed");
      }
    }),
  );

  it.effect("serializes one canonical attribute representation after entity decoding", () =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeArticleBodyHtml(
        "test sanitize",
        '<p><a href="https&#58;//example.invalid/?a=1&amp;b=2">safe</a></p>',
      );
      expect(sanitized).toBe('<p><a href="https://example.invalid/?a=1&amp;b=2">safe</a></p>');
    }),
  );
  it.effect("strips active and multi-URL attributes while preserving safe links", () =>
    Effect.gen(function* () {
      const sanitized = yield* sanitizeArticleBodyHtml(
        "test sanitize",
        '<p onclick="alert(1)" style="background:url(javascript:alert(1))"><a href="/nyheter" ping="https://tracker.invalid">safe</a><img src="/image.png" srcset="data:image/svg+xml,unsafe 2x"></p>',
      );
      expect(sanitized).toBe('<p><a href="/nyheter">safe</a><img src="/image.png"></p>');
    }),
  );
});
