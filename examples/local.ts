import { Optimizer, renderContext } from 'llm-context-optimizer';
import type { ContextDocument, ContextOptimizerBackend } from 'llm-context-optimizer';

const context: ContextDocument[] = [
  {
    id: 'support-policy',
    source: 'policy/support',
    text: 'Escalate unresolved support cases within four hours.',
    protected: true,
    atomic: true,
  },
  {
    id: 'office-menu',
    source: 'office/cafeteria',
    text: 'The cafeteria serves lunch from noon to 14:00. Menus rotate weekly.',
  },
  {
    id: 'gardening',
    source: 'office/garden',
    text: 'Water the planters on Monday and Thursday. Store tools in the shed.',
  },
];

const task = 'What is the support escalation deadline?';
const optimizer = new Optimizer();
const result = await optimizer.optimize({
  task,
  context,
  policy: { mode: 'balanced', maxReduction: 0.5 },
});
console.log(renderContext(result.chunks));
console.log(JSON.stringify(result.metrics, null, 2));

const bypass = await optimizer.optimize({ task, context, policy: { mode: 'off' } });
console.log('Bypass retained chunks:', bypass.chunks.length);

// Custom backends must return exactly one finite [0, 1] score per input chunk.
// This intentionally failing local backend demonstrates default pass-through.
const unavailable: ContextOptimizerBackend = {
  name: 'example-unavailable',
  external: false,
  async optimize() {
    throw new Error('Simulated local backend failure');
  },
};
const fallback = await new Optimizer({ backend: unavailable }).optimize({ task, context });
console.log('Fallback reason:', fallback.metrics.reason);
console.log('Fallback retained chunks:', fallback.chunks.length);
