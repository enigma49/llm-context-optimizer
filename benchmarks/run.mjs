import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { Optimizer, OptimizerError, chunkDocuments } from '../dist/index.js';

const datasetDirectory = fileURLToPath(new URL('./datasets/', import.meta.url));
const defaultOutput = fileURLToPath(new URL('./reports/latest.json', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run benchmark -- [--output path/to/report.json]');
  process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
  throw new Error('Use --output <path>, or no arguments.');
}
const outputPath = args.length ? resolve(args[1]) : defaultOutput;

// Original fixtures are complete atomic documents. Keeping a document ID is
// meaningful only when its complete text survives, so verify that below.
function validateFixture(fixture, filename) {
  if (
    !fixture ||
    typeof fixture.id !== 'string' ||
    !fixture.id ||
    typeof fixture.task !== 'string' ||
    !fixture.task.trim() ||
    typeof fixture.annotation !== 'string' ||
    !fixture.annotation.trim() ||
    !Array.isArray(fixture.tags) ||
    !fixture.tags.every((tag) => typeof tag === 'string') ||
    !Number.isFinite(fixture.budgetFraction) ||
    fixture.budgetFraction <= 0.2 ||
    fixture.budgetFraction >= 1 ||
    !Array.isArray(fixture.documents) ||
    !fixture.documents.length ||
    !fixture.documents.every((document) => document.atomic === true) ||
    !Array.isArray(fixture.necessaryDocumentIds) ||
    !fixture.necessaryDocumentIds.length
  ) {
    throw new Error(`Invalid benchmark fixture: ${filename}`);
  }
  // Core validation checks document IDs, text, and metadata.
  chunkDocuments(fixture.documents);
  const documentIds = new Set(fixture.documents.map((document) => document.id));
  const required = new Set(fixture.necessaryDocumentIds);
  if (
    required.size !== fixture.necessaryDocumentIds.length ||
    !fixture.necessaryDocumentIds.every((id) => typeof id === 'string' && documentIds.has(id))
  ) {
    throw new Error(`Invalid necessary-document annotation: ${filename}`);
  }
}

const fixtures = [];
const datasetHash = createHash('sha256');
for (const filename of (await readdir(datasetDirectory))
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const source = await readFile(resolve(datasetDirectory, filename), 'utf8');
  const fixture = JSON.parse(source);
  validateFixture(fixture, filename);
  datasetHash.update(filename).update('\0').update(source).update('\0');
  fixtures.push(fixture);
}
if (!fixtures.length || new Set(fixtures.map((fixture) => fixture.id)).size !== fixtures.length) {
  throw new Error('Benchmark requires at least one fixture and unique case IDs.');
}

const outage = {
  name: 'simulated-outage',
  external: false,
  async optimize() {
    throw new Error('Synthetic backend unavailable');
  },
};
const rows = [];
for (const fixture of fixtures) {
  const baseline = await new Optimizer().optimize({
    task: fixture.task,
    context: fixture.documents,
    policy: { mode: 'off' },
  });
  const originalTokens = baseline.metrics.originalContextTokens;
  const targetTokens = Math.floor(originalTokens * fixture.budgetFraction);
  const pinned = fixture.documents.map((document) => ({
    ...document,
    protected: fixture.necessaryDocumentIds.includes(document.id),
  }));
  const pinnedTokens = chunkDocuments(pinned)
    .filter((chunk) => chunk.protected)
    .reduce((sum, chunk) => sum + chunk.tokens, 0);
  const scenarios = [
    { id: 'off', context: fixture.documents, policy: { mode: 'off' } },
    {
      id: 'heuristic-balanced',
      context: fixture.documents,
      policy: { mode: 'balanced', maxReduction: 0.8, targetTokens },
    },
    {
      id: 'pinned-necessary-evidence',
      context: pinned,
      // An annotation oracle pins evidence and raises the budget if necessary.
      // This is a preservation control, not an automatic retrieval result.
      policy: {
        mode: 'balanced',
        maxReduction: 0.8,
        targetTokens: Math.max(targetTokens, pinnedTokens),
      },
    },
    {
      id: 'backend-outage-passthrough',
      backend: outage,
      context: fixture.documents,
      policy: { mode: 'balanced' },
    },
    {
      id: 'backend-outage-budget-conflict',
      backend: outage,
      context: fixture.documents,
      policy: { mode: 'balanced', maxReduction: 0.8, targetTokens },
      expectedError: 'BUDGET_CONFLICT',
    },
  ];
  for (const scenario of scenarios) {
    const common = {
      caseId: fixture.id,
      scenario: scenario.id,
      tags: fixture.tags,
      annotation: fixture.annotation,
      policy: scenario.policy,
      necessaryDocumentIds: fixture.necessaryDocumentIds,
      originalContextTokens: originalTokens,
    };
    let result;
    try {
      result = await new Optimizer({ backend: scenario.backend }).optimize({
        task: fixture.task,
        context: scenario.context,
        policy: scenario.policy,
      });
    } catch (error) {
      if (!(error instanceof OptimizerError) || error.code !== scenario.expectedError) throw error;
      rows.push({ ...common, status: 'expected-error', errorCode: error.code });
      continue;
    }
    if (scenario.expectedError) {
      throw new Error(`Expected ${scenario.expectedError}: ${fixture.id}/${scenario.id}`);
    }
    const kept = new Set();
    for (const chunk of result.chunks) {
      const original = fixture.documents.find((document) => document.id === chunk.documentId);
      if (!original || chunk.text !== original.text) {
        throw new Error(`Atomic document text changed: ${fixture.id}/${scenario.id}`);
      }
      kept.add(chunk.documentId);
    }
    const retainedNecessaryDocumentIds = fixture.necessaryDocumentIds.filter((id) => kept.has(id));
    const missingNecessaryDocumentIds = fixture.necessaryDocumentIds.filter((id) => !kept.has(id));
    const recall = retainedNecessaryDocumentIds.length / fixture.necessaryDocumentIds.length;
    rows.push({
      ...common,
      status: 'success',
      backend: result.metrics.backend,
      reason: result.metrics.reason,
      retainedDocumentIds: fixture.documents
        .filter((document) => kept.has(document.id))
        .map((document) => document.id),
      retainedNecessaryDocumentIds,
      missingNecessaryDocumentIds,
      evidenceDocumentRecall: recall,
      completeEvidenceRetention: missingNecessaryDocumentIds.length === 0,
      optimizedContextTokens: result.metrics.optimizedContextTokens,
      localContextReduction: 1 - result.metrics.optimizedContextTokens / originalTokens,
    });
  }
}

const summaries = [...new Set(rows.map((row) => row.scenario))].map((scenario) => {
  const group = rows.filter((row) => row.scenario === scenario);
  const successful = group.filter((row) => row.status === 'success');
  const totalNecessary = successful.reduce((sum, row) => sum + row.necessaryDocumentIds.length, 0);
  const totalRetainedNecessary = successful.reduce(
    (sum, row) => sum + row.retainedNecessaryDocumentIds.length,
    0,
  );
  const originalTokens = successful.reduce((sum, row) => sum + row.originalContextTokens, 0);
  const optimizedTokens = successful.reduce((sum, row) => sum + row.optimizedContextTokens, 0);
  return {
    scenario,
    cases: group.length,
    successfulCases: successful.length,
    expectedErrors: group.length - successful.length,
    evidenceDocumentRecall: totalNecessary ? totalRetainedNecessary / totalNecessary : null,
    completeEvidenceRetentionRate: successful.length
      ? successful.filter((row) => row.completeEvidenceRetention).length / successful.length
      : null,
    localContextReduction: originalTokens ? 1 - optimizedTokens / originalTokens : null,
  };
});

const report = {
  schemaVersion: 1,
  datasetSha256: datasetHash.digest('hex'),
  runtime: { node: process.version },
  method: {
    network: false,
    tokenizer:
      'ceil(UTF-8 bytes / 3), including per-chunk rendered JSON wrappers and separator overhead',
    evidenceMetric: 'Annotated necessary-document recall; complete atomic text must survive',
    qualityEvaluation: 'No answers generated; no semantic quality or quality-parity evaluation',
    economicEvaluation: 'No provider costs or net dollar savings measured',
    pinnedControl: 'Uses annotation oracle and raises target budget to fit necessary documents',
    timing: 'Excluded so repeated runs on the same runtime and files produce identical reports',
  },
  summaries,
  rows,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.table(
  rows.map((row) => ({
    case: row.caseId,
    scenario: row.scenario,
    recall: row.status === 'success' ? row.evidenceDocumentRecall.toFixed(3) : 'n/a',
    reduction:
      row.status === 'success' ? `${(row.localContextReduction * 100).toFixed(1)}%` : 'n/a',
    outcome: row.status === 'success' ? row.reason : row.errorCode,
  })),
);
console.table(summaries);
console.log(`Report: ${outputPath}`);
