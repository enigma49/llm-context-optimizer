import { Optimizer } from 'llm-context-optimizer';
import { OpenAIAdapter } from 'llm-context-optimizer/providers/openai';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
if (!apiKey || !model)
  throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL before running this example.');

const result = await new Optimizer().chat(
  new OpenAIAdapter({ apiKey }),
  {
    model,
    instructions: 'Answer from the supplied evidence. Say when the evidence is insufficient.',
    input: [{ role: 'user', content: 'When does the library open on Saturdays?' }],
    max_output_tokens: 128,
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

console.log(result.response.output_text);
console.log(result.optimization);
console.log(result.usage);
