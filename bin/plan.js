#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { planPurge } from '../src/index.js';

const usage = 'usage: node bin/plan.js <input.json>';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const plan = planPurge(input);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    console.error(`failed to plan purge: ${error.message}`);
    process.exitCode = 1;
  }
}
