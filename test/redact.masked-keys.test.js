/* node test/redact.masked-keys.test.js — a MASKED or TRUNCATED key is still part of a key.
   Reported against 0.12.4: diag.errors.json carried part of a provider key. OpenAI's 401 body echoes the key
   with its middle starred out (`sk-proj-Ab12****Wx9Z`), and the stars broke every full-key shape, so the
   visible head and tail were persisted verbatim. This locks the masked-key rule and its prose guard. */
'use strict';
const A = require('./_assert.js');
const { redact } = require('../sidecar/context.js');

// ---- masked / truncated vendor keys are scrubbed whole ----
{
  const leaks = [
    ['OpenAI 401 (real phrasing)', 'Incorrect API key provided: sk-proj-Ab12Cd34************************Wx9Z. You can find your API key at https://platform.openai.com/account/api-keys.', ['Ab12Cd34', 'Wx9Z']],
    ['OpenAI legacy key, all-stars middle', 'Incorrect API key provided: sk-abc12***************************xyz9.', ['abc12', 'xyz9']],
    ['OpenRouter truncated with an ellipsis', 'OpenRouter 401 for key sk-or-v1-9f8e7d6c…', ['9f8e7d6c']],
    ['Anthropic truncated with three dots', 'x-api-key sk-ant-api03-QwErTy...', ['QwErTy']],
    ['bullet-masked key', 'key sk-live1234••••••abcd rejected', ['live1234', 'abcd']],
    ['Stripe masked', 'Invalid API Key provided: sk_live_****************4242', ['4242']],
    ['Groq masked', 'invalid key gsk_AbCd****EfGh', ['AbCd', 'EfGh']],
    ['Google API key masked', 'API key AIzaSyA1****zZ9 not valid', ['SyA1', 'zZ9']],
    ['GitHub token masked', 'Bad credentials for ghp_1a2b...9z8y', ['1a2b', '9z8y']],
  ];
  for (const [label, input, fragments] of leaks) {
    const out = redact(input);
    for (const f of fragments) A.ok(out.indexOf(f) < 0, label + ': fragment "' + f + '" scrubbed (got: ' + out + ')');
    A.ok(out.indexOf('[redacted-key]') >= 0, label + ': a redaction marker stands in its place');
  }
  // the surrounding sentence survives, including the full stop right after the key
  A.eq(redact('Incorrect API key provided: sk-proj-Ab12****Wx9Z. Retry.'), 'Incorrect API key provided: [redacted-key]. Retry.',
    'only the key is replaced; the sentence and its full stop stay');
}

// ---- prose with the same letters is NOT touched ----
{
  const prose = [
    'skip... then retry',
    'the risk... is real',
    'ask-me... later',
    'hf... not sure',
    'a *** bold *** word',
    'sketch-pad... done',
    'The task... finished',
  ];
  for (const p of prose) A.eq(redact(p), p, 'prose untouched: ' + JSON.stringify(p));
}

// ---- full keys still hit their vendor rules (the new rule does not shadow them) ----
{
  A.eq(redact('sk-ant-api03-AbCdEfGhIjKl'), '[redacted-key]', 'a full Anthropic key is still redacted');
  A.eq(redact('sk-proj-AbCdEfGhIjKlMnOpQr'), '[redacted-key]', 'a full OpenAI project key is still redacted');
}

A.report('redact.masked-keys.test');
