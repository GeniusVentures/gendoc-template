import { strict as assert } from 'node:assert';
import { needsFinalAnswerRepair } from '../answer-quality.js';

const reasoning = `
The primary document identifies these features:

1. **Persistent structured memory** - Preserves reusable state across GNUS nodes.
2. **Multi-hop reasoning** - Reasons across historical facts and relationships.
3. **Temporal coherence** - Resolves information according to temporal validity.
4. **Swarm consensus** - Resolves conflicts using reputation and evidence.
`;

const outlineOnly = `
Based on the GAML documentation, these are the key features:

## Core Purpose

## Key Features

1. Structured Memory Object Model
2. Cognitive Asset Model
3. Agentic Retrieval Mechanism
4. Ingestion Pipeline

## Strategic Impact
`;

const complete = `
GAML provides structured long-term memory for GNUS nodes.

- **Persistent structured memory:** Preserves reusable state across GNUS nodes.
- **Multi-hop reasoning:** Reasons across historical facts and relationships.
- **Temporal coherence:** Resolves information according to temporal validity.
- **Swarm consensus:** Resolves conflicts using reputation and evidence.
`;

assert.equal(needsFinalAnswerRepair('What are the GAML features?', outlineOnly, reasoning), true);
assert.equal(needsFinalAnswerRepair('What are the GAML features?', complete, reasoning), false);
assert.equal(needsFinalAnswerRepair('What is GAML?', 'GAML is a memory layer.', reasoning), false);

console.log('answer-quality tests passed');
