import { Optimizer } from 'llm-context-optimizer';
import { AnthropicAdapter } from 'llm-context-optimizer/providers/anthropic';

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL;
if (!apiKey || !model)
  throw new Error('Set ANTHROPIC_API_KEY and ANTHROPIC_MODEL before running this example.');

const result = await new Optimizer().chat(
  new AnthropicAdapter({ apiKey }),
  {
    model,
    system: 'Answer from the supplied evidence. Say when the evidence is insufficient.',
    messages: [{ role: 'user', content: 'When does the library open on Saturdays?' }],
    max_tokens: 128,
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

for (const block of result.response.content) {
  if (block.type === 'text') console.log(block.text);
}
console.log(result.optimization);
console.log(result.usage);
