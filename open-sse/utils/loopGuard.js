// Loop guard: stateless detection of repeating tool call patterns in conversation history.
// Analyzes messages array in the current request body - no cross-request state needed.
// Returns { detected: bool, hint: string|null }

const SINGLE_REPEAT_THRESHOLD = 3; // same tool+args appearing >= this many times
const SEQUENCE_REPEAT_THRESHOLD = 2; // same sequence of N tool calls appearing >= this many times
const MIN_SEQUENCE_LENGTH = 2; // minimum sequence length to detect

/**
 * Normalize tool call arguments for stable hashing:
 * Sort object keys so {b:1,a:2} and {a:2,b:1} produce the same hash.
 */
function normalizeArgs(argsStr) {
  try {
    const obj = JSON.parse(argsStr);
    return JSON.stringify(obj, Object.keys(obj).sort());
  } catch {
    return argsStr || "";
  }
}

function toolCallHash(tc) {
  const name = tc?.function?.name || tc?.name || "";
  const args = normalizeArgs(tc?.function?.arguments || tc?.arguments || "");
  return `${name}::${args}`;
}

/**
 * Extract all tool_call hashes from conversation history in order.
 * Each assistant message with tool_calls contributes its calls in order.
 */
function extractToolCallSequence(messages) {
  const seq = [];
  for (const msg of messages) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        seq.push(toolCallHash(tc));
      }
    }
  }
  return seq;
}

/**
 * Detect single tool call repeated >= SINGLE_REPEAT_THRESHOLD times.
 */
function detectSingleRepeat(seq) {
  const counts = new Map();
  for (const h of seq) {
    counts.set(h, (counts.get(h) || 0) + 1);
    if (counts.get(h) >= SINGLE_REPEAT_THRESHOLD) return h;
  }
  return null;
}

/**
 * Detect a sequence of N tool calls that repeats >= SEQUENCE_REPEAT_THRESHOLD times.
 * Uses sliding window to find N-gram repeats.
 */
function detectSequenceRepeat(seq) {
  const n = seq.length;
  // Try sequence lengths from largest to smallest (greedy)
  for (let len = Math.floor(n / 2); len >= MIN_SEQUENCE_LENGTH; len--) {
    for (let start = 0; start <= n - len * 2; start++) {
      const pattern = seq.slice(start, start + len).join("|");
      let count = 0;
      let pos = 0;
      while (pos <= n - len) {
        const window = seq.slice(pos, pos + len).join("|");
        if (window === pattern) {
          count++;
          pos += len;
        } else {
          pos++;
        }
      }
      if (count >= SEQUENCE_REPEAT_THRESHOLD) return pattern;
    }
  }
  return null;
}

/**
 * Main loop detection function.
 * @param {object} body - the translated request body (must have messages array)
 * @returns {{ detected: boolean, hint: string|null }}
 */
export function detectLoop(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { detected: false, hint: null };

  const seq = extractToolCallSequence(messages);
  if (seq.length < SINGLE_REPEAT_THRESHOLD) return { detected: false, hint: null };

  const singleRepeat = detectSingleRepeat(seq);
  if (singleRepeat) {
    return {
      detected: true,
      hint: "You have called the same tool with identical arguments multiple times with no new progress. STOP repeating. Summarize findings from existing results or change your strategy."
    };
  }

  const seqRepeat = detectSequenceRepeat(seq);
  if (seqRepeat) {
    return {
      detected: true,
      hint: "You have repeated the same sequence of tool calls multiple times. This is a loop. STOP this pattern immediately. Summarize what you have already found or take a completely different approach."
    };
  }

  return { detected: false, hint: null };
}
