import { Optimizer } from 'llm-context-optimizer';
import { GoogleAdapter } from 'llm-context-optimizer/providers/google';

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;
if (!apiKey || !model)
  throw new Error('Set GEMINI_API_KEY and GEMINI_MODEL before running this example.');

const result = await new Optimizer().chat(
  new GoogleAdapter({ apiKey }),
  {
    model,
    contents: [{ role: 'user', parts: [{ text: 'When does the library open on Saturdays?' }] }],
    config: {
      systemInstruction:
        'Answer from the supplied evidence. Say when the evidence is insufficient.',
      maxOutputTokens: 128,
    },
  },
  {
    task: 'Find the library opening time on Saturdays.',
    context: [
      {
        id: 'schedule',
        text: 'The town library opens at 9 AM on Saturdays.',
        source: 'library-schedule',
        protected: true,
      },
      {
        id: 'services',
        text: 'The library has a photocopier and a quiet reading room.',
        source: 'library-services',
      },
    ],
    policy: { timeoutMs: 60_000 },
  },
);

console.log(result.response.text);
console.log(result.optimization);
console.log(result.usage);
