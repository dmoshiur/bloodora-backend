#!/usr/bin/env npx tsx
/**
 * AI output sanitization — unit tests.
 *
 * The contract suite cannot cover this: it needs a live model, and the whole
 * point of the fix is what happens when a REASONING model (qwen3, gpt-oss,
 * kimi-k2-thinking…) leaks its chain of thought into `message.content`. These
 * tests drive the sanitizer directly, including the streaming filter with a
 * reasoning tag split across two chunks.
 *
 * Usage: npm run test:ai
 */
import { sanitizeAnswer, extractAnswer, createStreamSanitizer } from "../src/services/aiSanitize.js";

let pass = 0;
const failures: string[] = [];
const step = (name: string, ok: boolean, extra = "") => {
  if (ok) pass += 1;
  else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// ---------------- complete answers ----------------

{
  const out = sanitizeAnswer("<think>The user asks about Anti-D. Check the dosage.</think>\nAnti-D is given within 72 hours.");
  step("a paired <think> block is removed", out.text === "Anti-D is given within 72 hours.", JSON.stringify(out.text));
  step("removed reasoning is counted", out.hadReasoning === true && out.removedChars > 30, JSON.stringify({ n: out.removedChars, had: out.hadReasoning }));
}

{
  const out = sanitizeAnswer("<think>first</think>Answer one.<thinking>second</thinking>Answer two.");
  step("several reasoning blocks are all removed", out.text === "Answer one.Answer two.", JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("Here is the answer.<think>truncated mid-thought because max_tokens");
  step("an UNTERMINATED reasoning block drops everything after it", out.text === "Here is the answer.", JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("Answer</think> with a stray closing tag.");
  step("a stray closing tag is removed", out.text === "Answer with a stray closing tag.", JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("<THINK>Shouting tags</THINK>Real answer.");
  step("tag matching is case-insensitive", out.text === "Real answer.", JSON.stringify(out.text));
}

{
  for (const tag of ["reasoning", "reasoning_content", "chain-of-thought", "cot", "analysis", "internal"]) {
    const out = sanitizeAnswer(`<${tag}>private</${tag}>Visible.`);
    step(`the <${tag}> wrapper is treated as reasoning`, out.text === "Visible.", JSON.stringify(out.text));
  }
}

{
  const text = "BloodOra supports bKash, Nagad and cash on delivery.\n\n- Kalai: ৳10\n- Free above ৳1000";
  const out = sanitizeAnswer(text);
  step("an answer with no reasoning is returned untouched", out.text === text && out.hadReasoning === false, JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("Use ```json\n{\"a\":1}\n``` to parse it, and remember 1 < 2 while a<b>c is html-ish.");
  step("code fences and lone angle brackets survive", out.text.includes("```json") && out.text.includes("1 < 2") && out.text.includes("a<b>c"), JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("<think>a</think>");
  step("an answer that was ONLY reasoning becomes empty", out.text === "" && out.hadReasoning === true, JSON.stringify(out.text));
}

{
  const out = sanitizeAnswer("   \n  Padded answer  \n ");
  step("surrounding whitespace is trimmed", out.text === "Padded answer", JSON.stringify(out.text));
}

step("null and undefined are handled", sanitizeAnswer(null).text === "" && sanitizeAnswer(undefined).text === "");

// ---------------- provider response shapes ----------------

step("extractAnswer reads message.content", extractAnswer({ message: { content: "Hello" } }) === "Hello");
step(
  "extractAnswer joins array content parts",
  extractAnswer({ message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }, { type: "image_url" }] } }) === "AB",
);
step("extractAnswer ignores non-text parts", extractAnswer({ message: { content: [{ type: "tool_call", id: "x" }] } }) === "");
step(
  "a provider reasoning FIELD is never read (that is how it leaks)",
  extractAnswer({ message: { reasoning: "secret chain of thought", reasoning_content: "more secrets" } }) === "",
);
step(
  "reasoning is dropped even when content is present",
  extractAnswer({ message: { content: "Answer", reasoning: "secret" } }) === "Answer",
);
step("a malformed choice yields an empty string", extractAnswer(undefined) === "" && extractAnswer({}) === "" && extractAnswer({ message: null }) === "");

// ---------------- streaming ----------------

{
  const s = createStreamSanitizer();
  const out = s.push("<think>hidden</think>") + s.push("Visible answer.") + s.end();
  step("a streamed reasoning block is filtered", out === "Visible answer.", JSON.stringify(out));
}

{
  const s = createStreamSanitizer();
  // The tag is split across two SSE frames — the case a per-chunk regex misses.
  const out = s.push("Answer. <th") + s.push("ink>secret reasoning</th") + s.push("ink> Done.");
  const tail = s.end();
  step("a reasoning tag split across chunks is still caught", (out + tail) === "Answer.  Done.", JSON.stringify(out + tail));
}

{
  const s = createStreamSanitizer();
  const out = s.push("Partial <thi");
  step("a fragment that could become a tag is withheld, not emitted", out === "Partial ", JSON.stringify(out));
  const rest = s.push("nk>reasoning that never ends");
  step("the withheld fragment is dropped once it proves to be reasoning", rest === "", JSON.stringify(rest));
  step("end() inside reasoning emits nothing", s.end() === "");
}

{
  const s = createStreamSanitizer();
  let out = "";
  for (const ch of "Plain streamed answer with no tags at all.".split("")) out += s.push(ch);
  out += s.end();
  step("a clean stream passes through character by character", out === "Plain streamed answer with no tags at all.", JSON.stringify(out));
}

{
  const s = createStreamSanitizer();
  const out = s.push("Before <think>mid</think> after <reasoning>more</reasoning> end") + s.end();
  step("multiple streamed reasoning blocks are removed", out === "Before  after  end", JSON.stringify(out));
}

{
  const s = createStreamSanitizer();
  const out = s.push("Keep < a and <b> tags that are not reasoning") + s.end();
  step("ordinary angle brackets stream through", out === "Keep < a and <b> tags that are not reasoning", JSON.stringify(out));
}

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exitCode = failures.length === 0 ? 0 : 1;
