import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const srcFile = path.resolve('..', 'FreeLLMAPI', 'server', 'src', 'lib', 'fallback-loop.ts');
let content = fs.readFileSync(srcFile, 'utf8');

// 1. Add fs import and getSmartFallbackConfig helper near top
const helperCode = `
import fs from 'node:fs';

let cachedSmartConfig = null;
let lastSmartConfigRead = 0;
function getSmartFallbackConfig() {
  const now = Date.now();
  if (cachedSmartConfig && (now - lastSmartConfigRead < 2000)) return cachedSmartConfig;
  const configPath = process.env.FALLBACK_CONFIG_PATH || '/config/fallback-config.json';
  try {
    if (fs.existsSync(configPath)) {
      cachedSmartConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      lastSmartConfigRead = now;
      return cachedSmartConfig;
    }
  } catch {}
  return {
    waitAndRetryRpm: true,
    maxWaitSeconds: 15,
    jitterMs: 250,
    rotateOnlyOnDailyQuota: true,
    preFlightTpmCheck: true,
    strictSingleProvider: true,
  };
}
`;

content = helperCode + '\n' + content;

// 2. Inject initialPlatform tracking for strictSingleProvider
content = content.replace(
  '  let lastError: any = null;',
  '  let lastError: any = null;\n  let initialPlatform: string | undefined;'
);

content = content.replace(
  '    route = hooks.route(attempt);',
  `    route = hooks.route(attempt);
    if (attempt === 0) {
      initialPlatform = route.platform;
    } else {
      const smartCfg = getSmartFallbackConfig();
      if (smartCfg.strictSingleProvider && initialPlatform && route.platform !== initialPlatform) {
        console.warn(\`[SmartFallback] Strict Single-Provider: bloccato cambio provider da \${initialPlatform} a \${route.platform}\`);
        const exhaustion = exhaustedRetryError(lastError, maxRetries, { attempts });
        hooks.onExhausted(exhaustion, { attempts, timedOut: false });
        return;
      }
    }`
);

// 3. Inject Pre-Flight TPM Check right before dispatch
content = content.replace(
  '    let outcome: DispatchOutcome;',
  `    // ── Smart Fallback: Pre-Flight TPM / Context Check ──
    const preFlightCfg = getSmartFallbackConfig();
    if (preFlightCfg.preFlightTpmCheck) {
      const estimatedTokens = fallbackRoutingTokens(hooks.state, 0, 0);
      if (route.tpmLimit && route.tpmLimit > 0 && estimatedTokens > route.tpmLimit) {
        console.warn(\`[SmartFallback] Pre-Flight Check: la richiesta stima circa \${estimatedTokens} token, ma il modello \${route.modelId} ha un limite di \${route.tpmLimit} TPM. Richiesta bloccata prima della chiamata.\`);
        const preFlightErr = new Error(\`Pre-Flight TPM Check: la richiesta stima circa \${estimatedTokens} token, superando il limite di \${route.tpmLimit} TPM configurato per \${route.modelId}.\`);
        preFlightErr.status = 413;
        traceAttempt('context_too_large', preFlightErr);
        hooks.onFatal(route, preFlightErr, attempt);
        return;
      }
    }

    let outcome: DispatchOutcome;`
);

// 4. Inject In-Place Wait & Retry (429 RPM/TPM) and Daily-Only Rotation
content = content.replace(
  '      if (isRetryableError(err)) {',
  `      if (isRetryableError(err)) {
        const smartConfig = getSmartFallbackConfig();
        const isDailyExhausted = isDailyQuotaExhaustedError(err);
        const isRateLimit = isRateLimitSignal(err);

        // 1. In-Place Wait & Retry su 429 al minuto (RPM / TPM)
        if (smartConfig.waitAndRetryRpm && isRateLimit && !isDailyExhausted) {
          const statedWaitMs = err?.retryAfterMs ?? 5000;
          const waitMs = statedWaitMs + (smartConfig.jitterMs ?? 250);
          const maxWaitMs = (smartConfig.maxWaitSeconds || 15) * 1000;

          if (waitMs <= maxWaitMs) {
            console.log(\`[SmartFallback] 429 RPM/TPM rilevato su \${route.platform}/\${route.modelId} (chiave \${route.keyId}). Pausa in-place di \${(waitMs / 1000).toFixed(1)}s sulla stessa chiave...\`);
            await new Promise(r => setTimeout(r, waitMs));
            const errorClass = classifyAttemptError(err);
            attempts.push({ platform: route.platform, modelId: route.modelId, keyOrdinal: keyOrdinal(route), errorClass });
            traceAttempt(errorClass, err);
            lastError = err;
            // Riprova sulla stessa chiave senza ruotare
            continue;
          } else {
            console.warn(\`[SmartFallback] 429 RPM/TPM su \${route.platform}/\${route.modelId}: attesa (\${(waitMs / 1000).toFixed(1)}s) supera maxWaitSeconds (\${smartConfig.maxWaitSeconds}s).\`);
            if (smartConfig.rotateOnlyOnDailyQuota) {
              console.warn(\`[SmartFallback] Policy Anti-Burning attiva: rotazione chiavi bloccata su 429 del minuto. Termino la richiesta.\`);
              const exhaustion = exhaustedRetryError(err, maxRetries, { attempts });
              hooks.onExhausted(exhaustion, { attempts, timedOut: false });
              traceAttempt('rate_limit', err);
              return;
            }
          }
        }

        // 2. Rotazione chiavi SOLO su Quota Giornaliera
        if (smartConfig.rotateOnlyOnDailyQuota && isRateLimit && !isDailyExhausted) {
          console.warn(\`[SmartFallback] Rotazione chiavi negata su 429 del minuto per proteggere le quote rimanenti.\`);
          const exhaustion = exhaustedRetryError(err, maxRetries, { attempts });
          hooks.onExhausted(exhaustion, { attempts, timedOut: false });
          traceAttempt('rate_limit', err);
          return;
        }`
);

// Transpile with esbuild
const result = await esbuild.transform(content, {
  loader: 'ts',
  target: 'es2022',
  format: 'esm',
});

const patchDir = path.resolve('patch');
if (!fs.existsSync(patchDir)) fs.mkdirSync(patchDir, { recursive: true });
const targetFile = path.join(patchDir, 'fallback-loop.js');
fs.writeFileSync(targetFile, result.code, 'utf8');

console.log(`[Build] patch/fallback-loop.js generato con successo (${result.code.length} bytes)!`);
