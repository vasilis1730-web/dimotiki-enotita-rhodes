#!/usr/bin/env node
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/citizen-bridge/index.ts'), 'utf8');

const htmlTitles = html.match(/const ISSUE_TITLES = (\{[\s\S]*?\n\});/);
const edgeTitles = edge.match(/const CITIZEN_TITLES:Record<string,ReadonlySet<string>>=(\{[\s\S]*?\n\});/);
const edgeMunicipalities = edge.match(/const CITIZEN_MUNICIPALITIES=new Set\((\[[\s\S]*?\])\);/);
const unitSelect = html.match(/<select id="i_unit">([\s\S]*?)<\/select>/);

if (!htmlTitles || !edgeTitles || !edgeMunicipalities || !unitSelect) {
  throw new Error('Could not extract citizen classification definitions.');
}

const context = {};
vm.runInNewContext(
  `globalThis.htmlTitles=${htmlTitles[1]};globalThis.edgeTitles=${edgeTitles[1]};globalThis.edgeMunicipalities=${edgeMunicipalities[1]};`,
  context,
  { timeout: 1000 },
);

const htmlCategories = Object.keys(context.htmlTitles);
const edgeCategories = Object.keys(context.edgeTitles);
if (JSON.stringify(htmlCategories) !== JSON.stringify(edgeCategories)) {
  throw new Error('Citizen category allowlist differs between the browser and Edge Function.');
}

for (const category of htmlCategories) {
  const browserTitles = context.htmlTitles[category];
  const serverTitles = [...context.edgeTitles[category]];
  if (JSON.stringify(browserTitles) !== JSON.stringify(serverTitles)) {
    throw new Error(`Citizen title allowlist differs for category: ${category}`);
  }
}

const browserMunicipalities = [...unitSelect[1].matchAll(/<option(?:\s+value="")?>([^<]+)<\/option>/g)]
  .map((match) => match[1].trim())
  .filter((value) => !value.startsWith('—'));
if (JSON.stringify(browserMunicipalities) !== JSON.stringify(context.edgeMunicipalities)) {
  throw new Error('Citizen municipality allowlist differs between the browser and Edge Function.');
}

console.log(`CITIZEN_CLASSIFICATION_PARITY_PASS categories=${htmlCategories.length} municipalities=${browserMunicipalities.length}`);
