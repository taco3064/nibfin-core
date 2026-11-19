import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const word = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
  ? value : 'unavailable';

export function actionsSummary(output) {
  let result;
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.status === 'string') result = value;
    } catch { /* Other existing Core log lines are not result records. */ }
  }
  if (!result) return '## Nibfin task\n\nNo final Core result was returned.\n';
  const progress = Array.isArray(result.stageProgress) ? result.stageProgress : [];
  const lines = ['## Nibfin task', '', '| Stage reached | Result |', '| --- | --- |'];
  for (const entry of progress) {
    lines.push(`| ${word(entry.stage)} | ${word(entry.status)}` +
      `${entry.code ? ` (${word(entry.code)})` : ''} |`);
  }
  const terminal = result.terminalStage ?? result.stage;
  lines.push('', `Final result: **${word(result.status)}**` +
    `${terminal ? ` at **${word(terminal)}**` : ''}.`);
  if (result.code) lines.push('', `Reason: \`${word(result.code)}\`.`);
  const closed = terminal === 'close' && result.status === 'completed';
  lines.push('', closed ? 'Next: none; Core completed closure.' :
    'Next: use normal Core continuation for unfinished work; ' +
    'this summary grants no work.');
  return lines.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, summary] = process.argv.slice(2);
  const text = actionsSummary(await readFile(input, 'utf8'));
  console.log('::group::Nibfin task result');
  console.log(text);
  console.log('::endgroup::');
  await appendFile(summary, text);
}
