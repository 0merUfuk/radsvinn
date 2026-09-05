// slice-map.mjs — debug CLI for computeSlice().
//
// Usage:
//   node slice-map.mjs --ask fixtures/asks/sample-01.md
//   node slice-map.mjs --text "batch endpoint on api-service + queue UI on web-app"
//
// Prints the coupling-map slice (YAML) that the harness injects into the
// decomposer/groomer prompts for the given ask. Handy for eyeballing whether the
// keyword match pulled in the right tables/services/zones.

import path from 'node:path';
import { loadConfig, loadYaml, parseAsk, computeSlice, matchAsk, parseArgs, RADSVINN_ROOT } from './lib.mjs';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const couplingMap = loadYaml(cfg.absPaths.coupling_map);

  let askText;
  if (args.text) {
    askText = String(args.text);
  } else if (args.ask) {
    const askPath = path.isAbsolute(args.ask) ? args.ask : path.resolve(RADSVINN_ROOT, args.ask);
    askText = parseAsk(askPath).body;
  } else {
    console.error('usage: node slice-map.mjs (--ask <file> | --text "<ask>")');
    process.exit(2);
  }

  const matched = matchAsk(askText);
  process.stderr.write(`# matched repos: [${matched.repos.join(', ')}]  zones: [${matched.zones.join(', ')}]\n`);
  process.stdout.write(computeSlice(askText, couplingMap));
}

main();
